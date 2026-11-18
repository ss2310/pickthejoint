import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.APIFY_ACTOR_ID = "apify/instagram-post-scraper";
  process.env.APIFY_TRANSCRIPT_ACTOR_ID = "someone/instagram-reel-transcript-scraper";
});

import { freshDb } from "./helpers";
import { seed } from "../db/seed";
import { importHandles } from "../scripts/import-handles";
import type { ActorRunResult, ApifyClient } from "../src/lib/pipeline/apify";
import type { Extraction } from "../src/lib/pipeline/extract";
import { ruleFilter } from "../src/lib/pipeline/filter";
import { housekeeping } from "../src/lib/pipeline/housekeeping";
import type { LlmClient, LlmRequest, LlmResult, LlmRunOptions } from "../src/lib/pipeline/llm";
import { processPosts } from "../src/lib/pipeline/process";
import { buildActorInput, normalisePost, scrapeInstagram } from "../src/lib/pipeline/scrape";
import { findRoundupLinks, parseGoogleEvents, robotsAllows } from "../src/lib/pipeline/sources";
import { mergeDuplicates } from "../src/lib/pipeline/dedupe";
import { localDate, nameKey, sameVenueKey, titleSimilarity, zonedToUtc } from "../src/lib/pipeline/text";

let pool: Pool;
beforeAll(async () => { pool = await freshDb(); await seed(pool); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query(`TRUNCATE handles, suggested_handles, raw_posts, sources, events, event_artists, event_organisers,
    venues, artists, organisers, review_queue, cost_log, job_runs, source_state RESTART IDENTITY CASCADE`);
  await importHandles(pool, "handle,type,city,tier\nthe_blue_room,venue,indore,A\nindore_gigs,promoter,indore,B\n");
});

const NOW = new Date("2026-11-18T06:00:00Z");
const inDays = (n: number) => localDate(new Date(NOW.getTime() + n * 86_400_000), "Asia/Kolkata");
const noImages = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

class FakeApify implements ApifyClient {
  calls: { actorId: string; input: unknown }[] = [];
  constructor(private readonly respond: (actorId: string, input: unknown) => Record<string, unknown>[]) {}
  async runActor(actorId: string, input: unknown): Promise<ActorRunResult> {
    this.calls.push({ actorId, input });
    return { runId: "run", status: "SUCCEEDED", items: this.respond(actorId, input) };
  }
}

type Kind = "filter" | "extract" | "same" | "write";
class FakeLlm implements LlmClient {
  calls: { kind: Kind; dryRun: boolean }[] = [];
  constructor(private readonly respond: (kind: Kind, text: string) => unknown) {}
  async run<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    return requests.flatMap((req) => {
      const kind: Kind = req.system.startsWith("You sort") ? "filter" : req.system.startsWith("You extract") ? "extract"
        : req.system.startsWith("You compare") ? "same" : "write";
      this.calls.push({ kind, dryRun: !!opts.dryRun });
      if (opts.dryRun) return [];
      const text = req.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      const data = req.schema.parse(this.respond(kind, text));
      return [{ id: req.id, ok: true, data, model: "fake", usd: 0.001, inputTokens: 10, outputTokens: 10 }];
    });
  }
}

const f = <T>(value: T | null, confidence = value === null ? 0 : 0.95) => ({ value, confidence });
function event(over: Partial<Extraction["events"][number]> = {}): Extraction["events"][number] {
  return {
    announcement: "new_event", title: f("Aria Quartet Live"), start_date: f(inDays(3)), start_time: f("20:00"),
    end_date: f<string>(null), end_time: f<string>(null), venue_name: f("The Blue Room"), venue_instagram_handle: "the_blue_room",
    area: f("Vijay Nagar"), price_text: f("₹499 onwards"), is_free: f(false), booking_url: f<string>(null),
    performers: [{ name: "Aria Quartet", kind: "group", confidence: 0.9 }], organiser: f<string>(null),
    organiser_instagram_handle: null, category: f("music"), ...over,
  };
}
const extraction = (events: Extraction["events"], coHosts: string[] = []): Extraction =>
  ({ is_event_post: events.length > 0, events, co_host_handles: coHosts, notes: "" });

const DESCRIPTION = { description: Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ") };
const post = (shortCode: string, owner: string, caption: string, extra: Record<string, unknown> = {}) => ({
  shortCode, ownerUsername: owner, caption, type: "Image", url: `https://www.instagram.com/p/${shortCode}/`,
  displayUrl: "https://cdn.example/poster.jpg", timestamp: NOW.toISOString(), ...extra,
});
const EVENT_CAPTION = "Aria Quartet live this Saturday, 8 PM. Tickets ₹499 onwards with @indore_jazz_club";

async function ingest(posts: Record<string, unknown>[], llm: FakeLlm, apify = new FakeApify(() => posts)) {
  await scrapeInstagram(pool, apify, { jobName: "test", now: NOW, handles: ["the_blue_room", "indore_gigs"], force: true });
  return processPosts(pool, { llm, apify, fetchFn: noImages }, { jobName: "test" });
}

describe("pure helpers", () => {
  it("sorts captions by keyword rules", () => {
    expect(ruleFilter("Live music this Saturday, 8 PM onwards. Book your tickets now!")).toBe("event");
    expect(ruleFilter("Our new winter menu is here. Come hungry.")).toBe("not_event");
    expect(ruleFilter("🔥🔥 #indore")).toBe("maybe");
    expect(ruleFilter("Something special is brewing with DJ Aria")).toBe("unclear");
    expect(ruleFilter("शनिवार को कवि सम्मेलन, प्रवेश निःशुल्क")).toBe("event");
  });

  it("normalises an Apify post and collects tagged accounts", () => {
    const p = normalisePost(post("ABC", "The_Blue_Room", "With @Indore.Jazz and @the_blue_room", {
      type: "Sidecar", childPosts: [{ displayUrl: "https://cdn.example/2.jpg" }], taggedUsers: [{ username: "dj_aria" }],
      coauthorProducers: [{ username: "indore_gigs" }],
    }))!;
    expect(p).toMatchObject({ shortcode: "ABC", handle: "the_blue_room", postType: "carousel" });
    expect(p.mediaUrls).toEqual(["https://cdn.example/poster.jpg", "https://cdn.example/2.jpg"]);
    expect(p.taggedHandles.sort()).toEqual(["dj_aria", "indore.jazz", "indore_gigs"]);
    expect(normalisePost({ error: "no posts" })).toBeNull();
  });

  it("asks the actor for 3 posts per handle, newer than a date", () => {
    expect(buildActorInput("apify/instagram-post-scraper", ["a", "b"], new Date("2026-11-01T10:00:00Z")))
      .toMatchObject({ username: ["a", "b"], resultsLimit: 3, onlyPostsNewerThan: "2026-11-01" });
  });

  it("converts local wall-clock time to UTC and compares titles", () => {
    expect(zonedToUtc("2026-11-21", "20:00", "Asia/Kolkata").toISOString()).toBe("2026-11-21T14:30:00.000Z");
    expect(titleSimilarity("Aria Quartet Live", "Saturday Jazz ft. Aria Quartet")).toBeGreaterThanOrEqual(0.6);
    expect(titleSimilarity("Aria Quartet Live", "Open Mic Comedy")).toBeLessThan(0.25);
  });

  it("reads robots.txt, Google event blocks and roundup links", () => {
    const robots = "User-agent: *\nAllow: /\nDisallow: */page/*\nDisallow: /search\n\nUser-agent: GPTBot\nDisallow: /";
    expect(robotsAllows(robots, "/indore/weekend-events", "PickTheJointBot")).toBe(true);
    expect(robotsAllows(robots, "/indore/page/2", "PickTheJointBot")).toBe(false);
    expect(robotsAllows(robots, "/indore", "GPTBot")).toBe(false);
    expect(parseGoogleEvents({ tasks: [{ cost: 0.002, result: [{ items: [
      { type: "organic", title: "x" },
      { type: "events", items: [{ type: "events_element", title: "Sunburn Arena", snippet: "Sat, 22 Nov, 6 PM · Phoenix Citadel", url: "https://g.co/e" }] },
    ] }] }] })).toEqual({ costUsd: 0.002, items: [{ title: "Sunburn Arena", snippet: "Sat, 22 Nov, 6 PM · Phoenix Citadel", url: "https://g.co/e" }] });
    const html = `<a href="/indore/weekend-events-in-indore">Weekend events in Indore</a><a href="/indore/road-accident">Accident</a><a href="/mumbai/events-x">Events</a>`;
    expect(findRoundupLinks(html, "https://www.freepressjournal.in/indore", "^https://www\\.freepressjournal\\.in/indore/[a-z0-9-]+$"))
      .toEqual([{ url: "https://www.freepressjournal.in/indore/weekend-events-in-indore", title: "Weekend events in Indore" }]);
  });
});

describe("scrape job", () => {
  it("never stores a post twice and does not re-check a handle that is not due", async () => {
    const apify = new FakeApify(() => [post("P1", "the_blue_room", "a"), post("P2", "the_blue_room", "b"), post("X9", "someone_else", "c"),
      { error: "not_found", errorDescription: "Profile does not exist" }]);
    const first = await scrapeInstagram(pool, apify, { jobName: "test", now: NOW });
    expect(first).toMatchObject({ handlesDue: 2, handlesChecked: 2, postsNew: 2, postsAlreadyStored: 0,
      errors: ["Profile does not exist"], handlesWithNothing: ["indore_gigs"] });

    const second = await scrapeInstagram(pool, apify, { jobName: "test", now: new Date(NOW.getTime() + 60_000) });
    expect(second).toMatchObject({ handlesDue: 0, postsNew: 0 });
    expect(apify.calls).toHaveLength(1); // second run paid for nothing

    // Tier A is due again after a day, tier B is not; repeats are skipped by shortcode.
    const nextDay = await scrapeInstagram(pool, apify, { jobName: "test", now: new Date(NOW.getTime() + 25 * 3_600_000) });
    expect(nextDay).toMatchObject({ handlesDue: 1, postsNew: 0, postsAlreadyStored: 2 });
    expect((await pool.query("SELECT count(*) AS n FROM raw_posts")).rows[0].n).toBe(2);
    expect((await pool.query("SELECT count(*) AS n FROM cost_log WHERE bucket = 'scrape' AND NOT dry_run")).rows[0].n).toBe(2);
  });

  it("files a collab post under the profile it was fetched from", async () => {
    const apify = new FakeApify(() => [post("C1", "guest_comedian", "Venue - @the_blue_room", { inputUrl: "https://www.instagram.com/the_blue_room/" })]);
    await scrapeInstagram(pool, apify, { jobName: "test", now: NOW });
    expect((await pool.query("SELECT handle, tagged_handles FROM raw_posts")).rows).toEqual([{ handle: "the_blue_room", tagged_handles: ["guest_comedian"] }]);
  });

  it("dry run calls nothing and logs the would-be cost", async () => {
    const apify = new FakeApify(() => []);
    const r = await scrapeInstagram(pool, apify, { jobName: "test", now: NOW, dryRun: true });
    expect(apify.calls).toHaveLength(0);
    expect(r.handlesDue).toBe(2);
    expect(r.estimatedUsd).toBeGreaterThan(0);
    expect((await pool.query("SELECT dry_run FROM cost_log")).rows).toEqual([{ dry_run: true }]);
    expect((await pool.query("SELECT last_checked_at FROM handles WHERE last_checked_at IS NOT NULL")).rowCount).toBe(0);
  });
});

describe("pipeline", () => {
  it("publishes a confident event with venue, performer, source and description", async () => {
    const llm = new FakeLlm((kind) => (kind === "extract" ? extraction([event()], ["indore_jazz_club"]) : DESCRIPTION));
    const report = await ingest([post("P1", "the_blue_room", EVENT_CAPTION), post("P2", "the_blue_room", "Our new winter menu is here. Come hungry.")], llm);

    expect(report.filter).toMatchObject({ continued: 1, filteredOut: 1, askedModel: 0 });
    expect(report.eventsPublished).toBe(1);
    const { rows: [ev] } = await pool.query(
      `SELECT e.title, e.slug, e.starts_at, e.local_date::text, e.is_published, e.origin, e.description, e.price_text, e.last_verified_at,
              v.name AS venue, v.needs_enrichment, v.official_links, a.slug AS area, c.slug AS category
       FROM events e JOIN venues v ON v.id = e.venue_id LEFT JOIN areas a ON a.id = v.area_id LEFT JOIN categories c ON c.id = e.category_id`);
    expect(ev).toMatchObject({
      title: "Aria Quartet Live", slug: `aria-quartet-live-${inDays(3)}`, local_date: inDays(3), is_published: true, origin: "scraped",
      price_text: "₹499 onwards", venue: "The Blue Room", needs_enrichment: true, official_links: { instagram: "the_blue_room" },
      area: "vijay-nagar", category: "music",
    });
    expect(ev.starts_at.toISOString()).toBe(zonedToUtc(inDays(3), "20:00", "Asia/Kolkata").toISOString());
    expect(ev.description).toBe(DESCRIPTION.description);
    expect(ev.last_verified_at).not.toBeNull();
    expect((await pool.query("SELECT source_type, url FROM sources")).rows).toEqual([{ source_type: "instagram", url: "https://www.instagram.com/p/P1/" }]);
    expect((await pool.query("SELECT name, kind, needs_enrichment FROM artists")).rows).toEqual([{ name: "Aria Quartet", kind: "group", needs_enrichment: true }]);
    expect((await pool.query("SELECT processing_state FROM raw_posts ORDER BY shortcode")).rows.map((r) => r.processing_state)).toEqual(["published", "filtered_out"]);

    // Tagged and credited accounts are suggested, never added as handles.
    expect((await pool.query("SELECT handle, status FROM suggested_handles")).rows).toEqual([{ handle: "indore_jazz_club", status: "pending" }]);
    expect((await pool.query("SELECT count(*) AS n FROM handles")).rows[0].n).toBe(2);
  });

  it("sends an event to review instead of publishing when the venue is not confident", async () => {
    const llm = new FakeLlm((kind) => (kind === "extract" ? extraction([event({ venue_name: f("Somewhere in Indore", 0.4) })]) : DESCRIPTION));
    const report = await ingest([post("P1", "indore_gigs", EVENT_CAPTION)], llm);
    expect(report.eventsPublished).toBe(0);
    expect((await pool.query("SELECT count(*) AS n FROM events")).rows[0].n).toBe(0);
    const { rows } = await pool.query("SELECT item_type, reason, status FROM review_queue");
    expect(rows).toEqual([{ item_type: "raw_post", reason: "venue missing or not confident", status: "open" }]);
    expect((await pool.query("SELECT processing_state FROM raw_posts")).rows[0].processing_state).toBe("queued_review");
  });

  it("merges a second post about the same event and raises its confidence", async () => {
    const llm = new FakeLlm((kind, text) => {
      if (kind !== "extract") return DESCRIPTION;
      return text.includes("@indore_gigs")
        ? extraction([event({ title: f("Saturday Jazz ft. Aria Quartet"), venue_name: f("Blue Room, Indore"), venue_instagram_handle: null, price_text: f<string>(null), booking_url: f("https://tickets.example/aria") })])
        : extraction([event({ title: f("Aria Quartet Live", 0.85) })]);
    });
    const report = await ingest([post("P1", "the_blue_room", EVENT_CAPTION), post("P2", "indore_gigs", EVENT_CAPTION)], llm);
    expect(report.resolve).toMatchObject({ created: 1, merged: 1 });
    const { rows } = await pool.query("SELECT title, confidence, booking_url, price_text FROM events");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Aria Quartet Live", booking_url: "https://tickets.example/aria", price_text: "₹499 onwards" });
    expect(rows[0].confidence).toBeCloseTo(0.95);
    expect((await pool.query("SELECT count(*) AS n FROM sources")).rows[0].n).toBe(2);
    expect((await pool.query("SELECT count(*) AS n FROM venues")).rows[0].n).toBe(1);
    expect(llm.calls.filter((c) => c.kind === "write")).toHaveLength(1);
  });

  it("asks the model about a borderline duplicate and keeps different events apart", async () => {
    const llm = new FakeLlm((kind, text) => {
      if (kind === "same") return { same_event: false, confidence: 0.9 };
      if (kind !== "extract") return DESCRIPTION;
      return extraction([event(text.includes("@indore_gigs") ? { title: f("Aria Unplugged Brunch"), start_time: f("12:00") } : {})]);
    });
    const report = await ingest([post("P1", "the_blue_room", EVENT_CAPTION), post("P2", "indore_gigs", EVENT_CAPTION)], llm);
    expect(llm.calls.filter((c) => c.kind === "same")).toHaveLength(1);
    expect(report.resolve).toMatchObject({ created: 2, merged: 0 });
  });

  it("a cancellation post updates the existing event", async () => {
    const llm = new FakeLlm((kind, text) => {
      if (kind !== "extract") return DESCRIPTION;
      return extraction([event(text.includes("cancelled") ? { announcement: "cancellation" } : {})]);
    });
    await ingest([post("P1", "the_blue_room", EVENT_CAPTION)], llm);
    const report = await ingest([post("P3", "the_blue_room", "Saturday's show with Aria Quartet stands cancelled. Tickets will be refunded.")], llm);
    expect(report.resolve.statusUpdates).toBe(1);
    expect((await pool.query("SELECT status FROM events")).rows).toEqual([{ status: "cancelled" }]);
    expect((await pool.query("SELECT count(*) AS n FROM sources")).rows[0].n).toBe(2);
  });

  it("requests a reel transcript only when date, venue or price is still missing", async () => {
    let extractCalls = 0;
    const llm = new FakeLlm((kind, text) => {
      if (kind !== "extract") return DESCRIPTION;
      extractCalls++;
      if (text.includes("REEL") && !text.includes("on-screen text")) return extraction([event({ start_date: f<string>(null) })]);
      return extraction([event()]);
    });
    const apify = new FakeApify((actorId) => actorId === "someone/instagram-reel-transcript-scraper"
      ? [{ transcript: "see you this Saturday at eight", onScreenText: "The Blue Room" }, { _summary: true, status: "run_summary" }]
      : [post("R1", "the_blue_room", `REEL ${EVENT_CAPTION}`, { type: "Video" }), post("P2", "indore_gigs", EVENT_CAPTION)]);
    const report = await ingest([], llm, apify);
    expect(apify.calls.filter((c) => c.actorId === "someone/instagram-reel-transcript-scraper")).toHaveLength(1);
    expect(apify.calls.find((c) => c.actorId.endsWith("transcript-scraper"))!.input).toEqual({ reelUrls: ["https://www.instagram.com/p/R1/"], maxItems: 1 });
    expect(report.transcripts).toMatchObject({ requested: 1, empty: 0, filledAMissingField: 1 });
    expect((await pool.query("SELECT transcript FROM raw_posts WHERE shortcode = 'R1'")).rows[0].transcript)
      .toBe("see you this Saturday at eight\nText shown on screen: The Blue Room");
    expect(extractCalls).toBe(3);
    expect((await pool.query("SELECT sub_budget FROM cost_log WHERE sub_budget IS NOT NULL")).rows).toEqual([{ sub_budget: "reelTranscript" }]);
    // The transcript informs the facts; it is not in the published text.
    expect((await pool.query("SELECT description FROM events")).rows[0].description).not.toContain("see you this Saturday");
  });

  it("dry run changes nothing and reports an estimate", async () => {
    const apify = new FakeApify(() => [post("P1", "the_blue_room", EVENT_CAPTION)]);
    await scrapeInstagram(pool, apify, { jobName: "test", now: NOW });
    const llm = new FakeLlm(() => { throw new Error("must not be called for real"); });
    const report = await processPosts(pool, { llm, apify, fetchFn: noImages }, { jobName: "test", dryRun: true, expectedNewPosts: 15 });
    expect(llm.calls.every((c) => c.dryRun)).toBe(true);
    expect(report.estimate).toMatchObject({ postsWaiting: 1, postsExpectedFromScrape: 15 });
    expect((await pool.query("SELECT processing_state, filter_result FROM raw_posts")).rows).toEqual([{ processing_state: "new", filter_result: null }]);
    expect((await pool.query("SELECT count(*) AS n FROM events")).rows[0].n).toBe(0);
  });
});

describe("duplicates", () => {
  it("treats a short venue name and its longer form as one place, but not unrelated names", () => {
    const same = (a: string, b: string) => sameVenueKey(nameKey(a, "Indore"), nameKey(b, "Indore"));
    expect(same("Ohlio", "Ohlio Gourmet Cafebar")).toBe(true);
    expect(same("MARQ Indore", "Marq Club and Kitchen")).toBe(true);
    expect(same("The Park", "Central Park")).toBe(false);
    expect(same("Cafe", "Cafe Terazza")).toBe(false);
    expect(same("Ohlio", "Ohliology")).toBe(false);
  });

  it("matches a new post to an existing venue written at a different length", async () => {
    const llm = new FakeLlm((kind, text) => {
      if (kind !== "extract") return DESCRIPTION;
      return extraction([event(text.includes("@indore_gigs") ? { venue_name: f("The Blue Room Listening Bar"), venue_instagram_handle: null } : {})]);
    });
    const report = await ingest([post("P1", "the_blue_room", EVENT_CAPTION), post("P2", "indore_gigs", EVENT_CAPTION)], llm);
    expect(report.resolve).toMatchObject({ created: 1, merged: 1 });
    expect((await pool.query("SELECT name FROM venues")).rows).toEqual([{ name: "The Blue Room" }]);
  });

  it("merges venues and listings that were already stored twice, keeping every source", async () => {
    const llm = new FakeLlm((kind) => (kind === "extract" ? extraction([event()]) : DESCRIPTION));
    await ingest([post("P1", "the_blue_room", EVENT_CAPTION)], llm);
    // A second copy of the same show under a longer spelling of the venue, as an older matching rule would have left it.
    const { rows: [city] } = await pool.query("SELECT id FROM cities WHERE slug = 'indore'");
    const { rows: [v2] } = await pool.query("INSERT INTO venues (city_id, slug, name, address) VALUES ($1, 'blue-room-bar', 'The Blue Room Listening Bar', '12 Example Road') RETURNING id", [city.id]);
    const { rows: [e1] } = await pool.query("SELECT * FROM events");
    const { rows: [e2] } = await pool.query(
      `INSERT INTO events (city_id, venue_id, slug, title, starts_at, local_date, start_time_known, booking_url, confidence, is_published, origin)
       VALUES ($1,$2,'aria-copy',$3,$4,$5,true,'https://tickets.example/aria',0.85,true,'scraped') RETURNING id`,
      [city.id, v2.id, "Aria Quartet - Live", e1.starts_at, e1.local_date]);
    await pool.query("INSERT INTO sources (event_id, source_type, url) VALUES ($1, 'web', 'https://news.example/aria')", [e2.id]);

    const preview = await mergeDuplicates(pool, { dryRun: true });
    expect(preview.venuesMerged).toEqual([{ kept: "The Blue Room", removed: "The Blue Room Listening Bar" }]);
    expect((await pool.query("SELECT count(*) AS n FROM venues")).rows[0].n).toBe(2); // dry run changed nothing

    const report = await mergeDuplicates(pool);
    expect(report.eventsMerged).toMatchObject([{ kept: "Aria Quartet Live", removed: "Aria Quartet - Live", venue: "The Blue Room" }]);
    const { rows: venues } = await pool.query("SELECT name, address, official_links FROM venues");
    expect(venues).toEqual([{ name: "The Blue Room", address: "12 Example Road", official_links: { instagram: "the_blue_room" } }]);
    const { rows: events } = await pool.query("SELECT title, booking_url, confidence FROM events");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: "Aria Quartet Live", booking_url: "https://tickets.example/aria" });
    expect(events[0].confidence).toBeCloseTo(1);
    expect((await pool.query("SELECT url FROM sources ORDER BY id")).rows.map((r) => r.url)).toEqual(["https://www.instagram.com/p/P1/", "https://news.example/aria"]);
    expect(await mergeDuplicates(pool)).toEqual({ venuesMerged: [], eventsMerged: [] }); // nothing left to merge
  });
});

describe("housekeeping", () => {
  it("marks finished events as happened and never deletes them", async () => {
    const llm = new FakeLlm((kind) => (kind === "extract" ? extraction([event()]) : DESCRIPTION));
    await ingest([post("P1", "the_blue_room", EVENT_CAPTION)], llm);
    const before = await housekeeping(pool, { now: NOW });
    expect(before.eventsMarkedHappened).toBe(0);
    const later = new Date(NOW.getTime() + 5 * 86_400_000);
    expect((await housekeeping(pool, { now: later, dryRun: true })).eventsMarkedHappened).toBe(1);
    expect((await pool.query("SELECT status FROM events")).rows).toEqual([{ status: "scheduled" }]);
    expect((await housekeeping(pool, { now: later })).eventsMarkedHappened).toBe(1);
    expect((await pool.query("SELECT status, is_published FROM events")).rows).toEqual([{ status: "happened", is_published: true }]);
  });
});
