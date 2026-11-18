/**
 * Web research for entity enrichment: one Claude request (mid tier) that may
 * use Anthropic's web search and web fetch tools, both of which run on
 * Anthropic's servers. It returns the model's notes and, separately, the list
 * of pages the tools actually returned. Facts are later accepted only when
 * their source is on that list, so a made-up address cannot pass as a source.
 *
 * The call goes through the budget guard under the "enrichment" sub-budget.
 * Its cost is tokens at the model's rate plus a fee per search.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import { enrichment, models } from "../../config";
import { guardedCall } from "../budget-guard";
import { tokenCostUsd } from "./llm";

export interface RetrievedPage { url: string; title: string | null }

export interface ResearchRequest {
  id: string;
  system: string;
  prompt: string;
  /** Biases search results towards the entity's city. */
  city?: string;
  region?: string;
}

export interface ResearchResult {
  id: string;
  ok: boolean;
  error?: string;
  notes: string;
  /** Every page a search or fetch returned during the request. */
  retrieved: RetrievedPage[];
  searches: number;
  fetches: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface ResearchOptions { jobName: string; dryRun?: boolean; pool?: Pool }

export interface ResearchClient {
  research(req: ResearchRequest, opts: ResearchOptions): Promise<ResearchResult | undefined>;
}

/** Same page, compared loosely: scheme, "www.", trailing slash, fragment and tracking parameters are ignored. */
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw.trim());
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|igsh|igshid|si$|ref$|feature$)/i.test(k)) u.searchParams.delete(k);
    }
    const query = u.searchParams.toString();
    return `${u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "")}${u.pathname.replace(/\/+$/, "")}${query ? `?${query}` : ""}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function hostOf(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase().replace(/^(www|m|mobile)\./, ""); } catch { return ""; }
}

/**
 * Collects page addresses from tool result blocks. The blocks are walked
 * generically (any object carrying an http `url`), so a change in how a tool
 * version nests its results does not silently empty the list. Text the model
 * wrote is not walked: only what the tools returned counts.
 */
export function collectRetrieved(content: unknown[], into: Map<string, RetrievedPage>): void {
  const walk = (node: unknown, depth: number) => {
    if (depth > 8 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
    const obj = node as Record<string, unknown>;
    if (typeof obj.url === "string" && /^https?:\/\//i.test(obj.url)) {
      const key = urlKey(obj.url);
      const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim().slice(0, 200) : null;
      const nested = (obj.content as { title?: unknown } | undefined)?.title;
      const prev = into.get(key);
      if (!prev || (!prev.title && (title || typeof nested === "string"))) {
        into.set(key, { url: obj.url, title: title ?? (typeof nested === "string" ? nested.slice(0, 200) : null) ?? prev?.title ?? null });
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      // Skip page bodies and encrypted payloads: large, and links inside a page were not themselves retrieved.
      if (k === "data" || k === "encrypted_content" || k === "source" || k === "text") continue;
      walk(v, depth + 1);
    }
  };
  for (const block of content) {
    const type = (block as { type?: string })?.type ?? "";
    if (type.endsWith("_tool_result")) walk(block, 0);
  }
}

const MAX_TURNS = 4;

/**
 * The notes are what the model wrote after its last tool call. Text between
 * tool calls is working chatter ("let me check their website") and is dropped.
 */
export function finalNotes(content: { type: string; text?: string }[]): string {
  let start = 0;
  content.forEach((b, i) => { if (b.type !== "text" && b.type !== "thinking" && b.type !== "redacted_thinking") start = i + 1; });
  return content.slice(start).flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("").trim();
}

export class AnthropicResearch implements ResearchClient {
  private client: Anthropic | undefined;
  private sdk(): Anthropic {
    return (this.client ??= new Anthropic());
  }

  async research(req: ResearchRequest, opts: ResearchOptions): Promise<ResearchResult | undefined> {
    const model = models.mid;
    return guardedCall<ResearchResult>(
      {
        bucket: "model", subBudget: "enrichment", service: "anthropic", model: `${model} (web search)`,
        units: 0, unitLabel: "tokens", estimatedUsd: enrichment.estResearchUsd, jobName: opts.jobName, dryRun: opts.dryRun,
      },
      async () => {
        const out: ResearchResult = { id: req.id, ok: false, notes: "", retrieved: [], searches: 0, fetches: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
        const pages = new Map<string, RetrievedPage>();
        // A paused turn is continued by the next response, so the blocks of every response belong to one answer.
        const blocks: Anthropic.ContentBlock[] = [];
        const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.prompt }];
        const cost = () => tokenCostUsd(model, out.inputTokens, out.outputTokens) + out.searches * enrichment.usdPerSearch;
        try {
          for (let turn = 0; turn < MAX_TURNS; turn++) {
            const msg = await this.sdk().messages.create({
              model,
              max_tokens: 6000,
              system: req.system,
              messages,
              output_config: { effort: "medium" },
              tools: [
                {
                  type: "web_search_20260209", name: "web_search", max_uses: enrichment.maxSearches,
                  user_location: req.city ? { type: "approximate", city: req.city, region: req.region, country: "IN", timezone: "Asia/Kolkata" } : undefined,
                },
                { type: "web_fetch_20260209", name: "web_fetch", max_uses: enrichment.maxFetches, max_content_tokens: enrichment.maxFetchTokens },
              ],
            });
            const u = msg.usage;
            out.inputTokens += u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
            out.outputTokens += u.output_tokens;
            out.searches += u.server_tool_use?.web_search_requests ?? 0;
            out.fetches += u.server_tool_use?.web_fetch_requests ?? 0;
            collectRetrieved(msg.content, pages);
            blocks.push(...msg.content);
            out.notes = finalNotes(blocks);
            if (msg.stop_reason === "pause_turn") {
              // A long server-tool turn: send it back as it is and the server carries on.
              messages.push({ role: "assistant", content: msg.content });
              continue;
            }
            if (msg.stop_reason === "refusal") out.error = "model declined the request";
            else if (msg.stop_reason === "max_tokens") out.error = "research notes were cut off (max_tokens)";
            else if (!out.notes) out.error = "research returned no notes";
            else out.ok = true;
            break;
          }
          if (!out.ok && !out.error) out.error = `research did not finish in ${MAX_TURNS} turns`;
        } catch (err) {
          if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw err;
          if (!(err instanceof Anthropic.APIError)) throw err;
          out.error = `API error ${err.status ?? ""}: ${err.message}`.slice(0, 300);
        }
        out.retrieved = [...pages.values()];
        out.usd = cost();
        return { result: out, actualUsd: out.usd, units: out.inputTokens + out.outputTokens };
      },
      { pool: opts.pool },
    );
  }
}
