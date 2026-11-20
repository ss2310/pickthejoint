import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SITE_URL = "https://pickthejoint.com";
});

import { NextRequest, type NextFetchEvent } from "next/server";
import { freshDb } from "./helpers";
import { seedDemo } from "./fixtures";
import { seed } from "../db/seed";
import { budgets, parking } from "../src/config";
import { closePool } from "../src/lib/db";
import { BudgetExceededError, guardedCall, monthSpend } from "../src/lib/budget-guard";
import { goesStale } from "../src/lib/parking";
import { AnthropicLlm } from "../src/lib/pipeline/llm";
import { AnthropicResearch } from "../src/lib/pipeline/research";
import { parkedSkip } from "../src/lib/pipeline/job";
import { sitemapEntries } from "../src/lib/sitemap";
import { middleware } from "../src/middleware";

let pool: Pool;
const NOW = new Date();

beforeAll(async () => {
  pool = await freshDb();
  await seed(pool);
  await seedDemo(pool, NOW);
});
afterAll(async () => { await closePool(); await pool.end(); });
beforeEach(async () => {
  process.env.PARKED = "true";
  await pool.query("TRUNCATE cost_log");
});
afterEach(() => {
  delete process.env.PARKED;
  vi.restoreAllMocks();
});

describe("parked: paid calls", () => {
  it("reads both budget caps as 0 while parked, and the normal caps once the flag is removed", () => {
    expect(parking.on).toBe(true);
    expect(budgets.scrape).toBe(0);
    expect(budgets.model).toBe(0);
    delete process.env.PARKED;
    expect(parking.on).toBe(false);
    expect(budgets.scrape).toBeGreaterThan(0);
    expect(budgets.model).toBeGreaterThan(0);
  });

  it("refuses a real Claude API call before anything is sent or logged", async () => {
    process.env.ANTHROPIC_API_KEY ??= "test-key-not-used";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const llm = new AnthropicLlm();
    const call = llm.run([{
      id: "1", tier: "mid", system: "Say hi.", content: [{ type: "text", text: "hi" }],
      schema: z.object({ reply: z.string() }), maxTokens: 50, effort: "low", estInputTokens: 10, estOutputTokens: 10,
    }], { jobName: "parked-test", pool });
    await expect(call).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(call).rejects.toThrow(/Budget "model" blocked: spent \$0\.0000 of \$0\.00.*parked/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await monthSpend("model", { pool })).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM cost_log")).rows[0].n).toBe(0);
  });

  it("refuses a web search research call and a scrape call, whatever cap a caller passes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(new AnthropicResearch().research({ id: "v1", prompt: "x", system: "y" } as never, { jobName: "parked-test", pool }))
      .rejects.toBeInstanceOf(BudgetExceededError);
    const scrape = vi.fn(async () => "posts");
    await expect(guardedCall({ bucket: "scrape", subBudget: "facebookPosts", service: "apify", estimatedUsd: 0.5, jobName: "parked-test" },
      scrape, { pool, caps: { scrape: 50, facebookPosts: 10 } })).rejects.toThrow(/Budget "scrape" blocked/);
    // Even a call estimated at $0 is refused.
    await expect(guardedCall({ bucket: "model", service: "anthropic", estimatedUsd: 0, jobName: "parked-test" }, scrape, { pool }))
      .rejects.toBeInstanceOf(BudgetExceededError);
    expect(scrape).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await pool.query("SELECT count(*)::int AS n FROM cost_log")).rows[0].n).toBe(0);
  });

  it("lets the same call through again once the flag is removed", async () => {
    delete process.env.PARKED;
    const fn = vi.fn(async () => "ok");
    await expect(guardedCall({ bucket: "scrape", service: "apify", estimatedUsd: 0.1, jobName: "parked-test" }, fn, { pool })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("parked: scheduled jobs", () => {
  it("makes every job stop before it starts, and says why", () => {
    const lines: string[] = [];
    expect(parkedSkip("ingest", (l) => lines.push(l))).toBe(true);
    expect(JSON.parse(lines[0])).toEqual({ job: "ingest", skipped: expect.stringMatching(/^parked: PARKED=true/) });
    delete process.env.PARKED;
    expect(parkedSkip("ingest", (l) => lines.push(l))).toBe(false);
    expect(lines).toHaveLength(1);
  });
});

describe("parked: public pages", () => {
  it("knows which pages go stale and which stay true", () => {
    for (const p of ["/", "/hi", "/indore", "/hi/indore", "/indore/today", "/indore/this-weekend", "/indore/this-week",
      "/indore/comedy", "/indore/area/vijay-nagar", "/indore/search", "/indore/guide", "/hi/indore/guide/2026-week-47"]) {
      expect(goesStale(p), p).toBe(true);
    }
    for (const p of ["/indore/events/some-gig", "/hi/indore/venues/a-cafe", "/indore/past", "/indore/feed.ics", "/artists/dev-sharma",
      "/organisers/x", "/series/y", "/about", "/how-we-verify", "/submit", "/ai-citations", "/robots.txt", "/sitemap.xml",
      "/sitemaps/hubs.xml", "/hi/changelog"]) {
      expect(goesStale(p), p).toBe(false);
    }
  });

  const visit = (path: string) => middleware(new NextRequest(`https://pickthejoint.com${path}`), { waitUntil: () => {} } as unknown as NextFetchEvent);

  it("sends a noindex header with stale pages only, and none once the flag is removed", () => {
    expect(visit("/indore/this-weekend").headers.get("x-robots-tag")).toBe("noindex");
    expect(visit("/hi/indore").headers.get("x-robots-tag")).toBe("noindex");
    expect(visit("/indore/events/some-gig").headers.get("x-robots-tag")).toBeNull();
    expect(visit("/robots.txt").headers.get("x-robots-tag")).toBeNull();
    delete process.env.PARKED;
    expect(visit("/indore/this-weekend").headers.get("x-robots-tag")).toBeNull();
  });

  it("leaves stale pages out of the sitemap while parked, keeping the archive", async () => {
    const parked = (await sitemapEntries("hubs", NOW)).map((e) => e.path);
    expect(parked).toEqual(["/indore/past"]);
    expect((await sitemapEntries("events", NOW)).length).toBeGreaterThan(0);
    delete process.env.PARKED;
    const open = (await sitemapEntries("hubs", NOW)).map((e) => e.path);
    expect(open).toEqual(expect.arrayContaining(["/indore", "/indore/today", "/indore/past"]));
  });
});
