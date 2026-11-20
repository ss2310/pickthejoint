/**
 * Minimal Apify REST client (API v2): start an actor run, wait for it, read
 * its dataset. Callers wrap `runActor` in the budget guard.
 */
import { assertNotParked } from "../budget-guard";

export interface ActorRunOptions {
  /** Upper bound on what the run may charge, in USD. Sent to Apify as a hard cap. */
  maxChargeUsd: number;
  /** Cap on charged dataset items (pay-per-result actors). */
  maxItems?: number;
  /** Give up waiting after this many seconds. */
  timeoutSecs?: number;
}

export interface ActorRunResult {
  runId: string;
  status: string;
  items: Record<string, unknown>[];
}

export interface ApifyClient {
  runActor(actorId: string, input: unknown, opts: ActorRunOptions): Promise<ActorRunResult>;
}

const BASE = "https://api.apify.com/v2";
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);

export class ApifyError extends Error {}

export class HttpApifyClient implements ApifyClient {
  constructor(private readonly token = process.env.APIFY_TOKEN ?? "") {}

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    assertNotParked("Apify call");
    if (!this.token) throw new ApifyError("APIFY_TOKEN is not set");
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...init?.headers },
    });
    if (!res.ok) {
      throw new ApifyError(`Apify ${init?.method ?? "GET"} ${path.split("?")[0]} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  }

  async runActor(actorId: string, input: unknown, opts: ActorRunOptions): Promise<ActorRunResult> {
    if (!actorId) throw new ApifyError("Apify actor ID is not configured");
    const id = encodeURIComponent(actorId.replace("/", "~"));
    const timeoutSecs = opts.timeoutSecs ?? 600;
    const q = new URLSearchParams({
      waitForFinish: "60",
      timeout: String(timeoutSecs),
      // Apify rejects a cap below the actor's minimum charge; half a cent clears every actor we use.
      maxTotalChargeUsd: Math.max(opts.maxChargeUsd, 0.005).toFixed(4),
    });
    if (opts.maxItems) q.set("maxItems", String(opts.maxItems));

    type Run = { data: { id: string; status: string; defaultDatasetId: string } };
    let run = (await this.call(`/acts/${id}/runs?${q}`, { method: "POST", body: JSON.stringify(input) })) as Run;
    const deadline = Date.now() + (timeoutSecs + 60) * 1000;
    while (!TERMINAL.has(run.data.status)) {
      if (Date.now() > deadline) throw new ApifyError(`Apify run ${run.data.id} did not finish in time`);
      run = (await this.call(`/actor-runs/${run.data.id}?waitForFinish=60`)) as Run;
    }
    if (run.data.status !== "SUCCEEDED") {
      throw new ApifyError(`Apify run ${run.data.id} ended with status ${run.data.status}`);
    }
    const items = (await this.call(`/datasets/${run.data.defaultDatasetId}/items?clean=true&format=json`)) as Record<string, unknown>[];
    return { runId: run.data.id, status: run.data.status, items };
  }
}
