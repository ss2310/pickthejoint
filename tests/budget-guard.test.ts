import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { freshDb } from "./helpers";
import { BudgetExceededError, guardedCall, monthSpend } from "../src/lib/budget-guard";

let pool: Pool;
beforeAll(async () => { pool = await freshDb(); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await pool.query("TRUNCATE cost_log"); });

const base = { service: "apify", model: "actor/x", jobName: "test" } as const;

describe("budget guard", () => {
  it("logs the cost of an allowed call and returns its result", async () => {
    const res = await guardedCall({ ...base, bucket: "scrape", estimatedUsd: 1.5 }, async () => "ok",
      { pool, caps: { scrape: 10 } });
    expect(res).toBe("ok");
    expect(await monthSpend("scrape", { pool })).toBeCloseTo(1.5);
  });

  it("blocks the call before running it once the cap is reached", async () => {
    const caps = { scrape: 2 };
    await guardedCall({ ...base, bucket: "scrape", estimatedUsd: 2 }, async () => 1, { pool, caps });
    const fn = vi.fn(async () => 1);
    await expect(guardedCall({ ...base, bucket: "scrape", estimatedUsd: 0.01 }, fn, { pool, caps }))
      .rejects.toBeInstanceOf(BudgetExceededError);
    expect(fn).not.toHaveBeenCalled();
    expect(await monthSpend("scrape", { pool })).toBeCloseTo(2); // blocked call not logged
  });

  it("blocks a call whose estimate would push spend over the cap", async () => {
    const fn = vi.fn(async () => 1);
    await guardedCall({ ...base, bucket: "model", estimatedUsd: 9 }, async () => 1, { pool, caps: { model: 10 } });
    await expect(guardedCall({ ...base, bucket: "model", estimatedUsd: 2 }, fn, { pool, caps: { model: 10 } }))
      .rejects.toThrow(/Budget "model" blocked/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("keeps the two caps independent", async () => {
    await guardedCall({ ...base, bucket: "scrape", estimatedUsd: 5 }, async () => 1, { pool, caps: { scrape: 5, model: 5 } });
    await expect(guardedCall({ ...base, bucket: "model", estimatedUsd: 1 }, async () => "m",
      { pool, caps: { scrape: 5, model: 5 } })).resolves.toBe("m");
  });

  it("enforces a sub-budget inside its parent bucket", async () => {
    const caps = { scrape: 50, reelTranscript: 0.5 };
    await guardedCall({ ...base, bucket: "scrape", subBudget: "reelTranscript", estimatedUsd: 0.5 }, async () => 1, { pool, caps });
    await expect(guardedCall({ ...base, bucket: "scrape", subBudget: "reelTranscript", estimatedUsd: 0.1 },
      async () => 1, { pool, caps })).rejects.toThrow(/reelTranscript/);
    // normal scraping still allowed
    await expect(guardedCall({ ...base, bucket: "scrape", estimatedUsd: 1 }, async () => "s", { pool, caps })).resolves.toBe("s");
  });

  it("warns at 80% of the cap", async () => {
    const warn = vi.fn();
    await guardedCall({ ...base, bucket: "scrape", estimatedUsd: 7 }, async () => 1, { pool, caps: { scrape: 10 }, warn });
    expect(warn).not.toHaveBeenCalled();
    await guardedCall({ ...base, bucket: "scrape", estimatedUsd: 1 }, async () => 1, { pool, caps: { scrape: 10 }, warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("80%"));
  });

  it("replaces the estimate with the actual cost when the call reports one", async () => {
    await guardedCall({ ...base, bucket: "model", estimatedUsd: 1 }, async () => ({ result: "x", actualUsd: 0.25, units: 1200 }),
      { pool, caps: { model: 10 } });
    expect(await monthSpend("model", { pool })).toBeCloseTo(0.25);
  });

  it("dry run skips the call and does not count toward the cap", async () => {
    const fn = vi.fn(async () => 1);
    await guardedCall({ ...base, bucket: "scrape", estimatedUsd: 100, dryRun: true }, fn, { pool, caps: { scrape: 1 } });
    expect(fn).not.toHaveBeenCalled();
    expect(await monthSpend("scrape", { pool })).toBe(0);
    const { rows } = await pool.query("SELECT dry_run FROM cost_log");
    expect(rows).toEqual([{ dry_run: true }]);
  });

  it("only counts the current month", async () => {
    await pool.query(`INSERT INTO cost_log (logged_at, bucket, service, estimated_usd, job_name)
      VALUES (now() - interval '40 days', 'scrape', 'apify', 100, 'old')`);
    await expect(guardedCall({ ...base, bucket: "scrape", estimatedUsd: 1 }, async () => "ok", { pool, caps: { scrape: 5 } }))
      .resolves.toBe("ok");
  });

  it("does not let concurrent calls overshoot the cap", async () => {
    const caps = { scrape: 3 };
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => guardedCall({ ...base, bucket: "scrape", estimatedUsd: 1 }, async () => 1, { pool, caps })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await monthSpend("scrape", { pool })).toBeCloseTo(3);
  });
});
