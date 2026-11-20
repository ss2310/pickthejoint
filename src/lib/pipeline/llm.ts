/**
 * The one place Claude is called from the pipeline. Every request:
 *   - names a tier (fast / mid / top), resolved to a model ID in config;
 *   - returns JSON checked against a schema (structured outputs);
 *   - goes through the budget guard with an estimated cost, which is replaced
 *     by the cost computed from the reported token usage.
 * Scheduled runs pass `batch: true` to use the Message Batches API (half price);
 * the job then waits for the batch to end.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Pool } from "pg";
import { batchDiscount, ingestion, modelPricing, models, type ModelTier, type SubBudget } from "../../config";
import { assertNotParked, guardedCall } from "../budget-guard";

export interface LlmRequest<T> {
  /** Caller's key for matching results to inputs. */
  id: string;
  tier: ModelTier;
  system: string;
  content: Anthropic.ContentBlockParam[];
  schema: z.ZodType<T>;
  maxTokens: number;
  effort: "low" | "medium" | "high";
  /** Used for the budget check before the call and for dry-run estimates. */
  estInputTokens: number;
  estOutputTokens: number;
}

export interface LlmResult<T> {
  id: string;
  ok: boolean;
  data?: T;
  /** Set when ok is false. */
  error?: string;
  model: string;
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmRunOptions {
  jobName: string;
  dryRun?: boolean;
  batch?: boolean;
  subBudget?: SubBudget;
  pool?: Pool;
}

export interface LlmClient {
  run<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]>;
}

export function tokenCostUsd(model: string, inputTokens: number, outputTokens: number, batch = false): number {
  const price =
    modelPricing[model] ??
    Object.values(modelPricing).reduce((a, b) => (b.outputPerMTok > a.outputPerMTok ? b : a));
  const usd = (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
  return batch ? usd * batchDiscount : usd;
}

export function estimateUsd<T>(req: LlmRequest<T>, batch = false): number {
  return tokenCostUsd(models[req.tier], req.estInputTokens, req.estOutputTokens, batch);
}

function toParams<T>(req: LlmRequest<T>): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: models[req.tier],
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: "user", content: req.content }],
    // The fast tier does short classification: no thinking. The mid and top
    // tiers think adaptively (they do not accept a disabled setting); effort
    // controls how much.
    ...(req.tier === "fast" ? { thinking: { type: "disabled" as const } } : {}),
    output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
  };
}

function readMessage<T>(req: LlmRequest<T>, msg: Anthropic.Message, batch: boolean): LlmResult<T> {
  const usage = msg.usage;
  const inputTokens =
    usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const base = {
    id: req.id,
    model: msg.model,
    inputTokens,
    outputTokens: usage.output_tokens,
    usd: tokenCostUsd(models[req.tier], inputTokens, usage.output_tokens, batch),
  };
  if (msg.stop_reason === "refusal") return { ...base, ok: false, error: "model declined the request" };
  if (msg.stop_reason === "max_tokens") return { ...base, ok: false, error: "response was cut off (max_tokens)" };
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return { ...base, ok: true, data: req.schema.parse(JSON.parse(text)) };
  } catch (err) {
    return { ...base, ok: false, error: `response did not match the schema: ${(err as Error).message.slice(0, 200)}` };
  }
}

function failed<T>(req: LlmRequest<T>, error: string): LlmResult<T> {
  return { id: req.id, ok: false, error, model: models[req.tier], usd: 0, inputTokens: 0, outputTokens: 0 };
}

async function mapLimit<A, B>(items: A[], limit: number, fn: (item: A) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export class AnthropicLlm implements LlmClient {
  private client: Anthropic | undefined;
  private sdk(): Anthropic {
    // Second lock behind the budget guard: nothing reaches the Claude API while parked.
    assertNotParked("Claude API call");
    return (this.client ??= new Anthropic());
  }

  async run<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    if (requests.length === 0) return [];
    if (opts.dryRun) {
      // One dry-run cost_log row per model; nothing is sent.
      for (const tier of new Set(requests.map((r) => r.tier))) {
        const group = requests.filter((r) => r.tier === tier);
        await guardedCall(
          {
            bucket: "model", subBudget: opts.subBudget, service: "anthropic", model: models[tier],
            units: group.length, unitLabel: "requests", jobName: opts.jobName, dryRun: true,
            estimatedUsd: group.reduce((s, r) => s + estimateUsd(r, opts.batch), 0),
          },
          async () => undefined,
          { pool: opts.pool },
        );
      }
      return [];
    }
    return opts.batch ? this.runBatch(requests, opts) : this.runSync(requests, opts);
  }

  private async runSync<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    return mapLimit(requests, 4, async (req) => {
      const res = await guardedCall<LlmResult<T>>(
        {
          bucket: "model", subBudget: opts.subBudget, service: "anthropic", model: models[req.tier],
          units: req.estInputTokens + req.estOutputTokens, unitLabel: "tokens",
          estimatedUsd: estimateUsd(req), jobName: opts.jobName,
        },
        async () => {
          try {
            const msg = await this.sdk().messages.create(toParams(req));
            const result = readMessage(req, msg, false);
            return { result, actualUsd: result.usd, units: result.inputTokens + result.outputTokens };
          } catch (err) {
            // Bad credentials or permissions will fail every request: stop the job.
            if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw err;
            if (err instanceof Anthropic.APIError) {
              // Rejected or failed after the SDK's own retries: nothing was billed.
              return { result: failed(req, `API error ${err.status ?? ""}: ${err.message}`.slice(0, 300)), actualUsd: 0 };
            }
            throw err;
          }
        },
        { pool: opts.pool },
      );
      return res as LlmResult<T>;
    });
  }

  private async runBatch<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    const byId = new Map(requests.map((r, i) => [`r${i}`, r]));
    const estimate = requests.reduce((s, r) => s + estimateUsd(r, true), 0);
    const res = await guardedCall<LlmResult<T>[]>(
      {
        bucket: "model", subBudget: opts.subBudget, service: "anthropic",
        model: [...new Set(requests.map((r) => models[r.tier]))].join("+") + " (batch)",
        units: requests.length, unitLabel: "requests", estimatedUsd: estimate, jobName: opts.jobName,
      },
      async () => {
        const client = this.sdk();
        const created = await client.messages.batches.create({
          requests: [...byId].map(([custom_id, r]) => ({ custom_id, params: toParams(r) })),
        });
        console.log(`[llm] batch ${created.id} submitted with ${requests.length} request(s)`);
        const deadline = Date.now() + ingestion.batchMaxWaitMinutes * 60_000;
        for (;;) {
          const b = await client.messages.batches.retrieve(created.id);
          if (b.processing_status === "ended") break;
          if (Date.now() > deadline) {
            throw new Error(`Batch ${created.id} did not finish in ${ingestion.batchMaxWaitMinutes} minutes`);
          }
          await new Promise((r) => setTimeout(r, 30_000));
        }
        const out = new Map<string, LlmResult<T>>();
        for await (const item of await client.messages.batches.results(created.id)) {
          const req = byId.get(item.custom_id);
          if (!req) continue;
          out.set(
            item.custom_id,
            item.result.type === "succeeded"
              ? readMessage(req, item.result.message, true)
              : failed(req, `batch request ${item.result.type}`),
          );
        }
        const results = [...byId].map(([cid, r]) => out.get(cid) ?? failed(r, "missing from batch results"));
        return {
          result: results,
          actualUsd: results.reduce((s, r) => s + r.usd, 0),
          units: results.length,
        };
      },
      { pool: opts.pool },
    );
    return res as LlmResult<T>[];
  }
}
