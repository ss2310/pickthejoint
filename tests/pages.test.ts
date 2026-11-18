import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SITE_URL = "https://pickthejoint.com";
});

import { freshDb } from "./helpers";
import { seedDemo } from "./fixtures";
import { seed } from "../db/seed";
import { closePool } from "../src/lib/db";
import { hubFaqs, hubSummary, resolveHub, weekendRange } from "../src/lib/hubs";
import { isoWithOffset } from "../src/lib/format";
import { getArtist, getCity, getEvent, getVenue, listCategories, listEvents, type City } from "../src/lib/queries";
import { artistLd, breadcrumbLd, eventLd, faqLd, itemListLd, venueLd, type Ld } from "../src/lib/schema";
import { indexXml, sitemapEntries, urlsetXml } from "../src/lib/sitemap";
import { crawlerToken } from "../src/middleware";
import { GET as robots } from "../src/app/robots.txt/route";
import { localDate } from "../src/lib/pipeline/text";

let pool: Pool;
let city: City;
const NOW = new Date();
const today = localDate(NOW, "Asia/Kolkata");

beforeAll(async () => {
  pool = await freshDb();
  await seed(pool);
  await seedDemo(pool, NOW);
  city = (await getCity("indore"))!;
});
afterAll(async () => { await closePool(); await pool.end(); });

/**
 * Properties a type must carry: schema.org's own expectations plus the ones
 * Google lists as required for its Event, Breadcrumb and FAQ results.
 */
const REQUIRED: Record<string, string[]> = {
  Event: ["name", "startDate", "location", "eventStatus", "eventAttendanceMode", "url"],
  Place: ["name", "address"],
  PostalAddress: ["addressLocality", "addressCountry"],
  Offer: ["url", "priceCurrency", "availability"],
  BreadcrumbList: ["itemListElement"],
  ListItem: ["position", "name"],
  ItemList: ["itemListElement", "numberOfItems"],
  FAQPage: ["mainEntity"],
  Question: ["name", "acceptedAnswer"],
  Answer: ["text"],
  Person: ["name", "url"], MusicGroup: ["name", "url"], Organization: ["name", "url"],
};
const EVENT_TYPES = ["MusicEvent", "ComedyEvent", "TheaterEvent", "EducationEvent", "Festival", "SocialEvent"];

function problems(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => problems(n, `${path}[${i}]`));
  if (node === null || typeof node !== "object") return [];
  const obj = node as Ld;
  const out: string[] = [];
  const type = EVENT_TYPES.includes(String(obj["@type"])) ? "Event" : String(obj["@type"] ?? "");
  for (const key of REQUIRED[type] ?? []) {
    const v = obj[key];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) out.push(`${path}: ${obj["@type"]} is missing ${key}`);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") out.push(`${path}.${k} is empty`);
    out.push(...problems(v, `${path}.${k}`));
  }
  return out;
}

describe("listings queries", () => {
  it("returns only published events, upcoming by default, soonest first", async () => {
    const events = await listEvents({ cityId: city.id });
    expect(events.map((e) => e.title)).toEqual(["Aria Quartet Live", "Open Mic Night", "Saturday Social", "Block Printing Workshop", "Winter Arts Week"]);
    expect(events.some((e) => e.title === "Secret Gig")).toBe(false);
  });

  it("filters by local date, category, area and price", async () => {
    expect((await listEvents({ cityId: city.id, from: today, to: today })).map((e) => e.title)).toEqual(["Aria Quartet Live"]);
    const comedy = (await listCategories()).find((c) => c.slug === "comedy")!;
    expect((await listEvents({ cityId: city.id, categoryId: comedy.id })).map((e) => e.title)).toEqual(["Open Mic Night"]);
    expect((await listEvents({ cityId: city.id, free: true })).map((e) => e.title)).toEqual(["Open Mic Night", "Winter Arts Week"]);
    expect((await listEvents({ cityId: city.id, free: false })).every((e) => !e.is_free && e.price_text)).toBe(true);
  });

  it("keeps a multi-day event in range on each of its days, and past events in the archive", async () => {
    const day6 = new Date(Date.parse(`${today}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    expect((await listEvents({ cityId: city.id, from: day6, to: day6 })).map((e) => e.title)).toEqual(["Winter Arts Week"]);
    expect((await listEvents({ cityId: city.id, when: "past" })).map((e) => e.title)).toEqual(["The Last Letter"]);
  });

  it("does not serve an unpublished event page", async () => {
    const secret = await pool.query<{ slug: string }>("SELECT slug FROM events WHERE title = 'Secret Gig'");
    expect(await getEvent("indore", secret.rows[0].slug)).toBeNull();
  });
});

describe("hubs", () => {
  it("works out the weekend from any weekday", () => {
    expect(weekendRange("2026-11-18")).toEqual({ from: "2026-11-20", to: "2026-11-22" }); // Wednesday
    expect(weekendRange("2026-11-21")).toEqual({ from: "2026-11-21", to: "2026-11-22" }); // Saturday
    expect(weekendRange("2026-11-22")).toEqual({ from: "2026-11-22", to: "2026-11-22" }); // Sunday
  });

  it("writes a two-sentence summary from the listings, and says so plainly when there are none", async () => {
    const categories = await listCategories();
    const todayHub = resolveHub(city, "today", categories, NOW)!;
    const summary = hubSummary(todayHub, city, await listEvents(todayHub.filter));
    expect(summary).toMatch(/^1 event is listed in Indore today\. It is Aria Quartet Live at The Blue Room \(.+\)\.$/);

    const dance = resolveHub(city, "dance", categories, NOW)!;
    const next = (await listEvents({ cityId: city.id, limit: 1 }))[0];
    expect(hubSummary(dance, city, [], next)).toMatch(/^No dance events are currently listed in Indore for the coming weeks\. The next listed event is Aria Quartet Live/);
    expect(resolveHub(city, "not-a-category", categories, NOW)).toBeNull();
  });

  it("answers its FAQ from the listings, including a Hinglish question, and leaves out cancelled events", async () => {
    const hub = resolveHub(city, undefined, await listCategories(), NOW)!;
    const faqs = hubFaqs(hub, city, await listEvents(hub.filter));
    expect(faqs.map((f) => f.question)).toContain("Indore mein is hafte kya events hain?");
    expect(faqs[0].answer).toContain("Aria Quartet Live at The Blue Room");
    expect(faqs[0].answer).not.toContain("Saturday Social");
    expect(faqs.find((f) => f.question.includes("free"))!.answer).toContain("Open Mic Night");
    expect(problems(faqLd(faqs))).toEqual([]);
  });
});

describe("structured data", () => {
  it("builds a complete Event with place, performer, organiser and offer", async () => {
    const e = (await getEvent("indore", `aria-quartet-live-${today}`))!;
    const ld = eventLd(e);
    expect(problems(ld)).toEqual([]);
    expect(ld).toMatchObject({
      "@type": "MusicEvent", name: "Aria Quartet Live", startDate: isoWithOffset(e.starts_at, "Asia/Kolkata"),
      eventStatus: "https://schema.org/EventScheduled", url: `https://pickthejoint.com/indore/events/aria-quartet-live-${today}`,
      location: { "@type": "Place", name: "The Blue Room", address: { addressLocality: "Indore", addressRegion: "Madhya Pradesh", addressCountry: "IN" },
        geo: { latitude: 22.7533, longitude: 75.8937 } },
      performer: [{ "@type": "MusicGroup", name: "Aria Quartet" }], organizer: [{ "@type": "Organization", name: "Indore Jazz Club" }],
      offers: { url: "https://tickets.example/aria", priceCurrency: "INR" },
    });
    expect(String(ld.startDate)).toMatch(/T20:00:00\+05:30$/);
  });

  it("marks cancelled events, gives a date-only start when no time was announced, and prices free events at 0", async () => {
    const all = await listEvents({ cityId: city.id });
    const bySlug = async (title: string) => (await getEvent("indore", all.find((e) => e.title === title)!.slug))!;
    const cancelled = eventLd(await bySlug("Saturday Social"));
    expect(cancelled.eventStatus).toBe("https://schema.org/EventCancelled");
    const workshop = eventLd(await bySlug("Block Printing Workshop"));
    expect(String(workshop.startDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // No booking link, but a stated price: the offer points at our own page.
    expect(workshop.offers).toMatchObject({ price: 1200, priceCurrency: "INR", url: String(workshop.url) });
    const free = eventLd(await bySlug("Open Mic Night"));
    expect(free.offers).toMatchObject({ price: 0, priceCurrency: "INR" });
    for (const ld of [cancelled, workshop, free]) expect(problems(ld)).toEqual([]);
  });

  it("builds valid Place, MusicGroup, BreadcrumbList and ItemList data", async () => {
    const venue = venueLd((await getVenue("indore", "the-blue-room"))!);
    expect(venue).toMatchObject({ "@type": "Place", maximumAttendeeCapacity: 180, sameAs: ["https://www.instagram.com/the_blue_room_demo/"] });
    const artist = artistLd((await getArtist("aria-quartet"))!);
    expect(artist).toMatchObject({ "@type": "MusicGroup", genre: "Jazz" });
    const crumbs = breadcrumbLd([{ name: "Indore", path: "/indore" }, { name: "Music", path: "/indore/music" }]);
    const list = itemListLd("Events in Indore", await listEvents({ cityId: city.id }));
    for (const ld of [venue, artist, crumbs, list]) expect(problems(ld)).toEqual([]);
    expect(list.numberOfItems).toBe(5);
  });
});

describe("crawling", () => {
  it("lists published pages in sitemaps with last-modified dates, and nothing unpublished or empty", async () => {
    const events = await sitemapEntries("events");
    expect(events).toHaveLength(6);
    expect(events.some((e) => e.path.includes("secret-gig"))).toBe(false);
    expect(events.every((e) => e.lastmod instanceof Date)).toBe(true);

    const hubs = (await sitemapEntries("hubs", NOW)).map((e) => e.path);
    expect(hubs).toEqual(expect.arrayContaining(["/indore", "/indore/today", "/indore/this-weekend", "/indore/this-week", "/indore/past", "/indore/comedy", "/indore/area/vijay-nagar"]));
    expect(hubs).not.toContain("/indore/dance"); // nothing listed there
    expect((await sitemapEntries("hubs", NOW)).every((e) => e.lastmod <= new Date(Date.now() + 1000))).toBe(true);

    // Dev Sharma has no bio but two events; Aria Quartet has a bio.
    expect((await sitemapEntries("artists")).map((e) => e.path).sort()).toEqual(["/artists/aria-quartet", "/artists/dev-sharma"]);
    expect((await sitemapEntries("venues")).map((e) => e.path)).toContain("/indore/venues/the-blue-room");

    const xml = urlsetXml(events);
    expect(xml).toContain(`<loc>https://pickthejoint.com${events[0].path}</loc>`);
    expect(xml).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T/);
    expect(indexXml([{ path: "/sitemaps/events.xml", lastmod: NOW }])).toContain("<sitemap><loc>https://pickthejoint.com/sitemaps/events.xml</loc>");
  });

  it("robots.txt allows everything and names the AI crawlers", async () => {
    const text = await robots().text();
    expect(text).toMatch(/^User-agent: \*\nAllow: \/\n/);
    for (const bot of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "Bingbot"]) {
      expect(text).toContain(`User-agent: ${bot}\nAllow: /`);
    }
    expect(text).not.toMatch(/Disallow/);
    expect(text).toContain("Sitemap: https://pickthejoint.com/sitemap.xml");
  });

  it("recognises AI crawlers by user agent and ignores ordinary browsers", () => {
    expect(crawlerToken("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)")).toBe("GPTBot");
    expect(crawlerToken("Mozilla/5.0 (compatible; Applebot-Extended/1.0)")).toBe("Applebot-Extended");
    expect(crawlerToken("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36")).toBeNull();
    expect(crawlerToken(null)).toBeNull();
  });
});
