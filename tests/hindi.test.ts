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
import { dateParts, longDay } from "../src/lib/format";
import { categoryName, hubFaqs, hubSummary, resolveHub } from "../src/lib/hubs";
import { changedPaths } from "../src/lib/indexnow";
import { alternates, localePath, messages } from "../src/lib/locale";
import type { LlmClient, LlmRequest, LlmResult, LlmRunOptions } from "../src/lib/pipeline/llm";
import { acceptable, pendingItems, translatePending } from "../src/lib/pipeline/translate";
import { getArtist, getCity, getEvent, getVenue, listCategories, listEvents } from "../src/lib/queries";
import { urlsetXml } from "../src/lib/sitemap";
import { route } from "../src/middleware";
import { en } from "../src/locales/en";
import { hi } from "../src/locales/hi";

let pool: Pool;
const NOW = new Date();
beforeAll(async () => { pool = await freshDb(); await seed(pool); await seedDemo(pool, NOW); });
afterAll(async () => { await closePool(); await pool.end(); });

const DEVANAGARI = /[ऀ-ॿ]/;

/** Stands in for the translator: names get a marker, texts get Hindi words plus the settled names it was given. */
class FakeTranslator implements LlmClient {
  prompts: string[] = [];
  dryRuns = 0;
  constructor(private readonly mangle: (source: string, n: number) => string | null = (s) => s) {}
  async run<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    expect(opts.subBudget).toBe("translation");
    if (opts.dryRun) { this.dryRuns += requests.length; return []; }
    return requests.map((req) => {
      const text = req.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      this.prompts.push(text);
      const items = [...text.matchAll(/^(\d+)\. \[(NAME|TEXT): [^\]]+\] (.*)$/gm)].flatMap(([, n, kind, source]) => {
        const out = this.mangle(kind === "NAME" ? `नाम(${source})` : `हिंदी: ${source}`, Number(n));
        return out === null ? [] : [{ n: Number(n), text: out }];
      });
      return { id: req.id, ok: true, data: req.schema.parse({ items }), model: "fake", usd: 0.01, inputTokens: 10, outputTokens: 10 };
    });
  }
}

describe("addresses", () => {
  it("serves English at the plain paths and Hindi under /hi/", () => {
    expect(route("/indore/today")).toEqual({ action: "rewrite", to: "/en/indore/today" });
    expect(route("/")).toEqual({ action: "rewrite", to: "/en" });
    expect(route("/hi/indore/today")).toEqual({ action: "next" });
    expect(route("/hi")).toEqual({ action: "next" });
    // No page has two English addresses, and English-only pages have no Hindi one.
    expect(route("/en/indore")).toEqual({ action: "redirect", to: "/indore" });
    expect(route("/hi/about")).toEqual({ action: "redirect", to: "/about" });
    // Files and sitemaps have no language.
    for (const p of ["/robots.txt", "/sitemap.xml", "/sitemaps/events.xml", "/d632b94e7b1106de3376c2c8b5b6b82b.txt"]) {
      expect(route(p)).toEqual({ action: "next" });
    }
    expect(route("/indore/feed.ics")).toEqual({ action: "rewrite", to: "/en/indore/feed.ics" });
    // The admin area and the API are English only and outside the language routing; the submit page has both languages.
    for (const p of ["/admin", "/admin/queue", "/api/inbound/poster-email"]) expect(route(p)).toEqual({ action: "next" });
    expect(route("/submit")).toEqual({ action: "rewrite", to: "/en/submit" });
    expect(route("/hi/submit")).toEqual({ action: "next" });
  });

  it("links the two versions of a page to each other", () => {
    expect(localePath("/indore/comedy", "hi")).toBe("/hi/indore/comedy");
    expect(localePath("/indore/comedy", "en")).toBe("/indore/comedy");
    expect(localePath("/", "hi")).toBe("/hi");
    expect(alternates("/indore", {}, "hi")).toEqual({
      canonical: "/hi/indore", languages: { "x-default": "/indore", "en-IN": "/indore", "hi-IN": "/hi/indore" },
    });
    expect(alternates("/about", { onlyDefault: true })).toEqual({ canonical: "/about" });
  });

  it("lists both versions in the sitemap, each pointing at the other", () => {
    const xml = urlsetXml([{ path: "/indore", lastmod: NOW }, { path: "/about", lastmod: NOW, oneLanguage: true }]);
    expect(xml).toContain("<loc>https://pickthejoint.com/indore</loc>");
    expect(xml).toContain("<loc>https://pickthejoint.com/hi/indore</loc>");
    expect(xml.match(/hreflang="hi-IN" href="https:\/\/pickthejoint\.com\/hi\/indore"/g)).toHaveLength(2);
    expect(xml).toContain('hreflang="x-default" href="https://pickthejoint.com/indore"');
    expect(xml).not.toContain("/hi/about");
  });

  it("announces both versions of a changed page", async () => {
    const paths = await changedPaths(pool, null);
    expect(paths).toContain("/indore");
    expect(paths).toContain("/hi/indore");
  });
});

describe("interface text", () => {
  it("has the same entries in both languages", () => {
    const keys = (o: object, prefix = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !["categories", "factLabels"].includes(k) ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
    expect(keys(hi).sort()).toEqual(keys(en).sort());
    expect(messages("hi").site.skip).toMatch(DEVANAGARI);
  });

  it("writes hub headings, summaries and questions in Hindi", async () => {
    const city = (await getCity("indore", "hi"))!;
    const hub = resolveHub(city, undefined, await listCategories("hi"), NOW, undefined, "hi")!;
    expect(hub.heading).toBe("Indore में इवेंट"); // the city name is still English until it is translated
    const events = await listEvents(hub.filter, "hi");
    const summary = hubSummary(hub, city, events, undefined, "hi");
    expect(summary).toMatch(/लिस्टेड (है|हैं)।/);
    expect(summary.split("।").filter((s) => s.trim()).length).toBe(2);
    const faqs = hubFaqs(hub, city, events, "hi");
    expect(faqs.every((f) => DEVANAGARI.test(f.question) && DEVANAGARI.test(f.answer))).toBe(true);
    const comedy = resolveHub(city, "comedy", await listCategories("hi"), NOW, undefined, "hi")!;
    expect(comedy.heading).toBe("Indore में कॉमेडी इवेंट");
    expect(categoryName({ slug: "music", name: "Music" }, "hi")).toBe("म्यूज़िक");
    expect(categoryName({ slug: "something-new", name: "Something new" }, "hi")).toBe("Something new");
  });

  it("writes dates with Hindi names and ordinary digits", () => {
    const d = dateParts(new Date("2026-11-21T14:30:00Z"), "Asia/Kolkata", "hi");
    expect(d.day).toBe("21");
    expect(d.weekday).toMatch(DEVANAGARI);
    expect(d.month).toMatch(DEVANAGARI);
    expect(longDay("2026-11-21", "hi")).toContain("2026");
    expect(dateParts(new Date("2026-11-21T14:30:00Z"), "Asia/Kolkata", "en")).toEqual({ weekday: "Sat", day: "21", month: "Nov" });
  });
});

describe("translation", () => {
  it("shows English on a Hindi page while nothing is translated", async () => {
    const [first] = await listEvents({ cityId: (await getCity("indore"))!.id }, "hi");
    expect(first.title).toBe((await listEvents({ cityId: first.city_id }, "en"))[0].title);
    expect((await getVenue("indore", "the-blue-room", "hi"))!.name).toBe("The Blue Room");
  });

  it("estimates on a dry run without sending or storing anything", async () => {
    const llm = new FakeTranslator();
    const report = await translatePending(pool, llm, { jobName: "test", dryRun: true });
    expect(report.pending).toBeGreaterThan(20);
    expect(report.translated).toBe(0);
    expect(report.estimatedUsd).toBeGreaterThan(0);
    expect(llm.dryRuns).toBe(report.requests);
    expect((await pool.query("SELECT count(*)::int AS n FROM translations")).rows[0].n).toBe(0);
  });

  it("translates names first, then texts using the settled names, and stores them", async () => {
    const llm = new FakeTranslator();
    const report = await translatePending(pool, llm, { jobName: "test" });
    expect(report.failed).toBe(0);
    expect(report.translated).toBe(report.pending);
    expect(report.byType.event).toBeGreaterThan(0);

    // A description that mentions the venue was given the venue's settled spelling.
    const withGlossary = llm.prompts.find((p) => p.includes("Names already settled") && p.includes("The Blue Room = नाम(The Blue Room)"));
    expect(withGlossary).toBeDefined();

    const e = (await listEvents({ cityId: (await getCity("indore"))!.id }, "hi"))[0];
    expect(e.title).toMatch(/^नाम\(/);
    expect(e.venue_name).toMatch(/^नाम\(/);
    const detail = (await getEvent("indore", e.slug, "hi"))!;
    expect(detail.description).toMatch(/^हिंदी: /);
    expect(detail.city_name).toBe("नाम(Indore)");
    expect((await getEvent("indore", e.slug, "en"))!.description).not.toMatch(DEVANAGARI);
    expect((await getVenue("indore", "the-blue-room", "hi"))!.parking).toMatch(/^हिंदी: /);
    expect((await getArtist("aria-quartet", "hi"))!.bio).toMatch(/^हिंदी: /);
    // Unpublished events are not translated.
    const hidden = await pool.query("SELECT count(*)::int AS n FROM translations t JOIN events e ON e.id = t.entity_id WHERE t.entity_type = 'event' AND NOT e.is_published");
    expect(hidden.rows[0].n).toBe(0);
  });

  it("does nothing on a second run, and re-translates only what changed", async () => {
    expect(await pendingItems(pool)).toEqual([]);
    const llm = new FakeTranslator();
    expect((await translatePending(pool, llm, { jobName: "test" })).requests).toBe(0);

    await pool.query("UPDATE venues SET parking = 'Street parking only.', capacity = 200 WHERE slug = 'the-blue-room'");
    const pending = await pendingItems(pool);
    expect(pending.map((p) => `${p.type}:${p.field}`)).toEqual(["venue:parking"]);
    await translatePending(pool, llm, { jobName: "test" });
    expect((await getVenue("indore", "the-blue-room", "hi"))!.parking).toBe("हिंदी: Street parking only.");
  });

  it("never shows a translation for a fact that has been removed", async () => {
    await pool.query("UPDATE venues SET parking = NULL WHERE slug = 'the-blue-room'");
    expect((await getVenue("indore", "the-blue-room", "hi"))!.parking).toBeNull();
  });

  it("leaves text in English when the translation is missing or not Hindi", async () => {
    await pool.query("UPDATE venues SET how_to_reach = 'Opposite the old clock tower.', landmarks = 'Next to City Mall.' WHERE slug = 'the-blue-room'");
    // The translator skips the first item and answers the second in English.
    const llm = new FakeTranslator((s, n) => (n === 1 ? null : "Next to City Mall."));
    const report = await translatePending(pool, llm, { jobName: "test" });
    expect(report).toMatchObject({ translated: 0, failed: 2 });
    const v = (await getVenue("indore", "the-blue-room", "hi"))!;
    expect(v.how_to_reach).toBe("Opposite the old clock tower.");
    expect(v.landmarks).toBe("Next to City Mall.");
    expect((await pendingItems(pool)).length).toBe(2);
  });

  it("accepts short lines without words, and names kept in Latin letters", () => {
    const item = (type: string, field: string, text: string) => ({ type, id: 1, field, text, hash: "" });
    expect(acceptable(item("event", "price_text", "₹499"), "₹499")).toBe(true);
    expect(acceptable(item("artist", "name", "U4ria"), "U4ria")).toBe(true);
    expect(acceptable(item("event", "description", "A long evening of music."), "A long evening of music.")).toBe(false);
    expect(acceptable(item("event", "description", "Music."), "")).toBe(false);
    // A half-transliterated word is rejected, for names too.
    expect(acceptable(item("event", "title", "In Case We Forget India Tour"), "इन केस वी फॉरगेट इंडिया टour")).toBe(false);
    expect(acceptable(item("event", "title", "Esani Dey Live at MARQ"), "एसानी डे लाइव एट MARQ")).toBe(true);
  });
});
