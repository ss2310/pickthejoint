import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SITE_URL = "https://pickthejoint.com";
  // Nothing here may reach a paid service: without a key, a request that was sent by mistake fails the test.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SECOND_LOOK;
  delete process.env.SECOND_LOOK_PUBLISH;
});

import { freshDb } from "./helpers";
import { seedDemo } from "./fixtures";
import { seed } from "../db/seed";
import { importHandles } from "../scripts/import-handles";
import { closePool } from "../src/lib/db";
import { budgets, secondLook } from "../src/config";
import { checkSources, enoughSources } from "../src/lib/pipeline/enrich";
import type { ExtractedEvent } from "../src/lib/pipeline/extract";
import { AnthropicLlm, type LlmClient, type LlmRequest, type LlmResult, type LlmRunOptions } from "../src/lib/pipeline/llm";
import { AnthropicResearch, urlKey, type ResearchClient, type ResearchOptions, type ResearchRequest, type ResearchResult, type RetrievedPage } from "../src/lib/pipeline/research";
import {
  applyFound, assessLookup, classify, findListed, lookupOf, publishQueuedPost, runSecondLook, LOOKUP_SYSTEM,
  type Lookup, type LookupResult, type Need,
} from "../src/lib/pipeline/second-look";
import { localDate } from "../src/lib/pipeline/text";
import { fieldsFromExtraction } from "../src/lib/submissions";

const TZ = "Asia/Kolkata";
const NOW = new Date();
const inDays = (n: number) => new Date(Date.parse(`${localDate(NOW, TZ)}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let pool: Pool;
let indore: number;
beforeAll(async () => { pool = await freshDb(); await seed(pool); });
afterAll(async () => { await closePool(); await pool.end(); });
beforeEach(async () => {
  await pool.query(`TRUNCATE handles, raw_posts, entity_sources, sources, events, event_artists, event_organisers, venues, artists, organisers, series,
    review_queue, cost_log, job_runs RESTART IDENTITY CASCADE`);
  await seedDemo(pool, NOW);
  await importHandles(pool, "handle,type,city,tier\nthe_blue_room,venue,indore,A\nindore_gigs,promoter,indore,B\n");
  indore = (await pool.query<{ id: number }>("SELECT id FROM cities WHERE slug = 'indore'")).rows[0].id;
});

// ---------------------------------------------------------------- stand-ins (nothing paid)

/** Stands in for the web search request: canned pages per event name, and a count of what was asked. */
class FakeResearch implements ResearchClient {
  calls: { req: ResearchRequest; opts: ResearchOptions }[] = [];
  dryRuns = 0;
  constructor(private readonly pages: Record<string, RetrievedPage[] | "fail"> = {}, private readonly usd = 0.07) {}
  async research(req: ResearchRequest, opts: ResearchOptions): Promise<ResearchResult | undefined> {
    if (opts.dryRun) { this.dryRuns++; return undefined; }
    this.calls.push({ req, opts });
    const name = Object.keys(this.pages).find((n) => req.prompt.includes(`Name: ${n}`));
    const answer = name ? this.pages[name] : [];
    if (answer === "fail") {
      return { id: req.id, ok: false, error: "API error 529: overloaded", notes: "", retrieved: [], searches: 0, fetches: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    }
    return { id: req.id, ok: true, notes: `notes about ${name ?? "nothing"}`, retrieved: answer, searches: 2, fetches: 0, inputTokens: 9_000, outputTokens: 600, usd: this.usd };
  }
}

const DESCRIPTION = { description: Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ") };

/** Stands in for the model: reads the canned notes into canned facts, and writes a description when an event is published. */
class FakeLlm implements LlmClient {
  reads = 0;
  writes = 0;
  failReads = 0;
  constructor(private readonly lookups: Record<string, Lookup> = {}) {}
  async run<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    if (opts.dryRun) return [];
    return requests.map((req) => {
      const input = req.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      if (!req.system.startsWith("You read research notes about one event")) {
        this.writes++;
        return { id: req.id, ok: true, data: req.schema.parse(DESCRIPTION), model: "fake", usd: 0.002, inputTokens: 10, outputTokens: 10 };
      }
      expect(opts.subBudget).toBe("secondLook");
      this.reads++;
      if (this.failReads > 0) {
        this.failReads--;
        return { id: req.id, ok: false, error: "the answer was not valid JSON", model: "fake", usd: 0.001, inputTokens: 10, outputTokens: 10 };
      }
      const name = Object.keys(this.lookups).find((n) => input.includes(`notes about ${n}`));
      const data = name ? this.lookups[name] : lookup({ found_event: "no", note: "No page about this event turned up." });
      return { id: req.id, ok: true, data: req.schema.parse(data), model: "fake", usd: 0.01, inputTokens: 10, outputTokens: 10 };
    });
  }
}

// ---------------------------------------------------------------- builders

const f = <T>(value: T | null, confidence = value === null ? 0 : 0.95) => ({ value, confidence });
function event(over: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return {
    announcement: "new_event", title: f("Stylista Winter Edit"), start_date: f(inDays(5)), start_time: f("17:00"),
    end_date: f<string>(null), end_time: f<string>(null), venue_name: f<string>(null), venue_instagram_handle: null,
    city: f("Indore"), area: f<string>(null), price_text: f<string>(null), is_free: f<boolean>(null), booking_url: f<string>(null),
    performers: [], organiser: f<string>(null), organiser_instagram_handle: null, category: f("shopping"), ...over,
  };
}

const VENUE = "venue missing or not confident";
let n = 0;
/** Puts a post in the review queue the way the pipeline does. */
async function queue(ev: ExtractedEvent | null, reason = VENUE, opts: { rawPostId?: number; handle?: string } = {}) {
  let rawPostId = opts.rawPostId;
  if (!rawPostId) {
    const code = `SL${++n}`;
    rawPostId = Number((await pool.query<{ id: number }>(
      `INSERT INTO raw_posts (shortcode, handle, post_url, source_kind, city_id, posted_at, processing_state, caption)
       VALUES ($1, $2, $3, 'instagram', $4, $5, 'queued_review', 'made-up post') RETURNING id`,
      [code, opts.handle ?? "indore_gigs", `https://www.instagram.com/p/${code}/`, indore, NOW])).rows[0].id);
  }
  const post = (await pool.query<{ handle: string; post_url: string }>("SELECT handle, post_url FROM raw_posts WHERE id = $1", [rawPostId])).rows[0];
  const itemId = Number((await pool.query<{ id: number }>(
    "INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('raw_post', $1, $2, $3) RETURNING id",
    [rawPostId, reason, { source: "instagram", handle: post.handle, url: post.post_url, event: ev }])).rows[0].id);
  return { itemId, rawPostId, postUrl: post.post_url };
}

const item = async (id: number) =>
  (await pool.query<{ status: string; resolution_note: string | null; payload: Record<string, unknown> }>(
    "SELECT status, resolution_note, payload FROM review_queue WHERE id = $1", [id])).rows[0];
const postRow = async (id: number) =>
  (await pool.query<{ second_look_at: Date | null; processing_state: string; model_usd: string }>(
    "SELECT second_look_at, processing_state, model_usd FROM raw_posts WHERE id = $1", [id])).rows[0];
const sourcesOf = async (eventId: number) =>
  (await pool.query<{ source_type: string; url: string | null; raw_post_id: number | null }>(
    "SELECT source_type, url, raw_post_id FROM sources WHERE event_id = $1 ORDER BY id", [eventId])).rows;
const count = async (sql: string) => Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`)).rows[0].n);
const categories = async () => (await pool.query<{ slug: string }>("SELECT slug FROM categories ORDER BY sort_order")).rows.map((r) => r.slug);

const DISTRICT = "https://www.district.in/events/stylista-winter-edit-indore";
const BMS = "https://in.bookmyshow.com/events/stylista-winter-edit/ET00412345";
const ALLEVENTS = "https://allevents.in/indore/stylista-winter-edit/80001234";
const STAYHAPPENING = "https://stayhappening.com/e/stylista-winter-edit-E3LV";
const BLOG = "https://indoreweekend.blogspot.com/2026/stylista";

const fact = (value: string | null, urls: string[] = [], confidence = value ? 0.9 : 0, kind: "official" | "reputable" | "weak" = "reputable") =>
  ({ value, confidence, sources: urls.map((url) => ({ url, kind })) });
const lookup = (over: Partial<Lookup> = {}): Lookup =>
  ({ found_event: "yes", note: "The ticketing page lists it at City Grounds.", title: fact(null), venue: fact(null), date: fact(null), city: fact(null), pages: [], ...over });
const stated = (url: string, over: Partial<Lookup["pages"][number]> = {}): Lookup["pages"][number] =>
  ({ url, event_title: "Stylista Winter Edit", venue: "City Grounds", city: "Indore", date: inDays(5), end_date: null, performers: [], ...over });
const page = (url: string, title: string | null = "Stylista Winter Edit, Indore"): RetrievedPage => ({ url, title });

const ctx = () => ({ postUrl: "https://www.instagram.com/p/POST/", postedAt: NOW, timeZone: TZ, cityName: "Indore", areas: ["Vijay Nagar", "Rau"], today: inDays(0) });
const classifyCtx = () => ({ postedAt: NOW, timeZone: TZ, cityName: "Indore", areas: ["Vijay Nagar", "Rau"], today: inDays(0) });
const run = (research: ResearchClient, llm: LlmClient, opts: Partial<Parameters<typeof runSecondLook>[2]> = {}) =>
  runSecondLook(pool, { llm, research }, { jobName: "test", now: NOW, ...opts });

/** One queued post whose venue is missing, with a District page that states it. */
function venueOnDistrict() {
  const research = new FakeResearch({ "Stylista Winter Edit": [page(DISTRICT), page(ALLEVENTS)] });
  // The model calls the ticketing page "weak"; how strong a site is, is ours to decide.
  const llm = new FakeLlm({ "Stylista Winter Edit": lookup({ venue: fact("City Grounds", [DISTRICT], 0.92, "weak"), pages: [stated(DISTRICT)] }) });
  return { research, llm };
}

// ---------------------------------------------------------------- which items

describe("which queued posts get a second look", () => {
  it("takes a new event that only lacks a title, venue, date or city, and says which", () => {
    expect(classify(VENUE, event(), classifyCtx())).toEqual({ eligible: true, needs: ["venue"] });
    expect(classify("title missing or not confident; date missing or not confident",
      event({ title: f("Stylista Winter Edit", 0.7), start_date: f<string>(null), venue_name: f("City Grounds") }), classifyCtx()))
      .toEqual({ eligible: true, needs: ["title", "date"] });
    // Queued for its city: the venue it also lacks is worked out from the event itself.
    expect(classify("could not tell whether the event is in Indore", event({ city: f<string>(null) }), classifyCtx()))
      .toEqual({ eligible: true, needs: ["venue", "city"] });
  });

  it("leaves past events, possible duplicates, unmatched cancellations and failed extractions alone", () => {
    expect(classify(VENUE, event({ start_date: f(inDays(-2)) }), { ...classifyCtx(), postedAt: new Date(NOW.getTime() - 5 * 86_400_000) }))
      .toEqual({ eligible: false, why: "past" });
    expect(classify("possible duplicate of an existing event", event({ venue_name: f("City Grounds") }), classifyCtx())).toEqual({ eligible: false, why: "otherReason" });
    expect(classify("event date is before the post date", event({ start_date: f(inDays(-30)) }), classifyCtx())).toEqual({ eligible: false, why: "otherReason" });
    expect(classify("cancellation post for an event we could not match", event({ announcement: "cancellation" }), classifyCtx())).toEqual({ eligible: false, why: "notNewEvent" });
    expect(classify("extraction failed", null, classifyCtx())).toEqual({ eligible: false, why: "noEvent" });
    expect(classify(VENUE, event({ city: f("Bhopal") }), classifyCtx())).toEqual({ eligible: false, why: "outOfCity" });
    expect(classify(VENUE, event({ venue_name: f("City Grounds") }), classifyCtx())).toEqual({ eligible: false, why: "nothingMissing" });
  });

  it("skips them in a run without searching or changing anything", async () => {
    const old = await queue(event({ title: f("Last Month's Flea"), start_date: f(inDays(-1)) }));
    await pool.query("UPDATE raw_posts SET posted_at = $2 WHERE id = $1", [old.rawPostId, new Date(NOW.getTime() - 6 * 86_400_000)]);
    await queue(event({ title: f("Maybe The Same Gig"), venue_name: f("The Blue Room") }), "possible duplicate of an existing event");
    await queue(event({ title: f("Saturday Social"), announcement: "cancellation" }), "cancellation post for an event we could not match");
    await queue(null, "extraction failed");
    const research = new FakeResearch();
    const report = await run(research, new FakeLlm());
    expect(report).toMatchObject({ openItems: 4, eligible: 0, lookups: 0, mergedIntoListed: 0, usd: 0 });
    expect(report.skipped).toMatchObject({ past: 1, otherReason: 1, notNewEvent: 1, noEvent: 1 });
    expect(research.calls).toHaveLength(0);
    expect(await count("review_queue WHERE status = 'open' AND NOT payload ? 'secondLook'")).toBe(4);
    expect(await count("raw_posts WHERE second_look_at IS NOT NULL")).toBe(0);
  });
});

// ---------------------------------------------------------------- 1. own listings

describe("the free check against our own listings", () => {
  it("merges a post about an event we already list, as another source, without a lookup", async () => {
    const q = await queue(event({ title: f("Aria Quartet Live"), start_date: f(inDays(0)), start_time: f("20:00"), category: f("music") }));
    const research = new FakeResearch();
    const llm = new FakeLlm();
    const report = await run(research, llm);
    expect(report).toMatchObject({ eligible: 1, mergedIntoListed: 1, lookups: 0, usd: 0 });
    expect(research.calls).toHaveLength(0);
    expect(llm.reads + llm.writes).toBe(0);

    const listed = (await pool.query<{ id: number }>("SELECT id FROM events WHERE title = 'Aria Quartet Live'")).rows;
    expect(listed).toHaveLength(1); // no second copy of the event
    expect(await sourcesOf(listed[0].id)).toContainEqual({ source_type: "instagram", url: q.postUrl, raw_post_id: q.rawPostId });
    const it2 = await item(q.itemId);
    expect(it2.status).toBe("resolved");
    expect(it2.resolution_note).toContain("/indore/events/aria-quartet-live-");
    expect((await postRow(q.rawPostId)).processing_state).toBe("merged");
  });

  it("does not match another day, a cancelled or unpublished listing, a post that names another venue, or an unsure title", async () => {
    const city = { id: indore, name: "Indore" };
    expect(await findListed(pool, city, event({ title: f("Aria Quartet Live"), start_date: f(inDays(0)) }))).toMatchObject({ title: "Aria Quartet Live" });
    expect(await findListed(pool, city, event({ title: f("Aria Quartet Live"), start_date: f(inDays(1)) }))).toBeNull();
    expect(await findListed(pool, city, event({ title: f("Saturday Social"), start_date: f(inDays(2)) }))).toBeNull(); // cancelled
    expect(await findListed(pool, city, event({ title: f("Secret Gig"), start_date: f(inDays(1)) }))).toBeNull(); // not published
    expect(await findListed(pool, city, event({ title: f("Aria Quartet Live"), start_date: f(inDays(0)), venue_name: f("Laugh Cottage", 0.6) }))).toBeNull();
    expect(await findListed(pool, city, event({ title: f("Aria Quartet Live", 0.7), start_date: f(inDays(0)) }))).toBeNull();
    expect(await findListed(pool, city, event({ title: f("Aria Quartet Live", 0.7), start_date: f(inDays(0)), venue_name: f("The Blue Room") }))).toMatchObject({ title: "Aria Quartet Live" });
    expect(await findListed(pool, city, event({ title: f("Aria Quartet Live"), start_date: f(inDays(0), 0.6) }))).toBeNull(); // date not sure
  });
});

// ---------------------------------------------------------------- 2 and 3. the lookup and its checks

describe("the paid lookup", () => {
  it("finds a venue on a good source and leaves it on the review item for one click", async () => {
    const q = await queue(event());
    const { research, llm } = venueOnDistrict();
    const report = await run(research, llm);

    expect(report).toMatchObject({ eligible: 1, lookups: 1, found: 1, partial: 0, nothing: 0, readyToApprove: 1, published: 0 });
    expect(report.usd).toBeCloseTo(0.08, 4);
    // One request: web search only, two searches, no page fetch, charged to the second-look budget.
    expect(research.calls).toHaveLength(1);
    expect(research.calls[0].req.system).toBe(LOOKUP_SYSTEM);
    expect(research.calls[0].req.prompt).toContain("What we need: the venue.");
    expect(research.calls[0].opts).toMatchObject({ subBudget: "secondLook", maxSearches: 2, maxFetches: 0 });

    const stored = await item(q.itemId);
    expect(stored.status).toBe("open"); // click first: nothing is published by the lookup
    const found = lookupOf(stored.payload)!;
    expect(found).toMatchObject({ outcome: "found", needed: ["venue"], searches: 2, leftOut: [] });
    expect(found.found).toEqual([{ field: "venue", value: "City Grounds", confidence: 0.92,
      sources: [{ url: DISTRICT, title: "Stylista Winter Edit, Indore", strength: "reputable" }] }]);
    expect(stored.payload.secondLookPending).toBeUndefined();
    expect(await count("events WHERE title = 'Stylista Winter Edit'")).toBe(0);
    const post = await postRow(q.rawPostId);
    expect(post.second_look_at).not.toBeNull();
    expect(Number(post.model_usd)).toBeCloseTo(0.08, 4);
  });

  it("one-click approve publishes the event with the found venue and records the looked-up page as a source", async () => {
    const q = await queue(event());
    const { research, llm } = venueOnDistrict();
    await run(research, llm);
    const stored = await item(q.itemId);
    const found = lookupOf(stored.payload)!;

    // What the admin's Approve button does (src/app/admin/actions.ts, approveItem).
    const fields = fieldsFromExtraction(applyFound(stored.payload.event as ExtractedEvent, found.found), await categories(), 0);
    expect(fields).toMatchObject({ title: "Stylista Winter Edit", venue: "City Grounds", date: inDays(5) });
    const out = await publishQueuedPost(pool, llm, { itemId: q.itemId, rawPostId: q.rawPostId, fields, cityId: null, lookup: found, jobName: "admin" });

    expect(out).toMatchObject({ published: true, lookupSources: [DISTRICT] });
    const ev = (await pool.query<{ venue: string; is_published: boolean; origin: string }>(
      "SELECT v.name AS venue, e.is_published, e.origin FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.id = $1", [out.eventId])).rows[0];
    expect(ev).toEqual({ venue: "City Grounds", is_published: true, origin: "scraped" });
    expect(await sourcesOf(out.eventId)).toEqual([
      { source_type: "instagram", url: q.postUrl, raw_post_id: q.rawPostId },
      { source_type: "web", url: DISTRICT, raw_post_id: null },
    ]);
    const after = await item(q.itemId);
    expect(after.status).toBe("approved");
    expect(after.resolution_note).toContain("looked-up source: district.in");
    expect((await postRow(q.rawPostId)).processing_state).toBe("published");
  });

  it("records no looked-up page when the reviewer replaced the found fact", async () => {
    const q = await queue(event());
    const { research, llm } = venueOnDistrict();
    await run(research, llm);
    const stored = await item(q.itemId);
    const found = lookupOf(stored.payload)!;
    const fields = { ...fieldsFromExtraction(applyFound(stored.payload.event as ExtractedEvent, found.found), await categories(), 0), venue: "Laugh Cottage" };
    const out = await publishQueuedPost(pool, llm, { itemId: q.itemId, rawPostId: q.rawPostId, fields, lookup: found, jobName: "admin" });
    expect(out.lookupSources).toEqual([]);
    expect(await sourcesOf(out.eventId)).toEqual([{ source_type: "instagram", url: q.postUrl, raw_post_id: q.rawPostId }]);
  });

  it("leaves out a fact found on one weak site, and says so on the item", async () => {
    const q = await queue(event());
    const research = new FakeResearch({ "Stylista Winter Edit": [page(ALLEVENTS)] });
    const llm = new FakeLlm({ "Stylista Winter Edit": lookup({ venue: fact("City Grounds", [ALLEVENTS], 0.9, "reputable"), pages: [stated(ALLEVENTS)] }) });
    const report = await run(research, llm);
    expect(report).toMatchObject({ lookups: 1, found: 0, nothing: 1, readyToApprove: 0 });
    const found = lookupOf((await item(q.itemId)).payload)!;
    expect(found.outcome).toBe("nothing");
    expect(found.found).toEqual([]);
    expect(found.leftOut).toEqual([{ field: "venue", value: "City Grounds", reason: "supported by a single weak source" }]);
  });

  it("accepts a fact that two unrelated weak sites agree on, but not AllEvents with its own copy site", () => {
    const pages = [page(ALLEVENTS), page(STAYHAPPENING), page(BLOG)];
    const two = assessLookup(event(), ["venue"], lookup({ venue: fact("City Grounds", [ALLEVENTS, BLOG], 0.85, "weak"), pages: [stated(ALLEVENTS), stated(BLOG)] }), pages, ctx());
    expect(two.leftOut).toEqual([]);
    expect(two.found).toMatchObject([{ field: "venue", value: "City Grounds", sources: [{ url: ALLEVENTS, strength: "weak" }, { url: BLOG, strength: "weak" }] }]);

    const copies = assessLookup(event(), ["venue"], lookup({ venue: fact("City Grounds", [ALLEVENTS, STAYHAPPENING], 0.85, "reputable"), pages: [stated(ALLEVENTS), stated(STAYHAPPENING)] }), pages, ctx());
    expect(copies.found).toEqual([]);
    expect(copies.leftOut).toEqual([{ field: "venue", value: "City Grounds", reason: "supported by a single weak source" }]);
  });

  it("counts District and BookMyShow as good sources whatever the model calls them", () => {
    for (const url of [DISTRICT, BMS]) {
      const a = assessLookup(event(), ["venue"], lookup({ venue: fact("City Grounds", [url], 0.9, "weak"), pages: [stated(url)] }), [page(url)], ctx());
      expect(a.found).toMatchObject([{ value: "City Grounds", sources: [{ url, strength: "reputable" }] }]);
    }
  });

  it("refuses a source the search did not return", () => {
    const invented = "https://www.district.in/events/made-up-by-the-model";
    const a = assessLookup(event(), ["venue"], lookup({ venue: fact("City Grounds", [invented], 0.95), pages: [stated(invented)] }), [page(ALLEVENTS)], ctx());
    expect(a.found).toEqual([]);
    expect(a.leftOut).toEqual([{ field: "venue", value: "City Grounds", reason: "no source that the search returned" }]);
    // Our own pages and the post itself cannot confirm the post.
    const own = "https://pickthejoint.com/indore/events/stylista-winter-edit";
    const b = assessLookup(event(), ["venue"], lookup({ venue: fact("City Grounds", [own, ctx().postUrl], 0.95), pages: [stated(own), stated(ctx().postUrl)] }),
      [page(own), page(ctx().postUrl)], ctx());
    expect(b.found).toEqual([]);
    expect(b.leftOut[0].reason).toBe("no source that the search returned");
  });

  it("refuses a page about another city, another date, another venue or another event", () => {
    const pages = [page(DISTRICT)];
    const venueFrom = (over: Partial<Lookup["pages"][number]>, e = event()) =>
      assessLookup(e, ["venue"], lookup({ venue: fact("City Grounds", [DISTRICT], 0.95), pages: [stated(DISTRICT, over)] }), pages, ctx());
    expect(venueFrom({ city: "Bhopal" }).leftOut).toEqual([{ field: "venue", value: "City Grounds", reason: "the page is about Bhopal" }]);
    expect(venueFrom({ city: null }).leftOut[0].reason).toBe("the page does not say which city");
    expect(venueFrom({ date: inDays(33) }).leftOut[0].reason).toBe(`the page is about ${inDays(33)}, not ${inDays(5)}`);
    expect(venueFrom({ date: null }).leftOut[0].reason).toBe("the page gives no date");
    expect(venueFrom({ event_title: "Indore Food Carnival" }).leftOut[0].reason).toBe("the page has a different name and no performer in common");
    expect(venueFrom({ venue: "Phoenix Citadel" }).leftOut[0].reason).toBe("the page does not state this venue");
    for (const a of [venueFrom({ city: "Bhopal" }), venueFrom({ date: inDays(33) }), venueFrom({ event_title: "Indore Food Carnival" })]) expect(a.found).toEqual([]);
    // A locality of the city, a multi-day page that covers the date, and a different name with a shared performer are the same event.
    expect(venueFrom({ city: "Vijay Nagar" }).found).toHaveLength(1);
    expect(venueFrom({ date: inDays(4), end_date: inDays(6) }).found).toHaveLength(1);
    expect(venueFrom({ event_title: "An Evening With Aria Quartet", performers: ["Aria Quartet"] },
      event({ performers: [{ name: "Aria Quartet", kind: "group", confidence: 0.9 }] })).found).toHaveLength(1);
    // Nothing counts when the notes did not find the event, or the model was not confident.
    expect(assessLookup(event(), ["venue"], lookup({ found_event: "unsure", venue: fact("City Grounds", [DISTRICT], 0.95), pages: [stated(DISTRICT)] }), pages, ctx()).found).toEqual([]);
    expect(assessLookup(event(), ["venue"], lookup({ venue: fact("City Grounds", [DISTRICT], 0.6), pages: [stated(DISTRICT)] }), pages, ctx()).leftOut[0].reason)
      .toBe("found, but not with confidence (0.60)");
  });

  it("settles a date, a city and an unsure title, and marks a fact that differs from the post's own guess", () => {
    const pages = [page(BMS)];
    const e = event({ title: f("Stylista Winter Edt", 0.7), start_date: f<string>(null), venue_name: f("Blue Room Annex", 0.5), city: f<string>(null) });
    const needs: Need[] = ["title", "venue", "date", "city"];
    const a = assessLookup(e, needs, lookup({
      title: fact("Stylista Winter Edit", [BMS]), venue: fact("City Grounds", [BMS]), date: fact(inDays(5), [BMS]), city: fact("Indore, Madhya Pradesh", [BMS]),
      pages: [stated(BMS)],
    }), pages, ctx());
    expect(a.leftOut).toEqual([]);
    expect(a.found.map((x) => [x.field, x.value, x.differsFromPost])).toEqual([
      ["title", "Stylista Winter Edit", undefined], ["venue", "City Grounds", "Blue Room Annex"], ["date", inDays(5), undefined], ["city", "Indore", undefined],
    ]);
    const applied = applyFound(e, a.found);
    expect([applied.title.value, applied.venue_name.value, applied.start_date.value, applied.city.value]).toEqual(["Stylista Winter Edit", "City Grounds", inDays(5), "Indore"]);

    // A date that has passed, and an event that turns out to be in another city, are left out.
    const past = assessLookup(event({ start_date: f<string>(null), venue_name: f("City Grounds") }), ["date"],
      lookup({ date: fact(inDays(-3), [BMS]), pages: [stated(BMS, { date: inDays(-3) })] }), pages, ctx());
    expect(past.leftOut[0].reason).toBe("the date found has already passed");
    const elsewhere = assessLookup(event({ city: f<string>(null), venue_name: f("City Grounds") }), ["city"],
      lookup({ city: fact("Bhopal", [BMS]), pages: [stated(BMS, { city: "Bhopal" })] }), pages, ctx());
    expect(elsewhere.found).toEqual([]);
    expect(elsewhere.leftOut[0].reason).toBe("the page is about Bhopal");
  });

  it("merges into a listing when the found fact shows we already have the event, keeping the looked-up page", async () => {
    const q = await queue(event({ title: f("Block Printing Workshop"), start_date: f<string>(null), venue_name: f("Laugh Cottage"), category: f("workshops") }), "date missing or not confident");
    const url = "https://www.district.in/events/block-printing-workshop-indore";
    const research = new FakeResearch({ "Block Printing Workshop": [page(url, "Block Printing Workshop")] });
    const llm = new FakeLlm({ "Block Printing Workshop": lookup({ date: fact(inDays(3), [url]),
      pages: [stated(url, { event_title: "Block Printing Workshop", venue: "Laugh Cottage", date: inDays(3) })] }) });
    const report = await run(research, llm);
    expect(report).toMatchObject({ lookups: 1, found: 1, mergedIntoListed: 1, readyToApprove: 0, published: 0 });
    expect(await count("events WHERE title = 'Block Printing Workshop'")).toBe(1);
    const listed = (await pool.query<{ id: number }>("SELECT id FROM events WHERE title = 'Block Printing Workshop'")).rows[0].id;
    expect(await sourcesOf(listed)).toEqual(expect.arrayContaining([
      { source_type: "instagram", url: q.postUrl, raw_post_id: q.rawPostId }, { source_type: "web", url, raw_post_id: null }]));
    expect((await item(q.itemId)).status).toBe("resolved");
  });
});

// ---------------------------------------------------------------- limits

describe("limits", () => {
  const three = async () => [
    await queue(event({ title: f("Gig One"), start_date: f(inDays(9)) })),
    await queue(event({ title: f("Gig Two"), start_date: f(inDays(2)) })),
    await queue(event({ title: f("Gig Three"), start_date: f(inDays(4)) })),
  ];

  it("makes at most the run's number of lookups, soonest events first, and never looks a post up twice", async () => {
    const [one, two, threeQ] = await three();
    const research = new FakeResearch();
    const llm = new FakeLlm();
    const first = await run(research, llm, { maxPerRun: 2 });
    expect(first).toMatchObject({ eligible: 3, lookups: 2, nothing: 2 });
    expect(first.skipped.overRunCap).toBe(1);
    expect(research.calls.map((c) => c.req.prompt.match(/Name: (.+)/)![1])).toEqual(["Gig Two", "Gig Three"]);
    expect((await postRow(one.rawPostId)).second_look_at).toBeNull();
    expect(lookupOf((await item(two.itemId)).payload)).toMatchObject({ outcome: "nothing", found: [] });
    expect((await item(two.itemId)).status).toBe("open"); // nothing found: the item stays as it was, with a note

    const second = await run(research, llm, { maxPerRun: 2 });
    expect(second).toMatchObject({ eligible: 3, lookups: 1 });
    expect(second.skipped.alreadyLookedUp).toBe(2);
    expect(research.calls).toHaveLength(3);

    const third = await run(research, llm);
    expect(third).toMatchObject({ lookups: 0, usd: 0 });
    expect(third.skipped.alreadyLookedUp).toBe(3);
    expect(research.calls).toHaveLength(3);
    expect((await postRow(threeQ.rawPostId)).second_look_at).not.toBeNull();
  });

  it("never goes above the configured cap, whatever a run asks for", async () => {
    await three();
    const report = await run(new FakeResearch(), new FakeLlm(), { dryRun: true, maxPerRun: 500 });
    expect(report.estimate!.perRunCap).toBe(secondLook.maxPerRun);
    expect(secondLook.maxPerRun).toBe(15);
    expect(budgets.secondLook).toBe(8);
  });

  it("gives a line-up post one lookup: of its several queued events, the first gets it", async () => {
    const first = await queue(event({ title: f("Friday: Dev Sharma Live"), start_date: f(inDays(6)) }));
    const second = await queue(event({ title: f("Saturday: Aria Quartet"), start_date: f(inDays(7)) }), VENUE, { rawPostId: first.rawPostId });
    const research = new FakeResearch();
    const report = await run(research, new FakeLlm());
    expect(report).toMatchObject({ eligible: 2, lookups: 1 });
    expect(report.skipped.samePost).toBe(1);
    expect(research.calls).toHaveLength(1);
    expect(research.calls[0].req.prompt).toContain("Name: Friday: Dev Sharma Live");
    expect(lookupOf((await item(second.itemId)).payload)).toBeNull();
  });

  it("stops when the month's second-look budget is used up", async () => {
    await three();
    await pool.query(
      "INSERT INTO cost_log (logged_at, bucket, sub_budget, service, estimated_usd, job_name) VALUES ($1, 'model', 'secondLook', 'anthropic', $2, 'earlier')",
      [NOW, budgets.secondLook - 0.15]);
    const research = new FakeResearch();
    const report = await run(research, new FakeLlm());
    // $0.15 is left: enough for one lookup at the reserved estimate, not for three.
    expect(report.lookups).toBe(1);
    expect(report.stopped).toMatch(/second-look budget has \$0\.15 left this month, which covers 1 of 3 lookups/);
    expect(research.calls).toHaveLength(1);

    await pool.query("UPDATE cost_log SET estimated_usd = $1", [budgets.secondLook]);
    const none = await run(research, new FakeLlm());
    expect(none.lookups).toBe(0);
    expect(none.stopped).toMatch(/covers 0 of 2 lookups/);
    expect(research.calls).toHaveLength(1);
  });

  it("does not use up a post's one lookup when the search request failed before searching", async () => {
    const q = await queue(event());
    const report = await run(new FakeResearch({ "Stylista Winter Edit": "fail" }), new FakeLlm());
    expect(report).toMatchObject({ lookups: 0, failed: 1, usd: 0 });
    expect((await postRow(q.rawPostId)).second_look_at).toBeNull();
    expect(lookupOf((await item(q.itemId)).payload)).toBeNull();
  });

  it("never pays for a second search when the notes could not be read the first time", async () => {
    const q = await queue(event());
    const { research, llm } = venueOnDistrict();
    llm.failReads = 1;
    const first = await run(research, llm);
    expect(first).toMatchObject({ lookups: 1, failed: 1, found: 0 });
    expect((await item(q.itemId)).payload.secondLookPending).toMatchObject({ notes: "notes about Stylista Winter Edit", attempts: 1 });

    const second = await run(research, llm);
    expect(second).toMatchObject({ lookups: 0, found: 1, readyToApprove: 1 });
    expect(research.calls).toHaveLength(1); // the stored notes were read again; nothing was searched again
    const found = lookupOf((await item(q.itemId)).payload)!;
    expect(found.outcome).toBe("found");
    expect(found.usd).toBeCloseTo(0.081, 4); // the search, the failed read and the read that worked
  });
});

// ---------------------------------------------------------------- dry run and the publish switch

describe("dry run", () => {
  it("counts what a run would try and what it would cost, and sends and changes nothing", async () => {
    const listed = await queue(event({ title: f("Aria Quartet Live"), start_date: f(inDays(0)), category: f("music") }));
    const a = await queue(event());
    const b = await queue(event({ title: f("PAN-POT Live", 0.72), venue_name: f("Room XO"), start_date: f(inDays(9)) }), "title missing or not confident");
    await queue(null, "extraction failed");
    const before = (await pool.query("SELECT id, status, payload FROM review_queue ORDER BY id")).rows;

    // The real clients, with no API key: a dry run must stop at the budget guard and never build a request.
    const report = await run(new AnthropicResearch(), new AnthropicLlm(), { dryRun: true });

    expect(report).toMatchObject({ openItems: 4, eligible: 3, lookups: 0, mergedIntoListed: 0, usd: 0 });
    expect(report.estimate).toMatchObject({ wouldMergeIntoListed: 1, wouldLookUp: 2, perRunCap: 15, budgetLeftUsd: 8 });
    expect(report.estimate!.usdPerLookup).toBeGreaterThan(secondLook.estResearchUsd);
    expect(report.estimate!.usdPerLookup).toBeLessThan(0.15);
    expect(report.estimate!.usd).toBeCloseTo(2 * report.estimate!.usdPerLookup, 3);
    expect(report.items.map((i) => [i.queueId, i.outcome])).toEqual([
      [listed.itemId, expect.stringMatching(/^would merge into \/indore\/events\/aria-quartet-live-/)], [a.itemId, "would look up"], [b.itemId, "would look up"]]);

    expect((await pool.query("SELECT id, status, payload FROM review_queue ORDER BY id")).rows).toEqual(before);
    expect(await count("raw_posts WHERE second_look_at IS NOT NULL OR processing_state <> 'queued_review'")).toBe(0);
    expect(await count("sources WHERE raw_post_id IS NOT NULL")).toBe(0);
    // The estimate is logged as a dry run, so it never counts against the budget.
    expect(await count("cost_log WHERE NOT dry_run")).toBe(0);
    expect(await count("cost_log WHERE dry_run AND sub_budget = 'secondLook'")).toBe(4);
  });
});

describe("publishing without the click (SECOND_LOOK_PUBLISH)", () => {
  it("is off by default, like the whole step", () => {
    expect(secondLook.enabled).toBe(false);
    expect(secondLook.publish).toBe(false);
  });

  it("publishes a fully checked fact through the same path, with the confidence of its weakest fact", async () => {
    const q = await queue(event());
    const { research, llm } = venueOnDistrict();
    const report = await run(research, llm, { publish: true });
    expect(report).toMatchObject({ lookups: 1, found: 1, published: 1, readyToApprove: 0 });
    const ev = (await pool.query<{ id: number; venue: string; is_published: boolean; confidence: number }>(
      "SELECT e.id, v.name AS venue, e.is_published, e.confidence FROM events e JOIN venues v ON v.id = e.venue_id WHERE e.title = 'Stylista Winter Edit'")).rows[0];
    expect(ev).toMatchObject({ venue: "City Grounds", is_published: true });
    expect(ev.confidence).toBeCloseTo(0.92, 2);
    expect((await sourcesOf(ev.id)).map((s) => [s.source_type, s.url])).toEqual([["instagram", q.postUrl], ["web", DISTRICT]]);
    expect((await item(q.itemId)).status).toBe("approved");
  });

  it("still waits for the click when the fact differs from the post's own guess, or only part was found", async () => {
    const differs = await queue(event({ venue_name: f("Blue Room Annex", 0.5) }));
    const part = await queue(event({ title: f("Rooftop Sundowner"), start_date: f<string>(null) }), "venue missing or not confident; date missing or not confident");
    const url = "https://www.district.in/events/rooftop-sundowner-indore";
    const research = new FakeResearch({ "Stylista Winter Edit": [page(DISTRICT)], "Rooftop Sundowner": [page(url)] });
    const llm = new FakeLlm({
      "Stylista Winter Edit": lookup({ venue: fact("City Grounds", [DISTRICT], 0.95), pages: [stated(DISTRICT)] }),
      "Rooftop Sundowner": lookup({ date: fact(inDays(8), [url]), pages: [stated(url, { event_title: "Rooftop Sundowner", venue: null, date: inDays(8) })] }),
    });
    const report = await run(research, llm, { publish: true });
    expect(report).toMatchObject({ lookups: 2, found: 1, partial: 1, published: 0, readyToApprove: 1 });
    expect(await count("events WHERE title IN ('Stylista Winter Edit', 'Rooftop Sundowner')")).toBe(0);
    expect(lookupOf((await item(differs.itemId)).payload)!.found[0].differsFromPost).toBe("Blue Room Annex");
    const partial = lookupOf((await item(part.itemId)).payload) as LookupResult;
    expect(partial).toMatchObject({ outcome: "partial", needed: ["venue", "date"] });
    expect(partial.found.map((x) => x.field)).toEqual(["date"]);
    expect((await item(part.itemId)).status).toBe("open");
  });
});

// ---------------------------------------------------------------- enrichment keeps its own rules

describe("the source checks shared with enrichment", () => {
  it("behave as before: only returned pages count, and one weak site is not enough but two are", () => {
    const returned = new Map<string, string | null>([[urlKey("https://a.example/x"), "A"]]);
    const kept = checkSources(
      [{ url: "https://a.example/x", kind: "weak" }, { url: "https://www.a.example/x/", kind: "weak" }, { url: "https://never-returned.example/", kind: "official" }],
      returned, (_key, _host, kind) => kind);
    expect(kept).toEqual([{ url: "https://a.example/x", title: "A", strength: "weak" }]);
    const weak = (url: string) => ({ url, title: null, strength: "weak" as const });
    expect(enoughSources([weak("https://allevents.in/a")])).toBe(false);
    expect(enoughSources([weak("https://tripadvisor.in/a"), weak("https://tripadvisor.com/a")])).toBe(false);
    expect(enoughSources([weak("https://allevents.in/a"), weak("https://justdial.com/b")])).toBe(true);
    expect(enoughSources([{ url: "https://news.example/a", title: null, strength: "reputable" }])).toBe(true);
  });
});
