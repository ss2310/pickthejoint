import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SITE_URL = "https://pickthejoint.com";
});

import { freshDb } from "./helpers";
import { seedDemo } from "./fixtures";
import { seed } from "../db/seed";
import { search as cfg } from "../src/config";
import { searchReport } from "../src/lib/admin-data";
import { BudgetExceededError, guardedCall } from "../src/lib/budget-guard";
import { closePool } from "../src/lib/db";
import { cleanUp } from "../src/lib/pipeline/housekeeping";
import type { LlmClient, LlmRequest, LlmResult, LlmRunOptions } from "../src/lib/pipeline/llm";
import { getCity, listEvents, type City } from "../src/lib/queries";
import { messages } from "../src/lib/locale";
import {
  foldText, loadVocabulary, naturalSearch, parseByRules, resolveDates, understand, type ParsedQuery, type Vocabulary,
} from "../src/lib/search";

let pool: Pool;
let city: City;
let vocab: Vocabulary;
const NOW = new Date();

beforeAll(async () => {
  pool = await freshDb();
  await seed(pool);
  await seedDemo(pool, NOW);
  // Hindi names, as the translation job stores them.
  await pool.query(`INSERT INTO translations (entity_type, entity_id, locale, field, text, source_hash)
    SELECT 'area', id, 'hi', 'name', 'विजय नगर', md5(name) FROM areas WHERE slug = 'vijay-nagar'`);
  await pool.query(`INSERT INTO translations (entity_type, entity_id, locale, field, text, source_hash)
    SELECT 'city', id, 'hi', 'name', 'इंदौर', md5(name) FROM cities WHERE slug = 'indore'`);
  await pool.query(`INSERT INTO translations (entity_type, entity_id, locale, field, text, source_hash)
    SELECT 'event', id, 'hi', 'title', 'ओपन माइक नाइट', md5(title) FROM events WHERE title = 'Open Mic Night'`);
  city = (await getCity("indore", "en"))!;
  vocab = await loadVocabulary(pool, city);
});
afterAll(async () => { await closePool(); await pool.end(); });
beforeEach(async () => { await pool.query("TRUNCATE search_log, search_parse_cache, rate_hits, cost_log RESTART IDENTITY"); });

type Answer = Record<string, unknown>;
const blank: Answer = { when: null, weekday: null, date_from: null, date_to: null, category: null, area: null, city: null, price: null, keywords: [] };

/** Stand-in for Claude: records each request and answers with what the test gives it. */
class FakeLlm implements LlmClient {
  calls: { system: string; text: string; tier: string; subBudget?: string; job: string; blocks: number }[] = [];
  constructor(private readonly answer: (query: string) => Answer | Error | "fail") {}
  async run<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    return requests.map((req) => {
      const text = req.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      this.calls.push({ system: req.system, text, tier: req.tier, subBudget: opts.subBudget, job: opts.jobName, blocks: req.content.length });
      const a = this.answer(text);
      if (a instanceof Error) throw a;
      if (a === "fail") return { id: req.id, ok: false, error: "schema", model: "fake", usd: 0.0002, inputTokens: 900, outputTokens: 40 };
      return { id: req.id, ok: true, data: req.schema.parse({ ...blank, ...a }), model: "fake", usd: 0.00015, inputTokens: 900, outputTokens: 40 };
    });
  }
}

const rules = (q: string) => parseByRules(q, vocab);

describe("reading queries by rules", () => {
  const cases: [string, Partial<ParsedQuery>][] = [
    ["comedy show this Saturday near Vijay Nagar", { category: "comedy", when: "weekday", weekday: 6, area: "vijay-nagar", keywords: [] }],
    ["aaj Indore mein kya hai", { when: "today", city: "indore", keywords: [] }],
    ["What's on tonight?", { when: "tonight", keywords: [] }],
    ["free events this weekend", { price: "free", when: "this_weekend" }],
    ["standup comedy kal", { category: "comedy", when: "tomorrow" }],
    ["इस शनिवार संगीत", { when: "weekday", weekday: 6, category: "music" }],
    ["आज रात कॉमेडी", { when: "tonight", category: "comedy" }],
    ["विजय नगर में फ़्री इवेंट", { area: "vijay-nagar", price: "free" }],
    ["इंदौर में आज क्या है", { city: "indore", when: "today" }],
    ["agle hafte workshops", { when: "next_week", category: "workshops" }],
    ["bachon ke liye kuch", { category: "kids", keywords: [] }],
    ["jazz in vijaynagar", { area: "vijay-nagar", keywords: ["jazz"] }],
    ["events on 25 december", { when: "date", dateFrom: "12-25", dateTo: "12-25" }],
    ["25th of December", { when: "date", dateFrom: "12-25", dateTo: "12-25" }],
    ["25/12 music", { when: "date", dateFrom: "12-25", category: "music" }],
    ["december mein comedy", { when: "date", dateFrom: "12-01", dateTo: "12-31", category: "comedy" }],
    ["scheme 54", { area: "scheme-no-54" }],
    ["next friday", { when: "next_weekday", weekday: 5 }],
    ["parso bhajan", { when: "day_after_tomorrow", category: "religious-and-cultural" }],
    ["Dev Sharma", { keywords: ["dev", "sharma"] }],
  ];
  it.each(cases)("%s", (q, expected) => {
    const r = rules(q);
    expect(r.resolved).toBe(true);
    expect(r.parsed).toMatchObject(expected);
  });

  it("leaves to the model what the rules cannot read", () => {
    expect(rules("something fun to do with my parents after dinner").resolved).toBe(false);
    expect(rules("comedy or theatre tonight").resolved).toBe(false); // two categories
    expect(rules("events on the 25th").resolved).toBe(false); // a day with no month
    expect(rules("saturday this weekend").resolved).toBe(false); // two dates
  });

  it("folds the ways people type", () => {
    expect(foldText("  What’s ON, Tonight?! ")).toBe("whats on tonight");
    expect(foldText("फ़्री")).toBe(foldText("फ्री"));
  });
});

describe("the restatement", () => {
  it("says what was understood, in each language", () => {
    const en = messages("en").search, hi = messages("hi").search;
    expect(en.understood({ category: "Comedy" })).toBe("We read this as: comedy events.");
    expect(hi.understood({ category: "कॉमेडी" })).toBe("हमने इसे ऐसे समझा: कॉमेडी इवेंट।");
    expect(en.understood({ category: "College events", area: "Vijay Nagar", when: { kind: "day", from: "Saturday, 21 November 2026", to: "Saturday, 21 November 2026" } }))
      .toBe("We read this as: college events on Saturday, 21 November 2026 in Vijay Nagar.");
    expect(en.understood({ words: ["salsa", "bollywood"], anyWords: true })).toBe("We read this as: events mentioning any of “salsa” or “bollywood”.");
    expect(en.understood({})).toMatch(/^We could not pick out/);
    expect(hi.understood({})).toMatch(/^हमें तारीख़/);
  });
});

describe("dates", () => {
  const p = (x: Partial<ParsedQuery>): ParsedQuery => ({ keywords: [], ...x });
  const wed = "2026-11-18";
  it.each([
    [p({ when: "today" }), "2026-11-18", "2026-11-18"],
    [p({ when: "tonight" }), "2026-11-18", "2026-11-18"],
    [p({ when: "tomorrow" }), "2026-11-19", "2026-11-19"],
    [p({ when: "this_weekend" }), "2026-11-20", "2026-11-22"],
    [p({ when: "next_weekend" }), "2026-11-27", "2026-11-29"],
    [p({ when: "this_week" }), "2026-11-18", "2026-11-24"],
    [p({ when: "next_week" }), "2026-11-23", "2026-11-29"],
    [p({ when: "weekday", weekday: 6 }), "2026-11-21", "2026-11-21"],
    [p({ when: "weekday", weekday: 3 }), "2026-11-18", "2026-11-18"],
    [p({ when: "next_weekday", weekday: 6 }), "2026-11-28", "2026-11-28"],
    [p({ when: "this_month" }), "2026-11-18", "2026-11-30"],
    [p({ when: "next_month" }), "2026-12-01", "2026-12-31"],
    [p({ when: "date", dateFrom: "12-25" }), "2026-12-25", "2026-12-25"],
    [p({ when: "date", dateFrom: "11-01", dateTo: "11-30" }), "2026-11-18", "2026-11-30"],
    [p({ when: "date", dateFrom: "01-05" }), "2027-01-05", "2027-01-05"],
    [p({ when: "date", dateFrom: "12-28", dateTo: "01-03" }), "2026-12-28", "2027-01-03"],
    [p({ when: "date", dateFrom: "02-29" }), "2027-02-28", "2027-02-28"],
  ])("%j from Wednesday 18 Nov", (parsed, from, to) => {
    expect(resolveDates(parsed, wed)).toEqual({ from, to });
  });
  it("on a Sunday, this weekend is that day", () => {
    expect(resolveDates(p({ when: "this_weekend" }), "2026-11-22")).toEqual({ from: "2026-11-22", to: "2026-11-22" });
    expect(resolveDates(p({ when: "next_weekend" }), "2026-11-22")).toEqual({ from: "2026-11-27", to: "2026-11-29" });
  });
  it("no date words, no dates", () => expect(resolveDates(p({}), wed)).toBeNull());
});

describe("the model, the cache and the limits", () => {
  const vague = "something for my parents near vijay nagar this saturday evening, ghazal or sufi qawwali";

  it("asks the fast tier only what rules cannot read, with only the query and the valid values", async () => {
    const llm = new FakeLlm(() => ({ when: "weekday", weekday: "saturday", area: "vijay-nagar", keywords: ["Ghazal", "parents", "zakir", "saturday"] }));
    const u = await understand(pool, llm, { query: vague, vocab, who: "ip-a", allowModel: true });
    expect(u.method).toBe("model");
    expect(u.parsed).toMatchObject({ when: "weekday", weekday: 6, area: "vijay-nagar" });
    // Only words of the query survive, and none the filters already cover.
    expect(u.parsed.keywords).toEqual(["ghazal", "parents"]);
    expect(u.costUsd).toBeCloseTo(0.00015);
    expect(llm.calls).toHaveLength(1);
    const call = llm.calls[0];
    expect(call).toMatchObject({ tier: "fast", subBudget: "search", job: "search", blocks: 1, text: vague });
    expect(call.system).toContain("vijay-nagar (Vijay Nagar, विजय नगर)");
    expect(call.system).toContain("comedy (Comedy)");
    expect(call.system).not.toContain("Open Mic"); // no listings, no other data

    // The same words again, however typed: from the cache, no call.
    const again = await understand(pool, llm, { query: `  ${vague.toUpperCase()}!! `, vocab, who: "ip-a", allowModel: true });
    expect(again.method).toBe("cache");
    expect(again.parsed).toEqual(u.parsed);
    expect(llm.calls).toHaveLength(1);
  });

  it("keeps a filter the rules were sure of when the model leaves it out, and drops numbers and price words", async () => {
    // Seen live: the model dropped "Sunday" and kept "sasta 500 kam" as search words.
    const llm = new FakeLlm(() => ({ category: "music", keywords: ["ghazal", "sufi", "500", "sasta"] }));
    const u = await understand(pool, llm, { query: "something fun with my parents on Sunday evening, ghazal or sufi qawwali under 500, sasta", vocab, who: null, allowModel: true });
    expect(u.method).toBe("model");
    expect(u.parsed).toEqual({ when: "weekday", weekday: 0, category: "music", keywords: ["ghazal", "sufi"] });
    expect(rules("cheap comedy kal").parsed).toMatchObject({ category: "comedy", when: "tomorrow", keywords: [] });
  });

  it("never asks the model for what the rules read", async () => {
    const llm = new FakeLlm(() => { throw new Error("should not be called"); });
    const u = await understand(pool, llm, { query: "comedy this weekend", vocab, who: "ip-a", allowModel: true });
    expect(u).toMatchObject({ method: "rules", costUsd: 0 });
  });

  it("falls back to keywords past the per-address limit", async () => {
    const llm = new FakeLlm(() => ({ category: "music" }));
    for (let i = 0; i < cfg.limits.hour.max; i++) {
      const u = await understand(pool, llm, { query: `qawwali and ghazal evening number ${i} please`, vocab, who: "ip-b", allowModel: true });
      expect(u.method).toBe("model");
    }
    const u = await understand(pool, llm, { query: "qawwali and ghazal evening for my parents", vocab, who: "ip-b", allowModel: true });
    expect(u).toMatchObject({ method: "keyword_fallback", reason: "rate_limit", keywordMode: "any" });
    expect(u.parsed.keywords).toEqual(["qawwali", "ghazal", "parents"]);
    expect(llm.calls).toHaveLength(cfg.limits.hour.max);
    // Another address is not affected.
    expect((await understand(pool, llm, { query: "qawwali and ghazal evening for my parents", vocab, who: "ip-c", allowModel: true })).method).toBe("model");
  });

  it("falls back to keywords when a cap is reached, the model fails, or a crawler asks", async () => {
    const q = "qawwali and ghazal evening for my parents";
    const capped = new FakeLlm(() => new BudgetExceededError("search (daily)", 0.25, 0.25, 0.0002));
    expect(await understand(pool, capped, { query: q, vocab, who: "ip-d", allowModel: true })).toMatchObject({ method: "keyword_fallback", reason: "budget" });
    const broken = new FakeLlm(() => "fail");
    expect(await understand(pool, broken, { query: q, vocab, who: "ip-d", allowModel: true })).toMatchObject({ method: "keyword_fallback", reason: "error" });
    const crash = new FakeLlm(() => new Error("network down"));
    expect(await understand(pool, crash, { query: q, vocab, who: "ip-d", allowModel: true })).toMatchObject({ method: "keyword_fallback", reason: "error" });
    const unused = new FakeLlm(() => ({}));
    expect(await understand(pool, unused, { query: q, vocab, who: null, allowModel: false })).toMatchObject({ method: "keyword_fallback", reason: "crawler" });
    expect(unused.calls).toHaveLength(0);
    // Nothing failed was cached.
    expect((await pool.query("SELECT count(*)::int AS n FROM search_parse_cache")).rows[0].n).toBe(0);
  });

  it("holds search spend to a daily cap as well as the monthly one", async () => {
    const call = { bucket: "model" as const, subBudget: "search" as const, service: "anthropic", estimatedUsd: 0.008, jobName: "search" };
    const opts = { pool, dailyCaps: { search: 0.01 }, now: new Date("2026-11-18T10:00:00Z") };
    expect(await guardedCall(call, async () => 1, opts)).toBe(1);
    await expect(guardedCall(call, async () => 2, opts)).rejects.toMatchObject({ budget: "search (daily)" });
    // The next day (UTC) starts afresh; the month is still well under its cap.
    expect(await guardedCall(call, async () => 3, { ...opts, now: new Date("2026-11-19T00:30:00Z") })).toBe(3);
  });

  it("forgets cached readings after their time", async () => {
    const llm = new FakeLlm(() => ({ category: "music" }));
    await understand(pool, llm, { query: "qawwali and ghazal evening for my parents", vocab, who: null, allowModel: true });
    const later = new Date(Date.now() + (cfg.cacheDays + 1) * 86_400_000);
    expect(await cleanUp(pool, later)).toMatchObject({ searchReadingsExpired: 1 });
  });
});

describe("search results and the log", () => {
  const none = new FakeLlm(() => { throw new Error("should not be called"); });
  const run = (query: string, llm: LlmClient = none, locale: "en" | "hi" = "en") =>
    naturalSearch(llm, { query, city, locale, who: "ip-e", allowModel: true }, pool);
  const titles = (o: { events: { title: string }[] }) => o.events.map((e) => e.title);

  it("runs the filters a query names and logs it", async () => {
    const o = await run("comedy kal");
    expect(o.method).toBe("rules");
    expect(titles(o)).toEqual(["Open Mic Night"]);
    const log = (await pool.query("SELECT query, normalized, locale, parse_method, result_count, cost_usd::float AS cost, parsed FROM search_log")).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ query: "comedy kal", normalized: "comedy kal", locale: "en", parse_method: "rules", result_count: 1, cost: 0 });
    expect(log[0].parsed).toMatchObject({ category: "comedy", when: "tomorrow", dates: { from: o.dates!.from, to: o.dates!.to } });
  });

  it("finds words in performer, venue and area names, and in Hindi text", async () => {
    expect(titles(await run("dev sharma"))).toEqual(["Open Mic Night"]);
    expect(titles(await run("workshops in old palasia"))).toEqual(["Block Printing Workshop"]);
    expect(titles(await run("printing"))).toEqual(["Block Printing Workshop"]);
    expect(titles(await run("ओपन माइक", none, "hi"))).toEqual(["ओपन माइक नाइट"]); // the Hindi page shows the Hindi title
    expect(titles(await run("free"))).toEqual(expect.arrayContaining(["Open Mic Night", "Winter Arts Week"]));
  });

  it("when nothing has the words, shows the rest of the search and logs it as no results", async () => {
    const o = await run("comedy kal zakir");
    expect(o.strictCount).toBe(0);
    expect(o.relaxed).toBe(true);
    expect(titles(o)).toEqual(["Open Mic Night"]);
    const log = (await pool.query("SELECT result_count, parsed FROM search_log")).rows[0];
    expect(log.result_count).toBe(0);
    expect(log.parsed).toMatchObject({ relaxed: true, keywords: ["zakir"] });
  });

  it("logs the model's cost, and the admin view lists common and empty queries", async () => {
    const llm = new FakeLlm(() => ({ category: "festivals", keywords: ["craft"] }));
    const o = await run("anything with craft stalls for the whole family to enjoy", llm);
    expect(o.method).toBe("model");
    expect(titles(o)).toEqual(["Winter Arts Week"]);
    await run("comedy kal");
    await run("comedy kal");
    await run("sunburn");
    const r = await searchReport(30, pool);
    expect(r.common[0]).toMatchObject({ normalized: "comedy kal", searches: 2, zero: 0, last_method: "rules" });
    expect(r.zero.map((z) => z.normalized)).toEqual(["sunburn"]);
    expect(r.methods.find((m) => m.parse_method === "model")).toMatchObject({ searches: 1, usd: 0.00015 });
    expect(r.recent[0].query).toBe("sunburn");
  });

  it("sends a query that names another live city to that city", async () => {
    await pool.query("INSERT INTO cities (slug, name, state, is_live) VALUES ('bhopal', 'Bhopal', 'Madhya Pradesh', true)");
    try {
      const o = await run("comedy in bhopal");
      expect(o.otherCity).toBe("bhopal");
      expect((await pool.query("SELECT count(*)::int AS n FROM search_log")).rows[0].n).toBe(0);
    } finally {
      await pool.query("DELETE FROM cities WHERE slug = 'bhopal'");
    }
  });

  it("keyword search can require every word or any of them", async () => {
    const base = { cityId: city.id, keywords: ["dev", "printing"] };
    expect(await listEvents(base, "en")).toEqual([]);
    expect((await listEvents({ ...base, keywordMode: "any" }, "en")).map((e) => e.title).sort()).toEqual(["Block Printing Workshop", "Open Mic Night"]);
  });
});
