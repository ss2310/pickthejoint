/** Prompt 9: wider sourcing. Apify, the model and every web page are stand-ins; nothing paid is called. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { freshDb } from "./helpers";
import { seed } from "../db/seed";
import { importHandles } from "../scripts/import-handles";
import type { ActorRunResult, ApifyClient } from "../src/lib/pipeline/apify";
import type { Extraction } from "../src/lib/pipeline/extract";
import type { LlmClient, LlmRequest, LlmResult, LlmRunOptions } from "../src/lib/pipeline/llm";
import { censusGaps, linkCensus, overpassQuery, parseOverpass, runCensus } from "../src/lib/pipeline/census";
import { parseCensusCsv } from "../src/lib/pipeline/census-import";
import { eventLinks, eventText, fetchCalendars, jsonLdEvents, localWhen, pageText, sitemapUrls } from "../src/lib/pipeline/calendars";
import { facebookEvent, facebookPage, fetchFacebookEvents } from "../src/lib/pipeline/facebook";
import { runDiscovery } from "../src/lib/pipeline/discovery";
import { retierHandles, suggestedTier } from "../src/lib/pipeline/tiering";
import { attachSeries, matchSeries } from "../src/lib/pipeline/series";
import { processPosts } from "../src/lib/pipeline/process";
import { coverageReport, weekStartIst } from "../src/lib/coverage";
import { listedSnippet, outreachCsv, outreachList } from "../src/lib/outreach";
import { localDate } from "../src/lib/pipeline/text";

let pool: Pool;
let cityId: number;
beforeAll(async () => {
  pool = await freshDb();
  await seed(pool);
  cityId = (await pool.query<{ id: number }>("SELECT id FROM cities WHERE slug = 'indore'")).rows[0].id;
});
afterAll(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query(`TRUNCATE handles, suggested_handles, raw_posts, sources, events, event_artists, event_organisers, venues, artists, organisers,
    review_queue, cost_log, job_runs, source_state, venue_census, handle_changes, facebook_pages, coverage_reports RESTART IDENTITY CASCADE`);
});

const inDays = (n: number) => localDate(new Date(Date.now() + n * 86_400_000), "Asia/Kolkata");

class FakeApify implements ApifyClient {
  calls: { actorId: string; input: Record<string, unknown> }[] = [];
  constructor(private readonly respond: (input: Record<string, unknown>) => Record<string, unknown>[]) {}
  async runActor(actorId: string, input: unknown): Promise<ActorRunResult> {
    this.calls.push({ actorId, input: input as Record<string, unknown> });
    return { runId: "run", status: "SUCCEEDED", items: this.respond(input as Record<string, unknown>) };
  }
}

const f = <T>(value: T | null, confidence = value === null ? 0 : 0.95) => ({ value, confidence });
function ev(over: Partial<Extraction["events"][number]> = {}): Extraction["events"][number] {
  return {
    announcement: "new_event", title: f("Winter Jazz Night"), start_date: f(inDays(5)), start_time: f("19:30"),
    end_date: f<string>(null), end_time: f<string>(null), venue_name: f("Ravindra Natya Grah"), venue_instagram_handle: null,
    city: f("Indore"), area: f("South Tukoganj"), price_text: f("₹300"), is_free: f(false), booking_url: f<string>(null),
    performers: [], organiser: f<string>(null), organiser_instagram_handle: null, category: f("music"), ...over,
  };
}
const extraction = (events: Extraction["events"]): Extraction => ({ is_event_post: events.length > 0, events, co_host_handles: [], notes: "" });
const DESCRIPTION = { description: Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ") };

/** Answers extraction requests from a function of the request text; writes descriptions; never calls a model. */
class FakeLlm implements LlmClient {
  texts: string[] = [];
  runs: LlmRunOptions[] = [];
  constructor(private readonly extract: (text: string) => Extraction) {}
  async run<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    this.runs.push(opts);
    if (opts.dryRun) return [];
    return requests.map((req) => {
      const text = req.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      const isExtract = req.system.startsWith("You extract");
      if (isExtract) this.texts.push(text);
      const data = req.schema.parse(isExtract ? this.extract(text)
        : req.system.startsWith("You compare") ? { same_event: true, confidence: 0.9 }
        : req.system.startsWith("You check event listings") ? { takes_place_in_city: true, actual_city: "Indore", confidence: 0.95 }
        : DESCRIPTION);
      return { id: req.id, ok: true, data, model: "fake", usd: 0.002, inputTokens: 10, outputTokens: 10 };
    });
  }
}

/** A fetch stand-in serving fixed pages by URL. */
function site(pages: Record<string, string>, log: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    log.push(url);
    const body = pages[url];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
  }) as typeof fetch;
}

const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

describe("seeded festival series", () => {
  it("loads each series with its sources, and attaches matching events by title and month", async () => {
    const s = (await pool.query<{ id: number; aliases: string[]; months: number[]; n: number }>(
      `SELECT s.id, s.aliases, s.months, (SELECT count(*) FROM entity_sources es WHERE es.entity_type = 'series' AND es.entity_id = s.id)::int AS n
       FROM series s WHERE slug = 'indore-rangpanchami-ger'`)).rows[0];
    expect(s.aliases).toContain("gair");
    expect(s.months).toEqual([3, 4]);
    expect(s.n).toBeGreaterThanOrEqual(2);
    await seed(pool); // idempotent: sources replaced, not doubled
    expect((await pool.query("SELECT 1 FROM entity_sources WHERE entity_type = 'series' AND entity_id = $1", [s.id])).rowCount).toBe(s.n);

    const rules = (await pool.query("SELECT id, city_id, aliases, months FROM series")).rows;
    const garba = (await pool.query<{ id: number }>("SELECT id FROM series WHERE slug = 'indore-navratri-garba'")).rows[0].id;
    expect(matchSeries("Retro Garba Season 13", cityId, 10, rules)).toBe(Number(garba));
    expect(matchSeries("Retro Garba Season 13", cityId, 2, rules)).toBeNull(); // wrong month
    expect(matchSeries("Gargantuan Gerbera Show", cityId, 3, rules)).toBeNull(); // no whole-word alias
    expect(matchSeries("Raag Ameer 2027", cityId, 1, rules)).not.toBeNull();

    const v = (await pool.query<{ id: number }>("INSERT INTO venues (city_id, slug, name) VALUES ($1,'rajwada','Rajwada') RETURNING id", [cityId])).rows[0].id;
    await pool.query(
      `INSERT INTO events (city_id, venue_id, slug, title, starts_at, origin, is_published) VALUES
       ($1,$2,'ger-2027','Rangpanchami Ger Mahotsav','2027-03-27T04:30:00Z','scraped',true),
       ($1,$2,'other','Sunday Market','2027-03-28T04:30:00Z','scraped',true)`, [cityId, v]);
    expect(await attachSeries(pool)).toBe(1);
  });
});

describe("venue census", () => {
  const overpass = { elements: [
    { type: "node", id: 1, lat: 22.7, lon: 75.8, tags: { name: "DAVV Auditorium", amenity: "theatre" } },
    { type: "way", id: 2, center: { lat: 22.71, lon: 75.88 }, tags: { name: "Ohlio Gourmet Cafebar", amenity: "bar", "contact:instagram": "https://instagram.com/ohlio_indore/" } },
    { type: "node", id: 3, tags: { name: "Corner Cafe", amenity: "cafe" } }, // a cafe without live music is not taken
    { type: "node", id: 4, tags: { amenity: "pub" } }, // unnamed
  ] };

  it("builds the query and maps OpenStreetMap tags to venue types", () => {
    expect(overpassQuery([1, 2, 3, 4])).toContain('nwr["amenity"~"^(theatre|arts_centre)$"]["name"](1,2,3,4);');
    expect(overpassQuery([1, 2, 3, 4])).toContain('["live_music"="yes"]');
    const places = parseOverpass(overpass);
    expect(places.map((p) => [p.name, p.type, p.instagram])).toEqual([["DAVV Auditorium", "auditorium", null], ["Ohlio Gourmet Cafebar", "club_bar", "ohlio_indore"]]);
    expect(parseCensusCsv("name,type,instagram\nJaal Sabhagrah,auditorium,@jaal\nNo type,weird,\n")).toEqual([
      { name: "Jaal Sabhagrah", type: "auditorium", address: null, instagram: "jaal", facebook: null },
      { name: "No type", type: "other", address: null, instagram: null, facebook: null },
    ]);
  });

  it("stores places, links them to listed venues by name and lists the gaps", async () => {
    const venue = (await pool.query<{ id: number }>(
      "INSERT INTO venues (city_id, slug, name, official_links) VALUES ($1,'ohlio','Ohlio Gourmet Cafebar','{}') RETURNING id", [cityId])).rows[0].id;
    await pool.query("INSERT INTO venues (city_id, slug, name) VALUES ($1,'coffeenism','Coffeenism')", [cityId]);
    const coffee = (await pool.query<{ id: number }>("SELECT id FROM venues WHERE slug = 'coffeenism'")).rows[0].id;
    await pool.query("INSERT INTO events (city_id, venue_id, slug, title, starts_at, origin, is_published) VALUES ($1,$2,'c','C', now() + interval '1 day','scraped',true)", [cityId, coffee]);
    // A venue whose only event was taken down (it was in another city) stays out of the census.
    const dallas = (await pool.query<{ id: number }>("INSERT INTO venues (city_id, slug, name) VALUES ($1,'harwood-park','Harwood Park') RETURNING id", [cityId])).rows[0].id;
    await pool.query("INSERT INTO events (city_id, venue_id, slug, title, starts_at, origin, is_published) VALUES ($1,$2,'h','H', now(),'scraped',false)", [cityId, dallas]);
    let busy = 1;
    const ok = site({ "https://overpass-api.de/api/interpreter": JSON.stringify(overpass) });
    // The first request finds the server busy; the census tries again.
    const fetchFn = (async (u: RequestInfo | URL, i?: RequestInit) => (busy-- > 0 ? new Response("busy", { status: 502 }) : ok(u, i))) as typeof fetch;
    const dry = await runCensus(pool, { city: "indore", dryRun: true, fetchFn, retryDelayMs: 0 });
    expect(dry).toMatchObject({ placesFound: 2, added: 0 });
    const rep = await runCensus(pool, { city: "indore", fetchFn });
    expect(rep).toMatchObject({ placesFound: 2, added: 2, linked: 1, byType: { auditorium: 1, club_bar: 1 } });
    const again = await runCensus(pool, { city: "indore", fetchFn });
    expect(again).toMatchObject({ added: 0, updated: 2 });
    expect(Number((await pool.query("SELECT venue_id FROM venue_census WHERE source_ref = 'way/2'")).rows[0].venue_id)).toBe(Number(venue));
    // Coffeenism has no OSM row: it gets one of its own.
    expect((await pool.query("SELECT source FROM venue_census WHERE name = 'Coffeenism'")).rows[0].source).toBe("event");
    expect(await linkCensus(pool)).toBe(0);

    const noHandle = await censusGaps(pool, { gap: "no_handle" });
    expect(noHandle.map((r) => r.name).sort()).toEqual(["Coffeenism", "DAVV Auditorium"]);
    await pool.query(
      "INSERT INTO events (city_id, venue_id, slug, title, starts_at, origin, is_published) VALUES ($1,$2,'x','X', now() + interval '3 days','scraped',true)", [cityId, venue]);
    const quiet = await censusGaps(pool, { gap: "quiet" });
    expect(quiet.map((r) => r.name)).not.toContain("Ohlio Gourmet Cafebar");
    expect(quiet.map((r) => r.name)).toContain("DAVV Auditorium");
    expect((await pool.query("SELECT 1 FROM venue_census WHERE name = 'Harwood Park'")).rowCount).toBe(0);
  });
});

describe("handle tiering", () => {
  it("promotes, demotes and pauses by real events, leaving young and hand-set handles alone", async () => {
    await importHandles(pool, "handle,type,city,tier\nbusy_bar,venue,indore,B\nquiet_cafe,venue,indore,A\ndead_club,venue,indore,A\nnew_place,venue,indore,B\nheld,venue,indore,A\n");
    await pool.query("UPDATE handles SET created_at = now() - interval '120 days'");
    await pool.query("UPDATE handles SET created_at = now() - interval '5 days' WHERE handle = 'new_place'");
    await pool.query("UPDATE handles SET tier_set_by = 'manual', tier_set_at = now() - interval '3 days' WHERE handle = 'held'");
    const v = (await pool.query<{ id: number }>("INSERT INTO venues (city_id, slug, name) VALUES ($1,'v','V') RETURNING id", [cityId])).rows[0].id;
    const addEvent = async (handle: string, n: number, daysAgo: number) => {
      const e = (await pool.query<{ id: number }>(
        "INSERT INTO events (city_id, venue_id, slug, title, starts_at, origin) VALUES ($1,$2,$3,$3,now(),'scraped') RETURNING id", [cityId, v, `${handle}-${n}`])).rows[0].id;
      const rp = (await pool.query<{ id: number }>("INSERT INTO raw_posts (shortcode, handle, post_url) VALUES ($1,$2,'u') RETURNING id", [`${handle}${n}`, handle])).rows[0].id;
      await pool.query("INSERT INTO sources (event_id, source_type, raw_post_id, observed_at) VALUES ($1,'instagram',$2, now() - make_interval(days => $3))", [e, rp, daysAgo]);
    };
    await addEvent("busy_bar", 1, 3); await addEvent("busy_bar", 2, 10);
    await addEvent("quiet_cafe", 1, 50);
    await addEvent("held", 1, 100);

    const dry = await retierHandles(pool, { dryRun: true });
    expect(dry).toMatchObject({ promoted: ["busy_bar"], demoted: ["quiet_cafe"], paused: ["dead_club"], heldManual: 1, tooNew: 1 });
    expect((await pool.query("SELECT tier FROM handles WHERE handle = 'busy_bar'")).rows[0].tier).toBe("B");
    await retierHandles(pool);
    const rows = Object.fromEntries((await pool.query<{ handle: string; tier: string; active: boolean; paused_reason: string | null }>(
      "SELECT handle, tier, active, paused_reason FROM handles")).rows.map((r) => [r.handle, r]));
    expect(rows.busy_bar).toMatchObject({ tier: "A", active: true });
    expect(rows.quiet_cafe).toMatchObject({ tier: "B", active: true });
    expect(rows.dead_club).toMatchObject({ active: false, paused_reason: "no event in 90 days" });
    expect(rows.held.tier).toBe("A");
    expect((await pool.query("SELECT count(*)::int AS n FROM handle_changes")).rows[0].n).toBe(3);
    expect(suggestedTier(3)).toBe("A");
    expect(suggestedTier(1)).toBe("B");
  });
});

describe("snowball discovery", () => {
  const items = [
    { shortCode: "H1", ownerUsername: "garba_nights_indore", caption: "with @dj_rahul", inputUrl: "https://www.instagram.com/explore/tags/indoreevents/",
      taggedUsers: [{ username: "tracked_venue" }], locationName: "The Chandra Leela Garden", locationId: "555", timestamp: new Date().toISOString() },
    { shortCode: "H2", ownerUsername: "garba_nights_indore", caption: "", inputUrl: "https://www.instagram.com/explore/tags/indorenightlife/",
      locationName: "Indore, Madhya Pradesh", locationId: "1", timestamp: new Date().toISOString() },
  ];

  it("suggests new accounts and places from a capped weekly pull, never publishing anything", async () => {
    await importHandles(pool, "handle,type,city,tier\ntracked_venue,venue,indore,A\n");
    await pool.query("INSERT INTO suggested_handles (handle, city_id, via, event_posts, seen_count) VALUES ('dj_rahul', $1, '{event_post}', 2, 2)", [cityId]);
    const apify = new FakeApify(() => items);

    const [dry] = await runDiscovery(pool, apify, { jobName: "test", dryRun: true, city: "indore" });
    expect(dry.status).toMatch(/dry run: would pull up to \d+ posts/);
    expect(apify.calls).toHaveLength(0);

    const [rep] = await runDiscovery(pool, apify, { jobName: "test", city: "indore", maxPosts: 12 });
    expect(apify.calls[0].input).toMatchObject({ resultsType: "posts", resultsLimit: 2 });
    expect((apify.calls[0].input.directUrls as string[])[0]).toBe("https://www.instagram.com/explore/tags/indoreevents/");
    expect(rep).toMatchObject({ postsReturned: 2, newSuggestions: 1, seenAgain: 1, alreadyTracked: 1, newPlaces: 1 });
    const s = Object.fromEntries((await pool.query<{ handle: string; via: string[]; seen_count: number; event_posts: number; reason: string }>(
      "SELECT handle, via, seen_count, event_posts, reason FROM suggested_handles")).rows.map((r) => [r.handle, r]));
    expect(s.garba_nights_indore).toMatchObject({ via: ["hashtag"], event_posts: 0, reason: "seen in posts under #indoreevents" });
    expect(s.dj_rahul).toMatchObject({ via: ["event_post", "hashtag"], seen_count: 3, event_posts: 2 });
    const place = (await pool.query("SELECT name, source, source_ref FROM venue_census")).rows;
    expect(place).toEqual([{ name: "The Chandra Leela Garden", source: "instagram_location", source_ref: "555" }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM raw_posts")).rows[0].n).toBe(0);
    const cost = (await pool.query("SELECT sub_budget, units FROM cost_log WHERE NOT dry_run")).rows;
    expect(cost).toEqual([{ sub_budget: "discovery", units: "2" }]);

    // Weekly: a second run the same day does nothing.
    const [again] = await runDiscovery(pool, apify, { jobName: "test", city: "indore" });
    expect(again.status).toBe("not due (weekly)");
    expect(apify.calls).toHaveLength(1);
  });
});

describe("web calendars", () => {
  const eventPage = (name: string, start: string, venue = "Brilliant Convention Centre") => `<html><head><title>${name} | MeraEvents</title>
    ${ld({ "@context": "https://schema.org", "@graph": [{ "@type": "Organization", name: "MeraEvents" }, {
      "@type": "BusinessEvent", name, startDate: start, location: { "@type": "Place", name: venue, address: { "@type": "PostalAddress", streetAddress: "Ring Road", addressLocality: "Indore" } },
      offers: { "@type": "Offer", price: "499", priceCurrency: "INR", url: "https://meraevents.com/book/1" }, organizer: { "@type": "Organization", name: "Startup Club" },
    }] })}</head><body>…</body></html>`;

  it("reads JSON-LD events, listing links, sitemaps and local times", () => {
    const events = jsonLdEvents(eventPage("Founders Meet", "2026-12-05T04:30:00Z"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "Founders Meet", venue: "Brilliant Convention Centre", city: "Indore", price: "₹499", organiser: "Startup Club" });
    expect(localWhen("2026-12-05T04:30:00Z", "Asia/Kolkata")).toBe("2026-12-05 10:00");
    expect(localWhen("2027-01-03", "Asia/Kolkata")).toBe("2027-01-03");
    expect(eventText(events[0], "Asia/Kolkata", "https://x")).toContain("Starts (local time): 2026-12-05 10:00");
    const listing = `${ld({ "@type": "ItemList", itemListElement: [{ "@type": "ListItem", url: "https://meraevents.com/events/founders-meet" }] })}
      <a href="/events/second-event">x</a><a href="/blog/post">y</a>`;
    expect(eventLinks(listing, "https://meraevents.com/location/indore", "^https://(www\\.)?meraevents\\.com/events/[a-z0-9-]+$"))
      .toEqual(["https://meraevents.com/events/founders-meet", "https://meraevents.com/events/second-event"]);
    const page = "<nav>Indore Bhopal</nav><h4>Essential information</h4><p>Venue</p><p>Rajwada, Indore</p><h3>Explore more</h3><h2>events</h2><p>Other</p>";
    expect(pageText(page, { textStart: "Essential information", textEnd: "Explore more" })).toBe("Essential information\nVenue\nRajwada, Indore");
    expect(pageText("<p>Another template</p>", { textStart: "Essential information" })).toBeNull();
    expect(sitemapUrls("<urlset><url><loc>https://a/b</loc><lastmod>2026-11-04</lastmod></url><url><loc>https://a/c</loc></url></urlset>"))
      .toEqual([{ url: "https://a/b", lastmod: "2026-11-04" }, { url: "https://a/c", lastmod: null }]);
  });

  it("follows a listing, reads new events once, sets aside past ones, and feeds them to the same pipeline", async () => {
    const future = `${inDays(10)}T13:30:00Z`;
    const pages: Record<string, string> = {
      "https://meraevents.com/robots.txt": "User-agent: *\nAllow: /\nDisallow: /new-search",
      "https://meraevents.com/location/indore": `<a href="https://meraevents.com/events/founders-meet">a</a><a href="https://meraevents.com/events/old-expo">b</a>`,
      "https://meraevents.com/events/founders-meet": eventPage("Founders Meet", future),
      "https://meraevents.com/events/old-expo": eventPage("Old Expo", "2020-01-01T04:30:00Z"),
    };
    const log: string[] = [];
    const llm = new FakeLlm((text) => extraction(text.includes("Founders Meet")
      ? [ev({ title: f("Founders Meet"), venue_name: f("Brilliant Convention Centre"), start_date: f(inDays(10)), start_time: f("19:00"), category: f("business-and-networking") })]
      : []));
    const opts = { jobName: "test", city: "indore", only: ["meraevents"], fetchFn: site(pages, log), delayMs: 0 };

    const [dry] = await fetchCalendars(pool, llm, { ...opts, dryRun: true });
    expect(dry.status).toBe("dry run: would read 1 new item(s)");
    expect((await pool.query("SELECT count(*)::int AS n FROM raw_posts")).rows[0].n).toBe(0);

    const [rep] = await fetchCalendars(pool, llm, opts);
    expect(rep).toMatchObject({ status: "ok", itemsSeen: 2, read: 1, skipped: 1, eventsExtracted: 1 });
    expect(llm.runs.at(-1)).toMatchObject({ subBudget: "webCalendars" });
    expect(llm.texts.at(-1)).toContain("Venue: Brilliant Convention Centre");
    const stored = (await pool.query("SELECT handle, source_kind, processing_state, model_usd FROM raw_posts ORDER BY id")).rows;
    expect(stored).toEqual([
      { handle: "meraevents", source_kind: "web", processing_state: "filtered_out", model_usd: "0.000000" },
      { handle: "meraevents", source_kind: "web", processing_state: "extracted", model_usd: "0.002000" },
    ]);

    // Every few days only; forced, it re-reads the listing but neither event page.
    expect((await fetchCalendars(pool, llm, opts))[0].status).toMatch(/not due/);
    log.length = 0;
    const [third] = await fetchCalendars(pool, llm, { ...opts, force: true });
    expect(third).toMatchObject({ alreadyStored: 2, read: 0 });
    expect(log.filter((u) => u.includes("/events/"))).toEqual([]);

    const result = await processPosts(pool, { llm, apify: new FakeApify(() => []) }, { jobName: "test" });
    expect(result.bySource["web:meraevents"]).toMatchObject({ created: 1 });
    const event = (await pool.query("SELECT title, is_published FROM events")).rows[0];
    expect(event).toEqual({ title: "Founders Meet", is_published: true });
    const src = (await pool.query("SELECT source_type, url FROM sources")).rows[0];
    expect(src).toEqual({ source_type: "web", url: "https://meraevents.com/events/founders-meet" });
  });

  it("respects robots.txt and skips pages that do not mention the city", async () => {
    const llm = new FakeLlm(() => extraction([]));
    const blocked = await fetchCalendars(pool, llm, {
      jobName: "test", city: "indore", only: ["iitindore"], delayMs: 0,
      fetchFn: site({ "https://www.iiti.ac.in/robots.txt": "User-agent: *\nDisallow: /home" }),
    });
    expect(blocked[0].status).toBe("skipped: robots.txt disallows the listing");
    const [mp] = await fetchCalendars(pool, llm, {
      jobName: "test", city: "indore", only: ["mptourism"], delayMs: 0,
      fetchFn: site({ "https://www.mptourism.com/eventslisting.php": "<title>Events</title><p>Tansen Festival, Gwalior, 14 Dec</p>" }),
    });
    expect(mp).toMatchObject({ skipped: 1, read: 0 });
    expect(llm.texts).toHaveLength(0);
  });
});

describe("public Facebook events", () => {
  it("parses page links and actor items", () => {
    expect(facebookPage("https://www.facebook.com/fleamarketindore/")).toBe("fleamarketindore");
    expect(facebookPage("https://m.facebook.com/Some.Venue?ref=x")).toBe("Some.Venue");
    expect(facebookPage("https://www.facebook.com/profile.php?id=123")).toBeNull();
    expect(facebookPage("https://www.facebook.com/events/123/")).toBeNull();
    expect(facebookEvent({ id: "9", name: "Flea", utcStartDate: "2026-12-06T05:30:00.000Z", duration: "PT6H", location: { name: "Lalbagh", city: "Indore" } }))
      .toMatchObject({ id: "9", venue: "Lalbagh", endDate: "2026-12-06T11:30:00.000Z", city: "Indore" });
  });

  it("reads the pages on record once a week, extracts new events only, and confirms a known event as a second source", async () => {
    const venue = (await pool.query<{ id: number }>(
      `INSERT INTO venues (city_id, slug, name, official_links) VALUES ($1,'lalbagh','Lalbagh Palace','{"facebook":"https://www.facebook.com/fleamarketindore"}') RETURNING id`,
      [cityId])).rows[0].id;
    const day = inDays(12);
    // An event we already list from Instagram.
    const known = (await pool.query<{ id: number }>(
      `INSERT INTO events (city_id, venue_id, slug, title, starts_at, local_date, origin, is_published, confidence, description)
       VALUES ($1,$2,'the-pop-up-flea','The Pop-Up Flea',$3::date + time '05:30','${day}','scraped',true,0.85,'x') RETURNING id`, [cityId, venue, day])).rows[0].id;
    const ig = (await pool.query<{ id: number }>("INSERT INTO raw_posts (shortcode, handle, post_url) VALUES ('IG1','popupflea','https://www.instagram.com/p/IG1/') RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO sources (event_id, source_type, raw_post_id, url) VALUES ($1,'instagram',$2,'https://www.instagram.com/p/IG1/')", [known, ig]);

    const items = [
      { id: "111", name: "The Pop-Up Flea", url: "https://www.facebook.com/events/111/", utcStartDate: `${day}T05:30:00.000Z`,
        location: { name: "Lalbagh Palace", city: "Indore" }, inputUrl: "https://www.facebook.com/fleamarketindore/upcoming_hosted_events" },
      { id: "222", name: "Online webinar", isOnline: true, utcStartDate: `${day}T05:30:00.000Z` },
    ];
    const apify = new FakeApify(() => items);
    const llm = new FakeLlm(() => extraction([ev({ title: f("The Pop-Up Flea"), venue_name: f("Lalbagh Palace"), start_date: f(day), start_time: f("11:00"), category: f("food") })]));

    const dry = await fetchFacebookEvents(pool, apify, llm, { jobName: "test", city: "indore", dryRun: true });
    expect(dry.status).toBe("no Facebook pages on record yet"); // a dry run adds nothing, not even pages
    const rep = await fetchFacebookEvents(pool, apify, llm, { jobName: "test", city: "indore" });
    expect(rep).toMatchObject({ pagesAdded: 1, pagesChecked: 1, eventsReturned: 2, skipped: 1, newEvents: 1, eventsExtracted: 1 });
    expect(rep.skipReasons).toEqual(["online event: Online webinar"]);
    expect(apify.calls[0]).toMatchObject({ actorId: "apify/facebook-events-scraper", input: { startUrls: [{ url: "https://www.facebook.com/fleamarketindore/upcoming_hosted_events" }], maxEvents: 8 } });
    expect(llm.texts[0]).toContain("Venue: Lalbagh Palace");
    const cost = (await pool.query("SELECT sub_budget, estimated_usd FROM cost_log WHERE NOT dry_run")).rows;
    expect(cost).toEqual([{ sub_budget: "facebookEvents", estimated_usd: "0.021000" }]);

    expect((await fetchFacebookEvents(pool, apify, llm, { jobName: "test", city: "indore" })).status).toBe("not due (read weekly)");
    const again = await fetchFacebookEvents(pool, apify, llm, { jobName: "test", city: "indore", force: true });
    expect(again).toMatchObject({ alreadyStored: 1, newEvents: 0 });

    const before = Number((await pool.query("SELECT confidence FROM events WHERE id = $1", [known])).rows[0].confidence);
    const result = await processPosts(pool, { llm, apify }, { jobName: "test" });
    expect(result.bySource["facebook:fleamarketindore"]).toMatchObject({ created: 0, merged: 1 });
    const after = Number((await pool.query("SELECT confidence FROM events WHERE id = $1", [known])).rows[0].confidence);
    expect(after).toBeCloseTo(before + 0.1, 5);
    expect((await pool.query("SELECT source_type FROM sources WHERE event_id = $1 ORDER BY id", [known])).rows.map((r) => r.source_type)).toEqual(["instagram", "web"]);
  });
});

describe("coverage report and outreach list", () => {
  it("counts events by first source, second-source confirmations and cost per event", async () => {
    const v = (await pool.query<{ id: number }>(
      `INSERT INTO venues (city_id, slug, name, official_links) VALUES ($1,'coffeenism','Coffeenism','{"instagram":"coffeenism","website":"https://coffeenism.in"}') RETURNING id`,
      [cityId])).rows[0].id;
    const mk = async (slug: string, kind: string, handle: string, extra?: { kind: string; handle: string }) => {
      const e = (await pool.query<{ id: number }>(
        "INSERT INTO events (city_id, venue_id, slug, title, starts_at, origin, is_published) VALUES ($1,$2,$3,$3, now() + interval '2 days','scraped',true) RETURNING id", [cityId, v, slug])).rows[0].id;
      for (const s of [{ kind, handle }, ...(extra ? [extra] : [])]) {
        const rp = (await pool.query<{ id: number }>(
          "INSERT INTO raw_posts (shortcode, handle, post_url, source_kind, city_id, model_usd, processing_state) VALUES ($1,$2,'u',$3,$4,0.01,'published') RETURNING id",
          [`${slug}-${s.kind}`, s.handle, s.kind, cityId])).rows[0].id;
        await pool.query("INSERT INTO sources (event_id, source_type, raw_post_id) VALUES ($1,$2,$3)", [e, s.kind === "instagram" ? "instagram" : "web", rp]);
      }
    };
    await mk("a", "instagram", "coffeenism", { kind: "facebook", handle: "coffeenism" });
    await mk("b", "instagram", "coffeenism");
    await mk("c", "web", "meraevents");
    await pool.query(
      "INSERT INTO cost_log (bucket, sub_budget, service, model, estimated_usd, job_name) VALUES ('scrape',NULL,'apify','apify/instagram-scraper',0.05,'ingest'), ('scrape','discovery','apify','x',0.4,'ingest')");
    const r = (await coverageReport(pool, "indore", weekStartIst(new Date())))!;
    expect(r.eventsPublished).toBe(3);
    expect(r.multiSourceShare).toBeCloseTo(1 / 3, 3);
    const ig = r.bySource.find((l) => l.source === "instagram")!;
    expect(ig).toMatchObject({ published: 2, alsoFoundElsewhere: 1, itemsFetched: 2, scrapeUsd: 0.05, modelUsd: 0.02, costUsd: 0.07, costPerPublishedUsd: 0.035 });
    expect(r.bySource.find((l) => l.source === "web:meraevents")).toMatchObject({ published: 1, costPerPublishedUsd: 0.01 });
    expect(r.discoveryUsd).toBe(0.4);

    const rows = await outreachList(pool);
    expect(rows[0]).toMatchObject({ kind: "venue", name: "Coffeenism", events_listed: 3, upcoming: 3, instagram: "coffeenism", website: "https://coffeenism.in" });
    const csv = outreachCsv(rows);
    expect(csv.split("\r\n")[0]).toMatch(/^type,name,city,page,events_listed/);
    expect(csv).toContain('"<a href=""https://pickthejoint.com/indore/venues/coffeenism""');
    expect(listedSnippet("https://x", 'A "B" & C')).toBe('<a href="https://x" title="A &quot;B&quot; &amp; C on Pick the Joint">Listed on Pick the Joint</a>');
  });
});

describe("description writer guards", () => {
  it("passes no invented end time and drops sentences about missing facts", async () => {
    const { dropMissingFactSentences, facts } = await import("../src/lib/pipeline/write");
    const base = { id: 1, title: "Ger", start_time_known: false, price_text: null, is_free: null, has_booking: false, venue: "Rajwada",
      area: null, city: "Indore", timezone: "Asia/Kolkata", category: "festivals", performers: null, organisers: null };
    const day = facts({ ...base, starts_at: new Date("2027-03-26T18:30:00Z"), ends_at: new Date("2027-03-27T18:29:00Z") });
    expect(day).not.toContain("Ends");
    const run = facts({ ...base, starts_at: new Date("2027-01-02T18:30:00Z"), ends_at: new Date("2027-01-05T18:29:00Z") });
    expect(run).toContain("Ends: Tuesday, 5 January 2027");
    expect(run).not.toContain("11:59");
    const timed = facts({ ...base, start_time_known: true, starts_at: new Date("2027-01-03T13:30:00Z"), ends_at: new Date("2027-01-03T16:30:00Z") });
    expect(timed).toContain("Ends: 10:00 PM");
    expect(dropMissingFactSentences("Ger is on Saturday. No ticket price has been provided. The start time is yet to be announced. Entry is free."))
      .toBe("Ger is on Saturday. Entry is free.");
  });
});
