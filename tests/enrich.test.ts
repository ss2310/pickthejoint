import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SITE_URL = "https://pickthejoint.com";
});

import { freshDb } from "./helpers";
import { seedDemo } from "./fixtures";
import { seed } from "../db/seed";
import { closePool } from "../src/lib/db";
import { enrichment } from "../src/config";
import { changedPaths } from "../src/lib/indexnow";
import { getArtist, getVenue } from "../src/lib/queries";
import type { ActorRunResult, ApifyClient } from "../src/lib/pipeline/apify";
import {
  assess, enrichEntities, isPrivate, normaliseProfile, pickTargets, researchPrompt, researchSystem, type Structured,
} from "../src/lib/pipeline/enrich";
import { addressConfidence } from "../src/lib/pipeline/geocode";
import type { LlmClient, LlmRequest, LlmResult, LlmRunOptions } from "../src/lib/pipeline/llm";
import { collectRetrieved, finalNotes, urlKey, type ResearchClient, type ResearchOptions, type ResearchRequest, type ResearchResult, type RetrievedPage } from "../src/lib/pipeline/research";

let pool: Pool;
beforeAll(async () => { pool = await freshDb(); await seed(pool); });
afterAll(async () => { await closePool(); await pool.end(); });
beforeEach(async () => {
  await pool.query(`TRUNCATE entity_sources, sources, events, event_artists, event_organisers, venues, artists, organisers, series,
    review_queue, cost_log, job_runs RESTART IDENTITY CASCADE`);
  await seedDemo(pool);
});

class FakeApify implements ApifyClient {
  calls: unknown[] = [];
  constructor(private readonly items: Record<string, unknown>[] = []) {}
  async runActor(_actorId: string, input: unknown): Promise<ActorRunResult> {
    this.calls.push(input);
    return { runId: "run", status: "SUCCEEDED", items: this.items };
  }
}

/** Stands in for the web research call: returns canned notes and pages per entity name. */
class FakeResearch implements ResearchClient {
  prompts: string[] = [];
  dryRuns = 0;
  constructor(private readonly pages: Record<string, RetrievedPage[]>, private readonly usd = 0.2) {}
  async research(req: ResearchRequest, opts: ResearchOptions): Promise<ResearchResult | undefined> {
    if (opts.dryRun) { this.dryRuns++; return undefined; }
    this.prompts.push(req.prompt);
    const name = Object.keys(this.pages).find((n) => req.prompt.includes(`Name: ${n}`));
    return {
      id: req.id, ok: name !== undefined, error: name === undefined ? "API error 529: overloaded" : undefined, notes: `notes about ${name}`,
      retrieved: name ? this.pages[name] : [], searches: 3, fetches: 2, inputTokens: 40_000, outputTokens: 2_000, usd: this.usd,
    };
  }
}

class FakeLlm implements LlmClient {
  written: string[] = [];
  constructor(private readonly structured: Record<string, Structured>, private readonly text = "") {}
  async run<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    if (opts.dryRun) return [];
    expect(opts.subBudget).toBe("enrichment");
    return requests.map((req) => {
      const input = req.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      let data: unknown;
      if (req.system.startsWith("You turn research notes")) {
        data = this.structured[Object.keys(this.structured).find((n) => input.includes(`notes about ${n}`))!];
      } else {
        this.written.push(input);
        data = { text: this.text || Array.from({ length: 45 }, (_, i) => `word${i}`).join(" ") };
      }
      return { id: req.id, ok: true, data: req.schema.parse(data), model: "fake", usd: 0.02, inputTokens: 10, outputTokens: 10 };
    });
  }
}

const src = (url: string, kind: "official" | "reputable" | "weak" = "reputable") => ({ url, kind });
const structured = (over: Partial<Structured> = {}): Structured =>
  ({ identity: "confirmed", identity_note: "", facts: [], works: [], links: [], ...over });
const page = (url: string, title: string | null = null): RetrievedPage => ({ url, title });

describe("pure helpers", () => {
  it("compares page addresses loosely", () => {
    expect(urlKey("https://www.Example.com/about/?utm_source=x#top")).toBe(urlKey("http://example.com/about"));
    expect(urlKey("https://example.com/a?id=2")).not.toBe(urlKey("https://example.com/a?id=3"));
  });

  it("collects only the pages the tools returned", () => {
    const pages = new Map<string, RetrievedPage>();
    collectRetrieved([
      { type: "text", text: "see https://invented.example/page", citations: [{ url: "https://cited-only.example/" }] },
      { type: "server_tool_use", name: "web_search", input: { query: "laugh cottage indore" } },
      { type: "web_search_tool_result", content: [
        { type: "web_search_result", url: "https://news.example/laugh-cottage", title: "Laugh Cottage opens", encrypted_content: "..." }] },
      { type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: "https://laughcottage.example/visit",
        content: { type: "document", title: "Visit us", source: { type: "text", data: "body with https://inside.example/link" } } } },
      { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
    ], pages);
    expect([...pages.values()]).toEqual([
      { url: "https://news.example/laugh-cottage", title: "Laugh Cottage opens" },
      { url: "https://laughcottage.example/visit", title: "Visit us" },
    ]);
  });

  it("keeps the notes written after the last tool call, across a paused turn", () => {
    expect(finalNotes([
      { type: "text", text: "Let me search." }, { type: "server_tool_use" }, { type: "web_search_tool_result" },
      { type: "text", text: "- Fact one: https://a.example/\n" }, { type: "thinking" }, { type: "text", text: "IDENTITY: confirmed" },
    ])).toBe("- Fact one: https://a.example/\nIDENTITY: confirmed");
  });

  it("reads an Instagram profile and skips private or empty ones", () => {
    expect(normaliseProfile({ username: "Laugh_Cottage", fullName: "Laugh Cottage", biography: " Comedy club in Indore ", externalUrl: "https://laughcottage.example",
      externalUrls: [{ url: "https://laughcottage.example/tickets" }], businessCategoryName: "Comedy club" })).toEqual({
      handle: "laugh_cottage", url: "https://www.instagram.com/laugh_cottage/", fullName: "Laugh Cottage", biography: "Comedy club in Indore",
      category: "Comedy club", links: ["https://laughcottage.example", "https://laughcottage.example/tickets"],
    });
    expect(normaliseProfile({ username: "x", private: true, biography: "hi" })).toBeNull();
    expect(normaliseProfile({ error: "not found" })).toBeNull();
  });

  it("spots private facts about people", () => {
    expect(isPrivate("Married to a fellow comedian since 2019")).toBe(true);
    expect(isPrivate("He is 34 years old")).toBe(true);
    expect(isPrivate("Stand-up comedian who has toured twelve cities")).toBe(false);
    expect(isPrivate("Sufi and ghazal singer; performs at weddings")).toBe(false);
  });

  it("tells the researcher to keep to professional facts for people, and passes the bio as a first-party source", () => {
    expect(researchSystem("artist")).toContain("Professional, public facts only");
    expect(researchSystem("venue")).not.toContain("Professional, public facts only");
    const prompt = researchPrompt(
      { type: "artist", id: 1, slug: "dev-sharma", name: "Dev Sharma", path: "/artists/dev-sharma", refs: 1, instagram: "dev", website: null, city: "Indore", state: "Madhya Pradesh", cityId: null, context: [] },
      { handle: "dev", url: "https://www.instagram.com/dev/", fullName: null, biography: "Comic. Indore.", category: null, links: [] });
    expect(prompt).toContain("Bio text: Comic. Indore.");
    expect(prompt).toContain("https://www.instagram.com/dev/");
  });
});

describe("checking facts", () => {
  const pages = [
    page("https://laughcottage.example/visit", "Visit us"), page("https://news.example/laugh-cottage", "Laugh Cottage opens"),
    page("https://www.justdial.com/indore/laugh-cottage"), page("https://www.zomato.com/indore/laugh-cottage"),
  ];
  const own = { urls: ["https://www.instagram.com/laugh_cottage/"], websites: ["https://laughcottage.example"] };

  it("leaves out a fact with a single weak source, and one whose source the tools never returned", () => {
    const a = assess("venue", structured({ facts: [
      { field: "capacity", value: "120", sources: [src("https://www.justdial.com/indore/laugh-cottage", "reputable")], confidence: 0.9 },
      { field: "parking", value: "Street parking only.", sources: [src("https://made-up.example/parking", "official")], confidence: 0.95 },
      { field: "address", value: "4 Sample Lane, Old Palasia, Indore 452001", sources: [src("https://laughcottage.example/visit/", "weak")], confidence: 0.95 },
    ] }), pages, own);
    expect(a.facts.map((f) => f.field)).toEqual(["address"]);
    // Our own check, not the model's label, decides how strong a source is.
    expect(a.facts[0].sources).toEqual([{ url: "https://laughcottage.example/visit/", title: "Visit us", strength: "official" }]);
    expect(a.leftOut.map((r) => `${r.field}: ${r.reason}`)).toEqual([
      "capacity: supported by a single weak source", "parking: no source that the research tools returned"]);
  });

  it("accepts two weak sources that agree, and the entity's own Instagram bio", () => {
    const a = assess("venue", structured({ facts: [
      { field: "capacity", value: "120", sources: [src("https://www.justdial.com/indore/laugh-cottage", "weak"), src("https://www.zomato.com/indore/laugh-cottage", "weak")], confidence: 0.8 },
      { field: "venue_type", value: "comedy club", sources: [src("https://instagram.com/laugh_cottage", "weak")], confidence: 0.9 },
    ] }), pages, own);
    expect(a.facts.map((f) => f.field).sort()).toEqual(["capacity", "venue_type"]);
    expect(a.facts.find((f) => f.field === "venue_type")!.sources[0].strength).toBe("official");
  });

  it("sends unsure facts to review and drops private facts about people", () => {
    const a = assess("artist", structured({ facts: [
      { field: "genre", value: "observational stand-up", sources: [src("https://news.example/laugh-cottage")], confidence: 0.5 },
      { field: "about", value: "Lives with his wife and two children in Indore", sources: [src("https://news.example/laugh-cottage")], confidence: 0.95 },
      { field: "shoe_size", value: "9", sources: [src("https://news.example/laugh-cottage")], confidence: 0.95 },
    ] }), pages, own);
    expect(a.facts).toEqual([]);
    expect(a.doubtful.map((d) => d.field)).toEqual(["genre"]);
    expect(a.droppedPrivate).toBe(1);
  });

  it("keeps works only on official platforms, and links only where they can be checked", () => {
    const found = [...pages, page("https://www.youtube.com/watch?v=abc123", "Dev Sharma: Small Town Problems"), page("https://www.instagram.com/devsharma.comic/")];
    const a = assess("artist", structured({
      works: [
        { title: "Small Town Problems", url: "https://www.youtube.com/watch?v=abc123", year: "2024", sources: [], confidence: 0.9 },
        { title: "Bootleg recording", url: "https://pirate.example/dev.mp3", year: null, sources: [src("https://news.example/laugh-cottage")], confidence: 0.9 },
        { title: "Unchecked special", url: "https://www.youtube.com/watch?v=zzz", year: null, sources: [], confidence: 0.9 },
      ],
      links: [
        { kind: "instagram", url: "https://www.instagram.com/devsharma.comic/", sources: [], confidence: 0.9 },
        { kind: "youtube", url: "https://www.youtube.com/@devsharma", sources: [], confidence: 0.9 },
        { kind: "spotify", url: "https://www.youtube.com/@devsharma", sources: [src("https://news.example/laugh-cottage")], confidence: 0.9 },
      ],
    }), found, { urls: [], websites: [] });
    expect(a.works).toMatchObject([{ title: "Small Town Problems", platform: "YouTube", year: "2024" }]);
    expect(a.links.map((l) => l.kind)).toEqual(["instagram"]);
  });

  it("returns nothing when the identity is not confirmed", () => {
    const a = assess("artist", structured({ identity: "uncertain", facts: [
      { field: "genre", value: "jazz", sources: [src("https://news.example/laugh-cottage")], confidence: 0.99 }] }), pages, own);
    expect(a.facts).toEqual([]);
  });

  it("never treats an address match as sure unless it carries the venue's name", () => {
    const base = { lat: "22.7", lon: "75.8", display_name: "4, Sample Lane, Old Palasia, Indore, Madhya Pradesh, India" };
    expect(addressConfidence("Laugh Cottage", "Indore", { ...base, name: "Laugh Cottage", category: "amenity", type: "theatre" })).toBeGreaterThanOrEqual(0.8);
    expect(addressConfidence("Laugh Cottage", "Indore", { ...base, name: "Sample Lane Chemist", category: "shop", type: "chemist" })).toBeLessThan(0.8);
    expect(addressConfidence("Laugh Cottage", "Indore", { ...base, name: "Sample Lane", category: "highway", type: "residential", addresstype: "road" })).toBeLessThan(0.4);
  });
});

describe("the enrichment job", () => {
  const cottagePages = [page("https://laughcottage.example/visit", "Visit Laugh Cottage"), page("https://news.example/laugh-cottage", "Laugh Cottage opens in Indore"),
    page("https://www.justdial.com/indore/laugh-cottage", "Laugh Cottage on Justdial")];
  const cottage = structured({
    facts: [
      { field: "address", value: "4 Sample Lane, Old Palasia, Indore 452001", sources: [src("https://laughcottage.example/visit", "official"), src("https://news.example/laugh-cottage")], confidence: 0.95 },
      { field: "venue_type", value: "comedy club", sources: [src("https://news.example/laugh-cottage")], confidence: 0.9 },
      { field: "capacity", value: "120", sources: [src("https://news.example/laugh-cottage")], confidence: 0.85 },
      { field: "about", value: "Opened in 2022 and hosts weekly open mics.", sources: [src("https://news.example/laugh-cottage")], confidence: 0.9 },
      { field: "parking", value: "Valet parking on weekends.", sources: [src("https://www.justdial.com/indore/laugh-cottage", "weak")], confidence: 0.9 },
      { field: "how_to_reach", value: "Two minutes from Palasia Square.", sources: [src("https://news.example/laugh-cottage")], confidence: 0.4 },
    ],
    links: [{ kind: "website", url: "https://laughcottage.example/", sources: [src("https://laughcottage.example/visit", "official")], confidence: 0.95 }],
  });
  const devPages = [page("https://news.example/dev-sharma", "Indore comic Dev Sharma on tour"), page("https://www.youtube.com/watch?v=abc123", "Small Town Problems")];
  const dev = structured({
    facts: [
      { field: "profession", value: "stand-up comedian", sources: [src("https://news.example/dev-sharma")], confidence: 0.95 },
      { field: "hometown", value: "Indore", sources: [src("https://news.example/dev-sharma")], confidence: 0.9 },
      { field: "about", value: "His father ran a sweet shop", sources: [src("https://news.example/dev-sharma")], confidence: 0.9 },
    ],
    works: [{ title: "Small Town Problems", url: "https://www.youtube.com/watch?v=abc123", year: "2024", sources: [src("https://news.example/dev-sharma")], confidence: 0.9 }],
  });

  it("picks flagged entities with published events, most-referenced first", async () => {
    const venues = await pickTargets(pool, "venue", 10);
    expect(venues[0].refs).toBeGreaterThanOrEqual(venues[venues.length - 1].refs);
    expect(venues.map((v) => v.slug)).toContain("laugh-cottage");
    expect(venues.find((v) => v.slug === "the-blue-room")).toMatchObject({ instagram: "the_blue_room_demo", path: "/indore/venues/the-blue-room" });
    await pool.query("UPDATE venues SET needs_enrichment = false WHERE slug = 'laugh-cottage'");
    expect((await pickTargets(pool, "venue", 10)).map((v) => v.slug)).not.toContain("laugh-cottage");
  });

  it("fills in a venue from checked facts, stores each fact with its source and lets it be geocoded again", async () => {
    await pool.query("UPDATE venues SET address = NULL, geocoded_at = now() - interval '5 days' WHERE slug = 'laugh-cottage'");
    const llm = new FakeLlm({ "Laugh Cottage": cottage });
    const report = await enrichEntities(pool, { llm, research: new FakeResearch({ "Laugh Cottage": cottagePages }), apify: new FakeApify() },
      { jobName: "test", types: ["venue"], slugs: ["laugh-cottage"] });

    expect(report.entities).toHaveLength(1);
    expect(report.entities[0]).toMatchObject({ outcome: "enriched", facts: 4, leftOut: 1, queued: 1, links: 1, searches: 3 });
    expect(report.entities[0].usd).toMatchObject({ research: 0.2, structure: 0.02, write: 0.02, total: 0.24 });
    expect(report.usdPerEntity).toBe(0.24);

    const v = (await getVenue("indore", "laugh-cottage"))!;
    expect(v).toMatchObject({ address: "4 Sample Lane, Old Palasia, Indore 452001", venue_type: "comedy club", capacity: 120, parking: null, how_to_reach: null });
    expect(v.description).toMatch(/^word0 /);
    expect(v.official_links.website).toBe("https://laughcottage.example/");
    expect(v.sources.map((s) => s.url)).toEqual(["https://laughcottage.example/visit", "https://news.example/laugh-cottage"]);
    expect(v.sources[1].facts).toContain("Capacity: 120");
    // The writer saw the checked facts only: nothing left out or unsure, and no address to copy.
    expect(llm.written[0]).toContain("Type of venue: comedy club");
    expect(llm.written[0]).not.toMatch(/Valet|Palasia Square|Sample Lane/);

    const row = (await pool.query("SELECT needs_enrichment, enriched_at, geocoded_at FROM venues WHERE slug = 'laugh-cottage'")).rows[0];
    expect(row).toMatchObject({ needs_enrichment: false, geocoded_at: null });
    expect(row.enriched_at).not.toBeNull();
    const queue = (await pool.query("SELECT item_type, reason, payload FROM review_queue")).rows;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ item_type: "entity_fact", reason: "1 fact(s) not confident enough to publish" });
    expect(queue[0].payload.facts[0].value).toBe("Two minutes from Palasia Square.");
    expect((await changedPaths(pool, new Date(Date.now() - 60_000)))).toContain("/indore/venues/laugh-cottage");
  });

  it("writes an artist page from professional facts only, with a library of official links", async () => {
    const llm = new FakeLlm({ "Dev Sharma": dev });
    const report = await enrichEntities(pool, { llm, research: new FakeResearch({ "Dev Sharma": devPages }), apify: new FakeApify() },
      { jobName: "test", types: ["artist"], slugs: ["dev-sharma"] });
    expect(report.entities[0]).toMatchObject({ outcome: "enriched", facts: 2, works: 1, droppedPrivate: 1 });
    const p = (await getArtist("dev-sharma"))!;
    expect(p.bio).toMatch(/^word0 /);
    expect(p.hometown).toBe("Indore");
    expect(p.notable_works).toEqual([{ title: "Small Town Problems", url: "https://www.youtube.com/watch?v=abc123", platform: "YouTube", year: "2024" }]);
    expect(llm.written[0]).not.toContain("father");
    const stored = (await pool.query("SELECT fact, url, strength FROM entity_sources WHERE entity_type = 'artist' ORDER BY id")).rows;
    expect(stored.every((r) => r.url && r.fact)).toBe(true);
    expect(stored.map((r) => r.fact)).not.toContain("About: His father ran a sweet shop");
  });

  it("leaves a stub when there is too little to say, and queues an identity it cannot confirm", async () => {
    const thin = structured({ facts: [{ field: "profession", value: "comedian", sources: [src("https://news.example/dev-sharma")], confidence: 0.9 }] });
    const llm = new FakeLlm({ "Dev Sharma": thin });
    let report = await enrichEntities(pool, { llm, research: new FakeResearch({ "Dev Sharma": devPages }), apify: new FakeApify() },
      { jobName: "test", types: ["artist"], slugs: ["dev-sharma"] });
    expect(report.entities[0]).toMatchObject({ outcome: "stub", facts: 1, textWords: 0 });
    expect((await getArtist("dev-sharma"))!.bio).toBeNull();
    expect(llm.written).toEqual([]);

    const unsure = structured({ identity: "uncertain", identity_note: "Two comedians share this name." });
    report = await enrichEntities(pool, { llm: new FakeLlm({ "Dev Sharma": unsure }), research: new FakeResearch({ "Dev Sharma": devPages }), apify: new FakeApify() },
      { jobName: "test", types: ["artist"], slugs: ["dev-sharma"] });
    expect(report.entities[0].outcome).toBe("identity_uncertain");
    expect((await pool.query("SELECT reason FROM review_queue")).rows[0].reason).toContain("could not confirm which performer");
    expect((await pool.query("SELECT count(*)::int AS n FROM entity_sources WHERE entity_type = 'artist' AND fact NOT LIKE 'Who they are%'")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT needs_enrichment FROM artists WHERE slug = 'dev-sharma'")).rows[0].needs_enrichment).toBe(false);
  });

  it("holds back text that reads as private, and retries an entity whose research failed", async () => {
    const llm = new FakeLlm({ "Dev Sharma": dev }, "Dev Sharma is a comedian from Indore who is married with two children and tours widely across India every single year.");
    let report = await enrichEntities(pool, { llm, research: new FakeResearch({ "Dev Sharma": devPages }), apify: new FakeApify() },
      { jobName: "test", types: ["artist"], slugs: ["dev-sharma"] });
    expect(report.entities[0]).toMatchObject({ outcome: "stub", queued: 1 });
    expect((await getArtist("dev-sharma"))!.bio).toBeNull();

    await pool.query("UPDATE artists SET needs_enrichment = true WHERE slug = 'dev-sharma'");
    report = await enrichEntities(pool, { llm, research: new FakeResearch({}), apify: new FakeApify() }, { jobName: "test", types: ["artist"], slugs: ["dev-sharma"] });
    expect(report.entities[0]).toMatchObject({ outcome: "failed", error: "API error 529: overloaded" });
    expect((await pool.query("SELECT needs_enrichment FROM artists WHERE slug = 'dev-sharma'")).rows[0].needs_enrichment).toBe(true);
  });

  it("reads Instagram bios through the scrape budget and stays inside the per-run budget", async () => {
    const apify = new FakeApify([{ username: "the_blue_room_demo", biography: "Listening room. Vijay Nagar.", externalUrl: "https://blueroom.example" }]);
    const research = new FakeResearch({ "The Blue Room": [page("https://blueroom.example/", "The Blue Room")] });
    const blue = structured({ facts: [
      { field: "venue_type", value: "listening room", sources: [src("https://www.instagram.com/the_blue_room_demo/", "weak")], confidence: 0.9 }] });
    const report = await enrichEntities(pool, { llm: new FakeLlm({ "The Blue Room": blue }), research, apify },
      { jobName: "test", types: ["venue"], perRunUsd: enrichment.estResearchUsd + 0.06 });
    // Three venues are flagged; the budget covers one, and it is the most-referenced.
    expect(report.picked).toBe(3);
    expect(report.processed).toBe(1);
    expect(report.entities[0].name).toBe("The Blue Room");
    expect(report.stoppedEarly).toContain("covers about 1 of 3");
    expect(report.profiles).toMatchObject({ requested: 1, read: 1 });
    expect(research.prompts[0]).toContain("Bio text: Listening room. Vijay Nagar.");
    expect((await pool.query("SELECT strength FROM entity_sources WHERE entity_type = 'venue'")).rows).toEqual([{ strength: "official" }]);
    const costs = (await pool.query("SELECT bucket, sub_budget, service FROM cost_log WHERE NOT dry_run ORDER BY id")).rows;
    expect(costs).toContainEqual({ bucket: "scrape", sub_budget: null, service: "apify" });
  });

  it("changes nothing on a dry run and logs the estimate", async () => {
    const research = new FakeResearch({});
    const report = await enrichEntities(pool, { llm: new FakeLlm({}), research, apify: new FakeApify() }, { jobName: "test", dryRun: true, types: ["venue", "artist"], limit: 2 });
    expect(report.picked).toBeGreaterThan(0);
    expect(research.dryRuns).toBe(report.entities.length);
    expect(report.usdPerEntity).toBeGreaterThan(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM venues WHERE NOT needs_enrichment")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM entity_sources")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM cost_log WHERE NOT dry_run")).rows[0].n).toBe(0);
  });
});
