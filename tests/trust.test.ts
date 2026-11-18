import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SITE_URL = "https://pickthejoint.com";
  process.env.APIFY_ACTOR_ID = "apify/instagram-scraper";
  process.env.APIFY_IG_POSTS_FALLBACK_ACTOR_ID = "apify/instagram-post-scraper";
  process.env.SITE_PROFILES = "https://www.instagram.com/pickthejoint/, not-a-url";
  delete process.env.RESEND_API_KEY;
});

import { freshDb } from "./helpers";
import { seedDemo } from "./fixtures";
import { seed } from "../db/seed";
import { importHandles } from "../scripts/import-handles";
import { sendAlert, unexpectedlyEmpty } from "../src/lib/alerts";
import { crawlCheck } from "../src/lib/crawl-check";
import { closePool } from "../src/lib/db";
import { calendar, jsonFeed } from "../src/lib/feeds";
import { changedPaths, pingIndexNow } from "../src/lib/indexnow";
import type { ActorRunResult, ApifyClient } from "../src/lib/pipeline/apify";
import { geocodeVenues, matchConfidence } from "../src/lib/pipeline/geocode";
import { scrapeInstagram } from "../src/lib/pipeline/scrape";
import { localDate } from "../src/lib/pipeline/text";
import { getCity, getEvent, listEvents } from "../src/lib/queries";
import { eventLd, pageLd, priceFromText, siteLd } from "../src/lib/schema";
import { aiCrawlers } from "../src/config";

let pool: Pool;
const NOW = new Date();
const today = localDate(NOW, "Asia/Kolkata");

beforeAll(async () => {
  pool = await freshDb();
  await seed(pool);
  await seedDemo(pool, NOW);
});
afterAll(async () => { await closePool(); await pool.end(); });

const respond = (status: number, body: unknown = "", headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

describe("event markup and entity graph", () => {
  it("gives the event, venue, performer and organiser stable ids, and three image shapes", async () => {
    const e = (await getEvent("indore", `aria-quartet-live-${today}`))!;
    const base = `https://pickthejoint.com/indore/events/aria-quartet-live-${today}`;
    expect(eventLd(e)).toMatchObject({
      "@id": `${base}#event`,
      image: [`${base}/image/1x1`, `${base}/image/4x3`, `${base}/image/16x9`],
      location: { "@id": "https://pickthejoint.com/indore/venues/the-blue-room#venue" },
      performer: [{ "@id": "https://pickthejoint.com/artists/aria-quartet#artist" }],
      organizer: [{ "@id": "https://pickthejoint.com/organisers/indore-jazz-club#organiser", name: "Indore Jazz Club", url: "https://pickthejoint.com/organisers/indore-jazz-club" }],
      offers: { price: 499, priceCurrency: "INR", availability: "https://schema.org/InStock", url: "https://tickets.example/aria" },
    });
    expect(e.ends_at).not.toBeNull();
    expect(eventLd(e).endDate).toMatch(/T22:30:00\+05:30$/);
  });

  it("reads a price only when the text states an amount", () => {
    expect(priceFromText("₹499 onwards")).toBe(499);
    expect(priceFromText("Cover ₹1,000, fully redeemable")).toBe(1000);
    expect(priceFromText("Rs. 300")).toBe(300);
    expect(priceFromText("Entry by invitation")).toBeUndefined();
    expect(priceFromText(null)).toBeUndefined();
  });

  it("describes the page with the same modified time it shows, and the site as one organisation", async () => {
    const e = (await getEvent("indore", `aria-quartet-live-${today}`))!;
    expect(pageLd("/indore/events/x", e.title, e.updated_at, "https://pickthejoint.com/indore/events/x#event")).toMatchObject({
      "@type": "WebPage", dateModified: e.updated_at.toISOString(), mainEntity: { "@id": "https://pickthejoint.com/indore/events/x#event" },
      publisher: { "@id": "https://pickthejoint.com/#organization" },
    });
    const [org, web] = siteLd();
    expect(org).toMatchObject({ "@type": "Organization", "@id": "https://pickthejoint.com/#organization", sameAs: ["https://www.instagram.com/pickthejoint/"] });
    expect(web).toMatchObject({ "@type": "WebSite", publisher: { "@id": "https://pickthejoint.com/#organization" } });
  });
});

describe("calendar and feeds", () => {
  it("writes a valid calendar file: UTC times, all-day when no time was announced, cancelled status, folded lines", async () => {
    const city = (await getCity("indore"))!;
    const ics = calendar(await listEvents({ cityId: city.id }), "Events in Indore", NOW);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(5);
    expect(ics).toMatch(/DTSTART:\d{8}T143000Z\r\nDTEND:\d{8}T170000Z\r\nSUMMARY:Aria Quartet Live/); // 8:00 PM to 10:30 PM IST
    expect(ics).toMatch(/DTSTART;VALUE=DATE:\d{8}\r\nDTEND;VALUE=DATE:\d{8}\r\nSUMMARY:Block Printing Workshop/);
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("LOCATION:The Blue Room\\, Vijay Nagar");
    expect(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
  });

  it("lists upcoming events in the JSON feed", async () => {
    const city = (await getCity("indore"))!;
    const feed = jsonFeed(city, await listEvents({ cityId: city.id }), NOW);
    expect(feed).toMatchObject({ title: "Upcoming events in Indore", feed_url: "https://pickthejoint.com/indore/feed.json" });
    expect(feed.events).toHaveLength(5);
    expect(feed.events[0]).toMatchObject({
      title: "Aria Quartet Live", url: `https://pickthejoint.com/indore/events/aria-quartet-live-${today}`,
      venue: { name: "The Blue Room", url: "https://pickthejoint.com/indore/venues/the-blue-room" }, price: "₹499 onwards", is_free: false,
    });
  });
});

describe("IndexNow", () => {
  it("announces changed event pages with their venue, people and hub pages, in one batch, once", async () => {
    const paths = await changedPaths(pool, null);
    expect(paths).toEqual(expect.arrayContaining([
      `/indore/events/aria-quartet-live-${today}`, "/indore", "/indore/today", "/indore/this-weekend", "/indore/venues/the-blue-room",
      "/indore/area/vijay-nagar", "/indore/music", "/artists/aria-quartet", "/organisers/indore-jazz-club", "/series/winter-arts-week",
    ]));
    expect(paths.some((p) => p.includes("secret-gig"))).toBe(false);

    const calls: { url: string; body: { host: string; key: string; keyLocation: string; urlList: string[] } }[] = [];
    const ok = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return respond(202); }) as unknown as typeof fetch;

    expect(await pingIndexNow(pool, { fetchFn: ok })).toMatchObject({ urls: 0, status: expect.stringContaining("off") }); // not switched on
    const failed = await pingIndexNow(pool, { force: true, fetchFn: (async () => respond(403, "key not valid")) as unknown as typeof fetch });
    expect(failed.status).toMatch(/^failed: IndexNow answered 403/);

    const sent = await pingIndexNow(pool, { force: true, fetchFn: ok });
    expect(sent).toMatchObject({ urls: paths.length, status: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.indexnow.org/indexnow");
    expect(calls[0].body).toMatchObject({ host: "pickthejoint.com", keyLocation: `https://pickthejoint.com/${calls[0].body.key}.txt` });
    expect(calls[0].body.urlList).toContain(`https://pickthejoint.com/indore/events/aria-quartet-live-${today}`);

    expect(await pingIndexNow(pool, { force: true, fetchFn: ok })).toMatchObject({ urls: 0, status: "nothing changed" });
    // An event that comes down is announced too.
    await pool.query("UPDATE events SET is_published = false, updated_at = now() + interval '1 second' WHERE title = 'Open Mic Night'");
    const after = await pingIndexNow(pool, { force: true, dryRun: true, fetchFn: ok });
    expect(after.status).toBe("dry run: not sent");
    expect(after.urls).toBeGreaterThan(0);
    await pool.query("UPDATE events SET is_published = true WHERE title = 'Open Mic Night'");
  });
});

describe("crawl access check", () => {
  it("reports 200 for every crawler when nothing is blocked", async () => {
    const seen: string[] = [];
    const report = await crawlCheck(pool, { fetchFn: (async (_u: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)["User-Agent"]);
      return respond(200, '<html><script type="application/ld+json">{}</script></html>');
    }) as unknown as typeof fetch });
    expect(report.pages).toHaveLength(5);
    expect(report).toMatchObject({ ok: true, agents: aiCrawlers.length, requests: aiCrawlers.length * 5, blocked: [] });
    expect(seen.some((ua) => ua.includes("GPTBot/1.0"))).toBe(true);
    expect(Object.values(report.byAgent).every((v) => v === "200 on every page")).toBe(true);
  });

  it("flags a 403 and a challenge page", async () => {
    const report = await crawlCheck(pool, { fetchFn: (async (_u: string, init: RequestInit) => {
      const ua = (init.headers as Record<string, string>)["User-Agent"];
      if (ua.includes("GPTBot")) return respond(403, "Forbidden");
      if (ua.includes("ClaudeBot")) return respond(200, "<html><title>Just a moment...</title></html>");
      return respond(200, '<html><script type="application/ld+json">{}</script></html>');
    }) as unknown as typeof fetch });
    expect(report.ok).toBe(false);
    expect(new Set(report.blocked.map((b) => b.agent))).toEqual(new Set(["GPTBot", "ClaudeBot"]));
    expect(report.byAgent.GPTBot).toMatch(/^403 /);
    expect(report.byAgent.ClaudeBot).toContain("challenge page");
    expect(report.byAgent.PerplexityBot).toBe("200 on every page");
  });
});

describe("venue geocoding", () => {
  it("scores a result by whether it is this venue, not just this city", () => {
    const hit = { lat: "22.75", lon: "75.89", name: "Laugh Cottage", display_name: "Laugh Cottage, Old Palasia, Indore, Madhya Pradesh, India", addresstype: "amenity" };
    expect(matchConfidence("Laugh Cottage", "Indore", hit)).toBeGreaterThanOrEqual(0.9);
    expect(matchConfidence("Laugh Cottage", "Indore", { ...hit, name: "Old Palasia", addresstype: "suburb" })).toBeLessThan(0.5);
    expect(matchConfidence("Laugh Cottage", "Indore", { ...hit, display_name: "Laugh Cottage, Pune, Maharashtra, India" })).toBe(0);
  });

  it("saves a confident match, queues a doubtful one for review, and tries each venue once", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      urls.push(url);
      expect((init.headers as Record<string, string>)["User-Agent"]).toContain("PickTheJointBot");
      if (url.includes("Laugh")) return respond(200, [{ lat: "22.7201", lon: "75.8801", name: "Laugh Cottage", display_name: "Laugh Cottage, Old Palasia, Indore, Madhya Pradesh, India", addresstype: "amenity" }]);
      return respond(200, [{ lat: "22.71", lon: "75.86", name: "City Sports Ground", display_name: "City Sports Ground, Race Course Road, Indore, Madhya Pradesh, India", addresstype: "leisure" }]);
    }) as unknown as typeof fetch;

    const report = await geocodeVenues(pool, { fetchFn, delayMs: 0 });
    expect(report).toMatchObject({ tried: 2, located: 1, queued: 1, errors: [] }); // The Blue Room already has coordinates
    expect((await pool.query("SELECT lat, lng, geocode_confidence FROM venues WHERE slug = 'laugh-cottage'")).rows[0]).toMatchObject({ lat: 22.7201, lng: 75.8801 });
    expect((await pool.query("SELECT lat FROM venues WHERE slug = 'city-grounds'")).rows[0].lat).toBeNull();
    const { rows } = await pool.query("SELECT item_type, reason FROM review_queue WHERE item_type = 'venue_geocode'");
    expect(rows).toEqual([{ item_type: "venue_geocode", reason: "geocoder match is not confident enough to publish" }]);
    expect((await geocodeVenues(pool, { fetchFn, delayMs: 0 })).tried).toBe(0);
    expect(urls).toHaveLength(2);
  });
});

describe("alerts and fallback", () => {
  it("logs instead of sending when Resend is not configured, and never throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = vi.fn();
    expect(await sendAlert("The ingest job failed", "boom", fetchFn as unknown as typeof fetch)).toMatchObject({ sent: false });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toContain("NOT SENT");
    error.mockRestore();
  });

  it("treats a run with no events as unexpected only when recent runs usually found some", () => {
    expect(unexpectedlyEmpty(0, [4, 2, 0, 5])).toBe(true);
    expect(unexpectedlyEmpty(0, [0, 0, 1, 0])).toBe(false);
    expect(unexpectedlyEmpty(0, [3, 2])).toBe(false); // too little history to judge
    expect(unexpectedlyEmpty(1, [4, 2, 3])).toBe(false);
  });

  it("switches to the fallback actor after the main one fails twice in a row", async () => {
    await importHandles(pool, "handle,type,city,tier\nthe_blue_room,venue,indore,A\n");
    const calls: string[] = [];
    const apify: ApifyClient = {
      async runActor(actorId: string): Promise<ActorRunResult> {
        calls.push(actorId);
        if (actorId === "apify/instagram-scraper") throw new Error("actor run FAILED");
        return { runId: "r", status: "SUCCEEDED", items: [{ shortCode: "F1", ownerUsername: "the_blue_room", caption: "x", type: "Image", timestamp: NOW.toISOString() }] };
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = await scrapeInstagram(pool, apify, { jobName: "test", now: NOW });
    warn.mockRestore();
    expect(calls).toEqual(["apify/instagram-scraper", "apify/instagram-scraper", "apify/instagram-post-scraper"]);
    expect(report).toMatchObject({ fallbackRuns: 1, postsNew: 1, errors: [] });
  });
});
