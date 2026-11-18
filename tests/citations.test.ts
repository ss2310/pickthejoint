import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SITE_URL = "https://pickthejoint.com";
});

import { freshDb } from "./helpers";
import { seedDemo } from "./fixtures";
import { citationQuestions, seed } from "../db/seed";
import {
  ImportError, activeQuestions, citationBudget, hostOf, importFirstPartyCsv, importRun, judge, parseCsv, saveManualResult, snapshotWeek,
  weekResults, weekStart, weeklyFigures, type RunFile,
} from "../src/lib/citations";
import { closePool } from "../src/lib/db";
import { housekeeping } from "../src/lib/pipeline/housekeeping";
import { sitemapEntries } from "../src/lib/sitemap";

let pool: Pool;
const NOW = new Date();

beforeAll(async () => {
  pool = await freshDb();
  await seed(pool);
  await seedDemo(pool, NOW);
});
afterAll(async () => { await closePool(); await pool.end(); });
beforeEach(async () => {
  await pool.query("TRUNCATE citation_results, citation_runs, first_party_stats, weekly_snapshots, cost_log, crawler_log RESTART IDENTITY");
});

const Q = citationQuestions().indore;

function runFile(over: Partial<RunFile> = {}, askedAt = "2026-11-18T06:00:00Z"): RunFile {
  const cells: RunFile["cells"] = [
    { locale: "en", query: Q.en[0], engine: "ChatGPT", model: "dataforseo:chat_gpt:gpt-4o-mini", answered: true, error: null,
      text: "Try District and Pick the Joint for listings.", citations: ["https://www.district.in/events/indore", "https://pickthejoint.com/indore/this-weekend"],
      cost_usd: 0.035 },
    { locale: "en", query: Q.en[0], engine: "Gemini", model: "google/gemini-2.5-flash:online", answered: true, error: null,
      text: "Check BookMyShow.", citations: ["https://in.bookmyshow.com/explore/events-indore", "https://example.com/blog"], cost_usd: 0.01 },
    { locale: "en", query: Q.en[0], engine: "Google AI Overviews", model: "google-search:ai_overview", answered: false,
      error: "Google showed no AI Overview for this search", text: "", citations: [], cost_usd: 0.004 },
    { locale: "hi", query: Q.hi[0], engine: "Perplexity", model: "dataforseo:perplexity:sonar", answered: true, error: null,
      text: "इस वीकेंड के इवेंट pickthejoint.com पर देखें।", citations: [], cost_usd: 0.01 },
    { locale: "en", query: "A question nobody approved", engine: "ChatGPT", model: "x", answered: true, text: "", citations: [], cost_usd: 0 },
  ];
  return { format: "ptj-citations/1", run_id: "geogrid-indore-20261118-060000", tool: "geogrid test", city: "indore", asked_at: askedAt,
    engines: {}, cost_usd: 0.059, stopped: null, cells, ...over };
}

describe("reading an answer", () => {
  it("counts our pages among the sources as a citation, and our name as a mention", () => {
    const j = judge("See Pick the Joint.", ["https://www.district.in/x", "https://pickthejoint.com/indore", "https://in.bookmyshow.com/y", "nonsense"]);
    expect(j).toMatchObject({ cited: true, mentioned: true, ourUrls: ["https://pickthejoint.com/indore"], competitors: ["district.in", "bookmyshow.com"] });
    expect(j.hosts).toEqual(["district.in", "pickthejoint.com", "in.bookmyshow.com"]);
  });
  it("counts a link written into the answer, but not a look-alike domain", () => {
    expect(judge("Listings at https://pickthejoint.com/indore/today.", []).cited).toBe(true);
    expect(judge("see notpickthejoint.com or pickthejoint.com.evil.example", ["https://notpickthejoint.com/a"]).cited).toBe(false);
    expect(judge("नाम: पिक द जॉइंट", []).mentioned).toBe(true);
    expect(hostOf("https://WWW.District.in/a")).toBe("district.in");
  });
  it("puts weeks on Mondays, India time", () => {
    expect(weekStart(new Date("2026-11-18T06:00:00Z"))).toBe("2026-11-16"); // Wednesday
    expect(weekStart(new Date("2026-11-22T19:00:00Z"))).toBe("2026-11-23"); // Monday 00:30 IST
    expect(weekStart(new Date("2026-11-22T18:00:00Z"))).toBe("2026-11-22".replace("22", "16")); // still Sunday in IST
  });
});

describe("the approved questions", () => {
  it("are seeded from the data file, 15 in each language, and stay put when seeded again", async () => {
    const qs = await activeQuestions(pool, "indore");
    expect(qs.filter((q) => q.locale === "en")).toHaveLength(15);
    expect(qs.filter((q) => q.locale === "hi")).toHaveLength(15);
    expect(qs[0]).toMatchObject({ locale: "en", position: 1, query: "What's happening in Indore this weekend?" });
    const ids = qs.map((q) => q.id);
    await seed(pool);
    expect((await activeQuestions(pool, "indore")).map((q) => q.id)).toEqual(ids);
  });
});

describe("importing a GeoGrid run", () => {
  it("stores one row per question and engine, judges each answer and logs the cost once", async () => {
    const r = await importRun(runFile(), pool);
    expect(r).toMatchObject({ weekStart: "2026-11-16", imported: 4, answered: 3, cited: 2, mentioned: 2, costUsd: 0.059 });
    expect(r.skipped).toEqual(["ChatGPT: A question nobody approved"]);
    const rows = await weekResults("2026-11-16", pool);
    const chatgpt = rows.find((x) => x.engine === "chatgpt")!;
    expect(chatgpt).toMatchObject({ cited: true, mentioned_by_name: true, competitors_cited: ["district.in"], method: "automated", our_urls: ["https://pickthejoint.com/indore/this-weekend"] });
    expect(rows.find((x) => x.engine === "gemini")).toMatchObject({ cited: false, competitors_cited: ["bookmyshow.com"] });
    expect(rows.find((x) => x.engine === "google_aio")).toMatchObject({ answered: false, cited: false, note: "Google showed no AI Overview for this search" });
    expect(rows.find((x) => x.engine === "perplexity")).toMatchObject({ cited: true, locale: "hi" }); // the bare domain in the text

    const cost = (await pool.query("SELECT service, model, sub_budget, bucket, units::int AS units, estimated_usd::float AS usd, job_name FROM cost_log ORDER BY model")).rows;
    expect(cost).toHaveLength(4);
    expect(cost.find((c) => c.model === "dataforseo:chat_gpt:gpt-4o-mini")).toMatchObject({ service: "dataforseo", bucket: "scrape", sub_budget: "citations", units: 1, usd: 0.035, job_name: "citations" });
    expect(cost.find((c) => c.model === "google/gemini-2.5-flash:online")).toMatchObject({ service: "openrouter" });
    expect((await citationBudget(pool)).spent).toBeCloseTo(0.059);

    // The same file again is refused, and nothing is logged twice.
    await expect(importRun(runFile(), pool)).rejects.toBeInstanceOf(ImportError);
    expect((await pool.query("SELECT count(*)::int AS n FROM cost_log")).rows[0].n).toBe(4);
  });

  it("a later run in the same week replaces that week's answers", async () => {
    await importRun(runFile(), pool);
    const second = runFile({ run_id: "geogrid-indore-20261119-060000" }, "2026-11-19T06:00:00Z");
    second.cells[1] = { ...second.cells[1], citations: ["https://pickthejoint.com/indore"], cost_usd: 0 };
    await importRun(second, pool);
    const rows = await weekResults("2026-11-16", pool);
    expect(rows).toHaveLength(4);
    expect(rows.find((x) => x.engine === "gemini")).toMatchObject({ cited: true });
  });

  it("refuses files that are not results, or that match nothing", async () => {
    await expect(importRun({ hello: 1 }, pool)).rejects.toThrow(/Not a citation results file/);
    await expect(importRun(runFile({ city: "atlantis" }), pool)).rejects.toThrow(/Unknown city/);
    await expect(importRun(runFile({ cells: [runFile().cells[4]] }), pool)).rejects.toThrow(/nothing imported/);
    expect((await pool.query("SELECT count(*)::int AS n FROM citation_runs")).rows[0].n).toBe(0);
  });
});

describe("checks by hand", () => {
  it("records an engine with no automated route, with its screenshot", async () => {
    const q = (await activeQuestions(pool, "indore"))[3];
    await saveManualResult({ queryId: q.id, engine: "copilot", weekStart: "2026-11-19", answered: true, cited: false, mentioned: true,
      competitors: "https://www.district.in/x, bookmyshow.com", screenshotUrl: "https://example.com/shot.png", note: " seen in Edge " }, pool);
    const [row] = await weekResults("2026-11-16", pool);
    expect(row).toMatchObject({ engine: "copilot", method: "manual", cited: false, mentioned_by_name: true, competitors_cited: ["district.in", "bookmyshow.com"],
      screenshot_url: "https://example.com/shot.png", note: "seen in Edge" });
    await expect(saveManualResult({ queryId: q.id, engine: "copilot", weekStart: "2026-11-19", answered: true, cited: true, mentioned: false,
      competitors: "", screenshotUrl: "javascript:alert(1)", note: "" }, pool)).rejects.toBeInstanceOf(ImportError);
    await expect(saveManualResult({ queryId: q.id, engine: "altavista", weekStart: "2026-11-19", answered: true, cited: true, mentioned: false,
      competitors: "", screenshotUrl: "", note: "" }, pool)).rejects.toBeInstanceOf(ImportError);
  });
});

describe("first-party sources", () => {
  it("reads quoted CSV", () => {
    expect(parseCsv('Date,"Top pages, all",Clicks\r\n2026-11-16,"a ""b""",3\n')).toEqual([["Date", "Top pages, all", "Clicks"], ["2026-11-16", 'a "b"', "3"]]);
  });
  it("sums a Search Console daily export into weeks", async () => {
    const csv = "Date,Clicks,Impressions,CTR,Position\n2026-11-16,2,100,2%,10.5\n2026-11-17,1,50,2%,9.5\n2026-11-23,4,80,5%,8\nTotal,,,,\n";
    const r = await importFirstPartyCsv("search_console", csv, pool);
    expect(r).toEqual({ weeks: ["2026-11-16", "2026-11-23"], rows: 3 });
    const rows = (await pool.query("SELECT week_start::text AS w, clicks, impressions, avg_position::float AS pos FROM first_party_stats ORDER BY w")).rows;
    expect(rows).toEqual([{ w: "2026-11-16", clicks: 3, impressions: 150, pos: 10 }, { w: "2026-11-23", clicks: 4, impressions: 80, pos: 8 }]);
  });
  it("reads a Bing export with day-first dates and a citations column", async () => {
    await importFirstPartyCsv("bing_ai", "Date\tCitations\tCited pages\n18/11/2026\t5\t2\n19/11/2026\t1\t1\n", pool);
    const row = (await pool.query("SELECT week_start::text AS w, citations, cited_pages FROM first_party_stats WHERE source = 'bing_ai'")).rows[0];
    expect(row).toEqual({ w: "2026-11-16", citations: 6, cited_pages: 3 });
    await expect(importFirstPartyCsv("bing_ai", "Page,Clicks\n/a,1\n", pool)).rejects.toThrow(/date column/);
  });
});

describe("weekly figures", () => {
  it("snapshots what is live, and housekeeping keeps this week's snapshot current", async () => {
    await snapshotWeek(pool, NOW);
    const snap = (await pool.query("SELECT live_events, venues, artists FROM weekly_snapshots")).rows[0];
    // The demo has 4 upcoming published events that are not cancelled (or 3 once tonight's show is over), at 3 venues with 2 artists.
    expect(snap.venues).toBe(3);
    expect(snap.artists).toBe(2);
    expect([3, 4]).toContain(snap.live_events);
    await pool.query("TRUNCATE weekly_snapshots");
    await housekeeping(pool, { now: NOW });
    expect((await pool.query("SELECT count(*)::int AS n FROM weekly_snapshots")).rows[0].n).toBe(1);
  });

  it("puts shares, crawler visits and first-party numbers side by side, week by week", async () => {
    await importRun(runFile(), pool);
    await pool.query("INSERT INTO crawler_log (agent, path, visited_at) VALUES ('GPTBot', '/indore', '2026-11-17T10:00:00Z'), ('ClaudeBot', '/indore', '2026-11-18T10:00:00Z'), ('GPTBot', '/', '2026-11-01T10:00:00Z')");
    await importFirstPartyCsv("bing_ai", "Date,Citations\n2026-11-17,7\n", pool);
    const weeks = await weeklyFigures(pool);
    const w = weeks.find((x) => x.weekStart === "2026-11-16")!;
    expect(w.all).toEqual({ checks: 4, answered: 3, cited: 2, mentioned: 2 }); // writing our domain names us too
    expect(w.engines.find((e) => e.engine === "google_aio")).toMatchObject({ checks: 1, answered: 0, cited: 0 });
    expect(w.crawlerVisits).toBe(2);
    expect(w.crawlerByVendor).toEqual({ GPTBot: 1, ClaudeBot: 1 });
    expect(w.bing).toEqual({ citations: 7, cited_pages: null });
    // Crawler weeks before the first measured week are not listed.
    expect(weeks.some((x) => x.weekStart === "2026-10-26")).toBe(false);
  });

  it("lists the public page in the sitemap in both languages", async () => {
    const pages = await sitemapEntries("pages");
    expect(pages.find((p) => p.path === "/ai-citations")).toMatchObject({ path: "/ai-citations" });
    expect(pages.find((p) => p.path === "/ai-citations")?.oneLanguage).toBeUndefined();
  });
});
