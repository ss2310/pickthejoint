/** Prompt 11: practical facts on event pages, and the weekly roundup. The model is a stand-in; nothing paid is called. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

import { renderToStaticMarkup } from "react-dom/server";
import { freshDb } from "./helpers";
import { seed } from "../db/seed";
import { closePool } from "../src/lib/db";
import type { Extraction, ExtractedEvent } from "../src/lib/pipeline/extract";
import { extractionSchema, practicalOf } from "../src/lib/pipeline/extract";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { LlmClient, LlmRequest, LlmResult, LlmRunOptions } from "../src/lib/pipeline/llm";
import { emptyCounts, resolvePost, type PostContext } from "../src/lib/pipeline/resolve";
import { housekeeping } from "../src/lib/pipeline/housekeeping";
import { pendingItems } from "../src/lib/pipeline/translate";
import { localDate } from "../src/lib/pipeline/text";
import { cleanAnswer, eventFacts, setFactsByAdmin, storeFacts } from "../src/lib/practical";
import { approveSubmission, createDraft, emptyFields, queueSubmission, readFields, validate } from "../src/lib/submissions";
import { getEvent } from "../src/lib/queries";
import { setLocale } from "../src/lib/locale";
import { PracticalFacts } from "../src/components/practical-facts";
import { RoundupArticle } from "../src/components/roundup-article";
import {
  chooseSections, draftRoundups, getRoundup, isoWeek, overviewProblem, periodFor, publishedRoundupPaths, roundupEvents,
} from "../src/lib/roundups";
import { changedPaths } from "../src/lib/indexnow";
import { backfillFacts } from "../src/lib/pipeline/facts-backfill";
import { sitemapEntries } from "../src/lib/sitemap";

let pool: Pool;
let cityId: number;
beforeAll(async () => {
  pool = await freshDb();
  await seed(pool);
  cityId = (await pool.query<{ id: number }>("SELECT id FROM cities WHERE slug = 'indore'")).rows[0].id;
});
afterAll(async () => { await closePool(); await pool.end(); });
beforeEach(async () => {
  await pool.query(`TRUNCATE raw_posts, sources, events, event_artists, event_organisers, venues, artists, organisers, review_queue,
    practical_facts, roundups, submissions, translations, entity_sources, cost_log RESTART IDENTITY CASCADE`);
});

const TZ = "Asia/Kolkata";
const today = localDate(new Date(), TZ);
const inDays = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const f = <T>(value: T | null, confidence = value === null ? 0 : 0.95) => ({ value, confidence });

function ev(over: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return {
    announcement: "new_event", title: f("Sufi Night"), start_date: f(inDays(5)), start_time: f("19:30"), end_date: f<string>(null),
    end_time: f("22:30"), venue_name: f("Ravindra Natya Griha"), venue_instagram_handle: null, city: f("Indore"), area: f<string>(null),
    price_text: f("₹300"), is_free: f(false), booking_url: f<string>(null), performers: [], organiser: f<string>(null),
    organiser_instagram_handle: null, category: f("music"), practical: [], ...over,
  };
}

let posts = 0;
async function post(ex: Extraction, handle = "rng_indore"): Promise<number> {
  posts++;
  const shortcode = `P${posts}${Date.now()}`;
  const id = (await pool.query<{ id: number }>(
    "INSERT INTO raw_posts (shortcode, handle, post_url, posted_at, city_id) VALUES ($1,$2,$3,now(),$4) RETURNING id",
    [shortcode, handle, `https://www.instagram.com/p/${shortcode}/`, cityId])).rows[0].id;
  const ctx: PostContext = {
    rawPostId: id, sourceKind: "instagram", handle, postUrl: `https://www.instagram.com/p/${shortcode}/`, postedAt: new Date(), shortcode,
    cityId, cityName: "Indore", timeZone: TZ, taggedHandles: [],
  };
  await resolvePost(pool, new NoModel(), ctx, ex, "test", emptyCounts());
  return id;
}

class NoModel implements LlmClient {
  async run<T>(): Promise<LlmResult<T>[]> { throw new Error("no model call expected"); }
}

const DESCRIPTION = { description: Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ") };
const INTRO_EN = `This week Indore has five events listed from Friday to Thursday, among them music, comedy and a children's workshop. ${"Sufi Night is on Friday at Ravindra Natya Griha. ".repeat(4)}Two events are free to enter.`;
const INTRO_HI = "इस हफ़्ते इंदौर में शुक्रवार से गुरुवार तक पाँच इवेंट लिस्टेड हैं, जिनमें म्यूज़िक, कॉमेडी और बच्चों की वर्कशॉप शामिल हैं। ".repeat(4);

/** Answers descriptions, screening and the roundup overview; records each request. */
class FakeLlm implements LlmClient {
  seen: { system: string; text: string; subBudget?: string }[] = [];
  constructor(private readonly overview: Record<string, string> = { title_en: "What's on in Indore", intro_en: INTRO_EN, title_hi: "इंदौर में क्या चल रहा है", intro_hi: INTRO_HI }) {}
  async run<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    return requests.map((req) => {
      const text = req.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      this.seen.push({ system: req.system.slice(0, 60), text, subBudget: opts.subBudget });
      const answer = req.system.startsWith("You screen") ? { spam: false, plausible_event: true, reason: "fine", confidence: 0.9 }
        : req.system.includes("weekly \"what's on\" guide") ? this.overview : DESCRIPTION;
      return { id: req.id, ok: true, data: req.schema.parse(answer), model: "fake", usd: 0.002, inputTokens: 10, outputTokens: 10 };
    });
  }
}

const facts = async () => (await pool.query<{ entity_type: string; fact_key: string; answer: string; source_type: string }>(
  "SELECT entity_type, fact_key, answer, source_type FROM practical_facts ORDER BY fact_key")).rows;

describe("practical facts from posts", () => {
  it("asks the model for them in the extraction", () => {
    const schema = extractionSchema(["music"]);
    const lines = ["age_limit | 0.95 | 18+ only", "- parking | 0.9 | Basement parking, paid", "shoe_size | 1 | 9", "not a fact line"].join("\n");
    const parsed = schema.parse({ is_event_post: true, co_host_handles: [], notes: "", events: [{ ...ev(), practical: lines }] });
    expect(practicalOf(parsed.events[0])).toEqual([
      { key: "age_limit", confidence: 0.95, answer: "18+ only" }, { key: "parking", confidence: 0.9, answer: "Basement parking, paid" },
    ]);
    expect(practicalOf({ practical: "" })).toEqual([]);
    expect(practicalOf({})).toEqual([]);
    // The schema the model is held to stays small: a nested list there made the request too large for structured outputs.
    expect(JSON.stringify(zodOutputFormat(schema)).length).toBeLessThan(3400);
  });

  it("stores confident stated facts with their source, venue facts on the venue, and never a guess", async () => {
    await post({ is_event_post: true, co_host_handles: [], notes: "", events: [ev({ practical: [
      { key: "age_limit", answer: "18+ only, ID checked at the gate", confidence: 0.95 },
      { key: "doors_time", answer: "19:00", confidence: 0.9 },
      { key: "parking", answer: "Paid parking in the basement", confidence: 0.9 },
      { key: "dress_code", answer: "Smart casual", confidence: 0.5 },
      { key: "language", answer: "not mentioned", confidence: 0.9 },
    ] })] });
    const rows = await facts();
    expect(rows.map((r) => `${r.entity_type}:${r.fact_key}`)).toEqual(["event:age_limit", "event:doors_time", "venue:parking"]);
    const src = (await pool.query<{ source_url: string; raw_post_id: number }>("SELECT source_url, raw_post_id FROM practical_facts WHERE fact_key = 'age_limit'")).rows[0];
    expect(src.source_url).toMatch(/^https:\/\/www\.instagram\.com\/p\//);
    expect(src.raw_post_id).toBeGreaterThan(0);
  });

  it("lets a later post fill a gap but not overwrite an answer", async () => {
    await post({ is_event_post: true, co_host_handles: [], notes: "", events: [ev({ practical: [{ key: "seating", answer: "Seated", confidence: 0.9 }] })] });
    await post({ is_event_post: true, co_host_handles: [], notes: "", events: [ev({ practical: [
      { key: "seating", answer: "Standing", confidence: 0.95 }, { key: "language", answer: "Hindi and Urdu", confidence: 0.9 },
    ] })] }, "another_page");
    expect((await pool.query("SELECT count(*)::int AS n FROM events")).rows[0].n).toBe(1);
    expect(Object.fromEntries((await facts()).map((r) => [r.fact_key, r.answer]))).toEqual({ seating: "Seated", language: "Hindi and Urdu" });
  });

  it("cleans answers", () => {
    expect(cleanAnswer("doors_time", "7:30 PM")).toBe("19:30");
    expect(cleanAnswer("doors_time", "evening")).toBeNull();
    expect(cleanAnswer("age_limit", "N/A")).toBeNull();
    expect(cleanAnswer("entry_rules", `  "Passes  needed" `)).toBe("Passes  needed".replace(/\s+/g, " "));
  });
});

async function oneEvent(): Promise<{ id: number; slug: string; venueId: number }> {
  await post({ is_event_post: true, co_host_handles: [], notes: "", events: [ev({ practical: [{ key: "age_limit", answer: "18+ only", confidence: 0.95 }] })] });
  const e = (await pool.query<{ id: number; slug: string; venue_id: number }>("SELECT id, slug, venue_id FROM events")).rows[0];
  await pool.query("UPDATE events SET is_published = true, description = 'x' WHERE id = $1", [e.id]);
  return { id: e.id, slug: e.slug, venueId: e.venue_id };
}

describe("organisers and the admin", () => {
  it("takes practical details for a listed event through the form, and stores them as the organiser's once approved", async () => {
    const e = await oneEvent();
    const form = new FormData();
    form.set("for_event", String(e.id));
    form.set("fact_age_limit", "16+ with a parent");
    form.set("fact_food_drink", "Food stalls inside; no outside food");
    form.set("fact_doors_time", "18:45");
    const fields = readFields(form);
    expect(fields.for_event).toBe(e.id);
    expect(validate(fields, { name: "Asha", contact: "asha@example.org" }, ["music"], today)).toEqual({});
    expect(validate({ ...emptyFields(), for_event: e.id }, { name: "Asha", contact: "asha@example.org" }, ["music"], today)).toEqual({ _facts: "noFacts" });

    const { id } = await createDraft({ channel: "form", cityId, fields: { ...fields, title: "Sufi Night", date: inDays(5) }, submitter: { name: "Asha", contact: "asha@example.org" } }, pool);
    const llm = new FakeLlm();
    const s = await queueSubmission(pool, llm, id, { jobName: "test" });
    expect(s.verdict).toBe("looks_fine");
    expect(s.notes.join(" ")).toContain("practical details for \"Sufi Night\"");
    expect(llm.seen.length).toBe(0); // no duplicate check or spam model for details of a listed event
    const reason = (await pool.query<{ reason: string }>("SELECT reason FROM review_queue WHERE item_type = 'submission'")).rows[0].reason;
    expect(reason).toMatch(/^Practical details for "Sufi Night"/);

    const out = await approveSubmission(pool, llm, id, { jobName: "test" });
    expect(out.eventId).toBe(e.id);
    expect(await pool.query("SELECT count(*)::int AS n FROM events").then((r) => r.rows[0].n)).toBe(1);
    const rows = await facts();
    expect(rows.find((r) => r.fact_key === "age_limit")).toMatchObject({ answer: "16+ with a parent", source_type: "organiser" });
    expect(rows.find((r) => r.fact_key === "food_drink")?.source_type).toBe("organiser");
  });

  it("lets the admin change, add and remove answers", async () => {
    const e = await oneEvent();
    await storeFacts(pool, e.id, [{ key: "parking", answer: "Street parking only", confidence: 1 }], { type: "post", url: "https://x.example/p" });
    const changes = await setFactsByAdmin(pool, e.id, { age_limit: "18+ only", parking: "", seating: "Seated" });
    expect(changes.sort()).toEqual(["parking removed", "seating added"]);
    const rows = await facts();
    expect(rows.map((r) => `${r.fact_key}:${r.source_type}`)).toEqual(["age_limit:post", "seating:admin"]);
    await expect(setFactsByAdmin(pool, e.id, { doors_time: "late" })).rejects.toThrow(/time such as/);
    // An organiser's answer does not replace the admin's.
    await storeFacts(pool, e.id, [{ key: "seating", answer: "Standing", confidence: 1 }], { type: "organiser" });
    expect((await facts()).find((r) => r.fact_key === "seating")?.answer).toBe("Seated");
  });

  it("moves answers when duplicate listings are merged", async () => {
    const e = await oneEvent();
    // A second listing of the same night, made before matching caught it.
    const dup = (await pool.query<{ id: number }>(
      `INSERT INTO events (city_id, venue_id, slug, title, starts_at, local_date, origin, is_published, confidence, description)
       SELECT city_id, venue_id, slug || '-2', title, starts_at, local_date, 'scraped', true, 0.9, 'x' FROM events WHERE id = $1 RETURNING id`, [e.id])).rows[0].id;
    await storeFacts(pool, dup, [{ key: "language", answer: "Urdu", confidence: 1 }, { key: "age_limit", answer: "All ages", confidence: 1 }], { type: "organiser" });
    await housekeeping(pool, {});
    const left = (await pool.query<{ id: number }>("SELECT id FROM events")).rows.map((r) => Number(r.id));
    expect(left).toEqual([e.id]);
    expect(Object.fromEntries((await facts()).map((r) => [r.fact_key, r.answer]))).toEqual({ age_limit: "18+ only", language: "Urdu" });
  });
});

describe("facts for events listed before Prompt 11", () => {
  it("reads the source post again and stores only its practical facts", async () => {
    const e = await oneEvent();
    await pool.query("DELETE FROM practical_facts");
    const reading: Extraction = { is_event_post: true, co_host_handles: [], notes: "", events: [ev({
      title: f("Sufi Night (Indore)"), start_date: f(inDays(9)), practical: "entry_rules | 0.9 | Passes needed; entry closes at 8 PM",
    })] };
    class Reader implements LlmClient {
      seen = 0;
      async run<T>(requests: LlmRequest<T>[]): Promise<LlmResult<T>[]> {
        this.seen += requests.length;
        return requests.map((r) => ({ id: r.id, ok: true, data: r.schema.parse(reading), model: "fake", usd: 0.012, inputTokens: 1, outputTokens: 1 }));
      }
    }
    const llm = new Reader();
    const notFetched: typeof fetch = async () => new Response("", { status: 404 });
    const dry = await backfillFacts(pool, llm, { jobName: "test", dryRun: true });
    expect(dry).toMatchObject({ posts: 1, usd: 0 });
    expect(dry.estimatedUsd).toBeGreaterThan(0);
    expect(llm.seen).toBe(0);
    const out = await backfillFacts(pool, llm, { jobName: "test", fetchFn: notFetched });
    expect(out).toMatchObject({ posts: 1, eventsWithNewFacts: 1, factsStored: 1, usd: 0.012 });
    expect((await facts()).map((r) => r.fact_key)).toEqual(["entry_rules"]);
    // The event's own facts are untouched: its date and title are not taken from the new reading.
    expect((await pool.query("SELECT title, local_date::text AS d FROM events WHERE id = $1", [e.id])).rows[0]).toEqual({ title: "Sufi Night", d: inDays(5) });
    // Done once: an event with facts is not read again.
    expect((await backfillFacts(pool, llm, { jobName: "test", dryRun: true })).posts).toBe(0);
  });
});

describe("the event page", () => {
  it("answers only what a source states, names each source, and adds FAQPage data", async () => {
    const e = await oneEvent();
    await storeFacts(pool, e.id, [
      { key: "doors_time", answer: "19:00", confidence: 1 }, { key: "food_drink", answer: "Food stalls inside", confidence: 1 },
    ], { type: "organiser" });
    // The venue's directions found by enrichment, with their page.
    await pool.query("UPDATE venues SET how_to_reach = 'Near Regal Square, off MG Road.' WHERE id = $1", [e.venueId]);
    await pool.query("INSERT INTO entity_sources (entity_type, entity_id, url, field) VALUES ('venue', $1, 'https://mptourism.example/rng', 'how_to_reach')", [e.venueId]);

    setLocale("en");
    const detail = (await getEvent("indore", e.slug, "en"))!;
    const answers = await eventFacts(pool, e.id, e.venueId, "en");
    expect(answers.map((a) => a.key)).toEqual(["doors_time", "age_limit", "food_drink", "how_to_reach"]);
    const html = renderToStaticMarkup(PracticalFacts({ e: detail, facts: answers }));
    expect(html).toContain("What time does Sufi Night start?");
    expect(html).toContain("Doors open at 7:00 PM.");
    expect(html).toContain("What time does Sufi Night end?");
    expect(html).toContain("Is there an age limit for Sufi Night?");
    expect(html).toContain("How do I get to Ravindra Natya Griha?");
    expect(html).toContain("sent in by the organiser and checked by us");
    expect(html).toContain("https://mptourism.example/rng");
    expect(html).toContain("Instagram post");
    expect(html).not.toContain("dress code");
    expect(html).toContain("\"@type\":\"FAQPage\"");
    expect(html).toContain(`/submit?event=${e.id}`);
  });

  it("sends the answers for Hindi translation, but not a door time", async () => {
    const e = await oneEvent();
    await storeFacts(pool, e.id, [{ key: "doors_time", answer: "19:00", confidence: 1 }], { type: "organiser" });
    const items = (await pendingItems(pool)).filter((i) => i.type === "practical_fact");
    expect(items.map((i) => i.text)).toEqual(["18+ only"]);
    await pool.query(
      "INSERT INTO translations (entity_type, entity_id, locale, field, text, source_hash) SELECT 'practical_fact', id, 'hi', 'answer', 'सिर्फ़ 18+', md5(answer) FROM practical_facts WHERE fact_key = 'age_limit'");
    expect((await eventFacts(pool, e.id, e.venueId, "hi")).find((a) => a.key === "age_limit")?.answer).toBe("सिर्फ़ 18+");
  });
});

describe("weekly roundups", () => {
  it("covers Friday to Thursday and numbers weeks the ISO way", () => {
    expect(periodFor("2026-11-19")).toMatchObject({ start: "2026-11-20", end: "2026-11-26", weekendEnd: "2026-11-22", slug: "2026-week-47" });
    expect(periodFor("2026-11-21").start).toBe("2026-11-20"); // a Saturday: this weekend
    expect(periodFor("2026-11-23").start).toBe("2026-11-27"); // a Monday: the coming one
    expect(isoWeek("2027-01-01")).toEqual({ year: 2026, week: 53 });
    expect(isoWeek("2026-12-31")).toEqual({ year: 2026, week: 53 });
  });

  /** Events in the week this test's guide covers. */
  async function week(): Promise<{ start: string; ids: number[] }> {
    const p = periodFor(today);
    const venue = (await pool.query<{ id: number }>("INSERT INTO venues (city_id, slug, name) VALUES ($1,'jal-sabhagrah','Jal Sabhagrah') RETURNING id", [cityId])).rows[0].id;
    const cat = async (slug: string) => (await pool.query<{ id: number }>("SELECT id FROM categories WHERE slug = $1", [slug])).rows[0].id;
    const rows: [string, string, number, boolean, string][] = [
      ["Ghazal Evening", "music", 0, true, "scheduled"], ["Open Mic", "comedy", 1, true, "scheduled"], ["Clay Play for Kids", "kids", 1, true, "scheduled"],
      ["Puppet Show", "kids", 2, true, "scheduled"], ["Story Hour", "kids", 2, false, "scheduled"], ["Jazz Trio", "music", 4, false, "scheduled"],
      ["Called Off Gig", "music", 3, false, "cancelled"],
    ];
    const ids: number[] = [];
    for (const [title, c, day, free, status] of rows) {
      const d = new Date(Date.parse(`${p.start}T00:00:00Z`) + day * 86_400_000).toISOString().slice(0, 10);
      ids.push((await pool.query<{ id: number }>(
        `INSERT INTO events (city_id, venue_id, category_id, slug, title, starts_at, local_date, start_time_known, is_free, price_text, status, origin, is_published, confidence, description)
         VALUES ($1,$2,$3,$4,$5,($6::date + time '18:00') AT TIME ZONE 'Asia/Kolkata',$6,true,$7,$8,$9,'scraped',true,0.9,'x') RETURNING id`,
        [cityId, venue, await cat(c), `${title.toLowerCase().replace(/ /g, "-")}-${d}`, title, d, free, free ? null : "₹300", status])).rows[0].id);
    }
    return { start: p.start, ids };
  }

  it("chooses sections from the listings: categories, free this weekend, for families; never a cancelled event", async () => {
    await week();
    const { sections, events } = await chooseSections(pool, cityId, periodFor(today));
    expect(events.map((e) => e.title)).not.toContain("Called Off Gig");
    expect(sections.map((s) => `${s.key}:${s.event_ids.length}`)).toEqual(["music:2", "comedy:1", "kids:3", "free:4", "families:3"]);
  });

  it("drafts the guide in both languages, keeps it unpublished, and never overwrites a published one", async () => {
    await week();
    const llm = new FakeLlm();
    const [r] = await draftRoundups(pool, llm, { jobName: "test" });
    expect(r).toMatchObject({ city: "indore", status: "drafted", events: 6 });
    expect(llm.seen[0].subBudget).toBe("roundups");
    expect(llm.seen[0].text).toContain("Ghazal Evening");
    expect(llm.seen[0].text).not.toContain("Called Off Gig");
    const row = (await pool.query("SELECT status, title, title_hi, intro_hi FROM roundups")).rows[0];
    expect(row).toMatchObject({ status: "draft", title: "What's on in Indore", title_hi: "इंदौर में क्या चल रहा है" });
    expect(await getRoundup(pool, "indore", r.slug, "en")).toBeNull(); // drafts are not public

    expect((await draftRoundups(pool, llm, { jobName: "test" }))[0].status).toBe("exists");
    expect(llm.seen.length).toBe(1);
    await pool.query("UPDATE roundups SET status = 'published', published_at = now()");
    expect((await draftRoundups(pool, llm, { jobName: "test", force: true }))[0].status).toBe("published already");
  });

  it("refuses an overview that is hype, too short or not in Hindi", async () => {
    await week();
    const bad = await draftRoundups(pool, new FakeLlm({ title_en: "Big week!", intro_en: "Do not miss it!", title_hi: "बड़ा हफ़्ता", intro_hi: "ज़रूर आएँ" }), { jobName: "test" });
    expect(bad[0].status).toBe("failed");
    expect(overviewProblem({ title_en: "What's on", intro_en: INTRO_EN, title_hi: "What's on", intro_hi: INTRO_EN })).toMatch(/Hindi/);
    expect((await pool.query("SELECT count(*)::int AS n FROM roundups")).rows[0].n).toBe(0);
  });

  it("does nothing for a week with too few events, and nothing in a dry run", async () => {
    const llm = new FakeLlm();
    expect((await draftRoundups(pool, llm, { jobName: "test" }))[0].status).toBe("too few events");
    await week();
    const dry = await draftRoundups(pool, llm, { jobName: "test", dryRun: true });
    expect(dry[0].status).toBe("dry run");
    expect(dry[0].estimatedUsd).toBeGreaterThan(0);
    expect(llm.seen.length).toBe(0);
  });

  it("publishes a page with the live listings, Article data, a sitemap entry and an IndexNow ping", async () => {
    const { ids } = await week();
    const [r] = await draftRoundups(pool, new FakeLlm(), { jobName: "test" });
    const since = new Date(Date.now() - 1000);
    await pool.query("UPDATE roundups SET status = 'published', published_at = now(), updated_at = now()");
    // A cancellation after publishing shows in the guide.
    await pool.query("UPDATE events SET status = 'cancelled' WHERE id = $1", [ids[1]]);

    setLocale("en");
    const g = (await getRoundup(pool, "indore", r.slug, "en"))!;
    const html = renderToStaticMarkup(RoundupArticle({ r: g, events: await roundupEvents(g, "en") }));
    expect(html).toContain("What&#x27;s on in Indore");
    expect(html).toContain("Free this weekend");
    expect(html).toContain("For families");
    expect(html).toContain(">Music</h2>");
    expect(html).toContain("Cancelled");
    expect(html).toContain("\"@type\":\"Article\"");
    expect(html).toContain("/indore/events/ghazal-evening-");

    setLocale("hi");
    const gh = (await getRoundup(pool, "indore", r.slug, "hi"))!;
    expect(gh.title).toBe("इंदौर में क्या चल रहा है");
    expect(gh.intro).toMatch(/^इस हफ़्ते इंदौर/);
    expect([...(await roundupEvents(gh, "hi")).keys()].length).toBe(6); // the six drafted; the one cancelled before drafting was left out
    setLocale("en");

    expect((await publishedRoundupPaths(pool)).map((p) => p.slug)).toEqual([r.slug]);
    const map = (await sitemapEntries("hubs")).map((e) => e.path);
    expect(map).toContain(`/indore/guide/${r.slug}`);
    expect(map).toContain("/indore/guide");
    expect(await changedPaths(pool, since)).toContain(`/hi/indore/guide/${r.slug}`);
  });
});
