import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { freshDb } from "./helpers";
import { budgets } from "../src/config";
import { BudgetExceededError, ParkedError, assertNotParked, guardedCall, monthSpend } from "../src/lib/budget-guard";
import { parkedRun } from "../src/lib/pipeline/job";
import { HttpApifyClient } from "../src/lib/pipeline/apify";
import { AnthropicResearch } from "../src/lib/pipeline/research";
import { staleWhileParked } from "../src/lib/parked";

let pool: Pool;
beforeAll(async () => { pool = await freshDb(); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await pool.query("TRUNCATE cost_log"); process.env.PARKED = "true"; });
afterEach(() => { delete process.env.PARKED; });

const call = { bucket: "model", service: "anthropic", model: "claude-haiku-5-5", jobName: "test", estimatedUsd: 0.001 } as const;

describe("PARKED=true", () => {
  it("sets both budget caps to 0, and back when unset", () => {
    expect(budgets.scrape).toBe(0);
    expect(budgets.model).toBe(0);
    delete process.env.PARKED;
    expect(budgets.scrape).toBe(50);
    expect(budgets.model).toBe(60);
  });

  it("makes the budget guard refuse a paid call before it runs, even with room under a cap", async () => {
    const fn = vi.fn(async () => "sent");
    const err = await guardedCall(call, fn, { pool, caps: { model: 1000 } }).catch((e) => e);
    expect(err).toBeInstanceOf(ParkedError);
    expect(err).toBeInstanceOf(BudgetExceededError); // so jobs, search and submissions treat it as a budget stop
    expect(err.message).toMatch(/PARKED=true/);
    expect(fn).not.toHaveBeenCalled();
    expect((await pool.query("SELECT count(*)::int AS n FROM cost_log")).rows[0].n).toBe(0);
  });

  it("refuses a zero-cost call too", async () => {
    await expect(guardedCall({ ...call, bucket: "scrape", service: "apify", estimatedUsd: 0 }, async () => 1, { pool }))
      .rejects.toBeInstanceOf(ParkedError);
  });

  it("still lets a dry run log what it would have cost (nothing is sent)", async () => {
    await guardedCall({ ...call, dryRun: true }, async () => 1, { pool });
    const { rows } = await pool.query("SELECT dry_run FROM cost_log");
    expect(rows).toEqual([{ dry_run: true }]);
    expect(await monthSpend("model", { pool })).toBe(0);
  });

  it("allows paid calls again once PARKED is unset", async () => {
    delete process.env.PARKED;
    expect(await guardedCall(call, async () => "sent", { pool })).toBe("sent");
  });

  it("stops the Apify and Claude clients themselves, behind the guard", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(new HttpApifyClient("token").runActor("apify/instagram-scraper", {}, { maxChargeUsd: 1 }))
      .rejects.toBeInstanceOf(ParkedError);
    // The research client's SDK getter refuses before any request object is built.
    expect(() => (new AnthropicResearch() as unknown as { sdk(): unknown }).sdk()).toThrow(ParkedError);
    expect(() => assertNotParked("anything")).toThrow(/PARKED=true: anything blocked/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("turns a scheduled job into a no-op that proves the guard blocks", async () => {
    const report = await parkedRun("ingest");
    expect(report.parked).toBe(true);
    expect(String(report.budgetGuard)).toMatch(/^blocked: PARKED=true/);
  });
});

describe("pages that go stale while parked", () => {
  const stale = ["/", "/hi", "/indore", "/hi/indore", "/indore/today", "/indore/this-weekend", "/indore/comedy",
    "/indore/area/vijay-nagar", "/indore/search", "/indore/feed.json", "/indore/guide", "/submit", "/hi/submit"];
  const kept = ["/indore/past", "/indore/venues/ohlio", "/indore/events/some-gig-2026-12-01", "/indore/guide/2026-w47",
    "/artists/major-minor", "/hi/artists/major-minor", "/organisers/x", "/series/indore-lit-fest", "/about", "/ai-citations"];
  it.each(stale)("%s gets noindex", (p) => expect(staleWhileParked(p)).toBe(true));
  it.each(kept)("%s stays indexable", (p) => expect(staleWhileParked(p)).toBe(false));
});
