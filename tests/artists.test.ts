/** Prompt 10: artist tracking and official video. Apify, the model and YouTube are stand-ins; nothing paid is called. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.APIFY_IG_POSTS_ACTOR_ID = "apify/instagram-scraper";
});

import { renderToStaticMarkup } from "react-dom/server";
import { freshDb } from "./helpers";
import { seed } from "../db/seed";
import { closePool } from "../src/lib/db";
import type { ActorRunResult, ApifyClient } from "../src/lib/pipeline/apify";
import type { Extraction } from "../src/lib/pipeline/extract";
import type { LlmClient, LlmRequest, LlmResult, LlmRunOptions } from "../src/lib/pipeline/llm";
import { cleanUpdate, instagramHandle, trackArtists, trackedArtists } from "../src/lib/pipeline/artist-tracking";
import { HttpYoutube, findArtistVideos, isOwnChannel, isoSeconds, parseChannelLink, roundedViews, type YoutubeClient } from "../src/lib/pipeline/youtube";
import { processPosts } from "../src/lib/pipeline/process";
import { pendingItems } from "../src/lib/pipeline/translate";
import { artistUpdates, artistVideos } from "../src/lib/queries";
import { UpdateList, VideoList } from "../src/components/artist-media";
import { localDate } from "../src/lib/pipeline/text";

let pool: Pool;
let cityId: number;
let venueId: number;
beforeAll(async () => {
  pool = await freshDb();
  await seed(pool);
  cityId = (await pool.query<{ id: number }>("SELECT id FROM cities WHERE slug = 'indore'")).rows[0].id;
});
afterAll(async () => { await closePool(); await pool.end(); });
beforeEach(async () => {
  await pool.query(`TRUNCATE handles, raw_posts, sources, events, event_artists, event_organisers, venues, artists, organisers,
    review_queue, cost_log, artist_posts, artist_videos, translations RESTART IDENTITY CASCADE`);
  venueId = (await pool.query<{ id: number }>("INSERT INTO venues (city_id, slug, name) VALUES ($1,'phoenix-citadel','Phoenix Citadel') RETURNING id", [cityId])).rows[0].id;
});

const NOW = new Date();
const inDays = (n: number) => localDate(new Date(NOW.getTime() + n * 86_400_000), "Asia/Kolkata");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

/** An artist, optionally with a published event `eventInDays` from now. */
async function artist(slug: string, name: string, opts: { instagram?: string; youtube?: string; eventInDays?: number; pinned?: boolean } = {}): Promise<number> {
  const links = { ...(opts.instagram ? { instagram: opts.instagram } : {}), ...(opts.youtube ? { youtube: opts.youtube } : {}) };
  const id = (await pool.query<{ id: number }>(
    "INSERT INTO artists (slug, name, official_links, tracking_pinned) VALUES ($1,$2,$3,$4) RETURNING id", [slug, name, JSON.stringify(links), !!opts.pinned])).rows[0].id;
  if (opts.eventInDays !== undefined) {
    const day = inDays(opts.eventInDays);
    const e = (await pool.query<{ id: number }>(
      `INSERT INTO events (city_id, venue_id, slug, title, starts_at, local_date, origin, is_published, confidence, description)
       VALUES ($1,$2,$3,$4,$5::date + time '14:30',$5,'scraped',true,0.9,'x') RETURNING id`, [cityId, venueId, `${slug}-live-${day}`, `${name} Live`, day])).rows[0].id;
    await pool.query("INSERT INTO event_artists (event_id, artist_id) VALUES ($1,$2)", [e, id]);
  }
  return id;
}

class FakeApify implements ApifyClient {
  calls: { actorId: string; input: Record<string, unknown> }[] = [];
  constructor(private readonly respond: (input: Record<string, unknown>) => Record<string, unknown>[]) {}
  async runActor(actorId: string, input: unknown): Promise<ActorRunResult> {
    this.calls.push({ actorId, input: input as Record<string, unknown> });
    return { runId: "run", status: "SUCCESS", items: this.respond(input as Record<string, unknown>) };
  }
}

const f = <T>(value: T | null, confidence = value === null ? 0 : 0.95) => ({ value, confidence });
const DESCRIPTION = { description: Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ") };

/** Answers each kind of request from the caption or text it carries; never calls a model. */
class FakeLlm implements LlmClient {
  runs: (LlmRunOptions & { tiers: string[] })[] = [];
  seen: { system: string; tier: string; text: string }[] = [];
  async run<T>(requests: LlmRequest<T>[], opts: LlmRunOptions): Promise<LlmResult<T>[]> {
    this.runs.push({ ...opts, tiers: requests.map((r) => r.tier) });
    if (opts.dryRun) return [];
    return requests.map((req) => {
      const text = req.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      this.seen.push({ system: req.system.slice(0, 40), tier: req.tier, text });
      let data: unknown;
      if (req.system.startsWith("You sort Instagram posts by a performer")) {
        data = text.includes("out now") ? { label: "new_release", confidence: 0.93, reason: "announces a single that is out" }
          : text.includes("Tickets") ? { label: "new_show", confidence: 0.95, reason: "announces a dated show" }
          : text.includes("postponed") ? { label: "event_change", confidence: 0.9, reason: "says the show is postponed" }
          : text.includes("something big") ? { label: "new_release", confidence: req.tier === "fast" ? 0.5 : 0.55, reason: "a teaser, no title" }
          : text.includes("New video up") ? { label: "new_release", confidence: 0.9, reason: "says a video is up" }
          : { label: "other", confidence: 0.96, reason: "personal post" };
      } else if (req.system.startsWith("You write one-line updates")) {
        data = text.includes("Roz Roz") ? { is_release: true, update: "The Yellow Diary released a new single, Roz Roz, on streaming platforms" } : { is_release: false, update: "" };
      } else if (req.system.startsWith("You write the one-sentence note")) {
        data = { videos: [...text.matchAll(/video_id: (\S+)/g)].map((m) => ({ video_id: m[1], note: `A music video that is among the most-watched on the official channel (${m[1]}).` })).slice(0, 2) };
      } else if (req.system.startsWith("You extract")) {
        const ex: Extraction = {
          is_event_post: true, co_host_handles: [], notes: "",
          events: [{
            announcement: "new_event", title: f("The Yellow Diary: Winter Tour"), start_date: f(inDays(40)), start_time: f("20:00"), end_date: f<string>(null), end_time: f<string>(null),
            venue_name: f("Phoenix Citadel"), venue_instagram_handle: null, city: f("Indore"), area: f<string>(null), price_text: f("₹999"), is_free: f(false),
            booking_url: f<string>(null), performers: [], organiser: f<string>(null), organiser_instagram_handle: null, category: f("music"), practical: "",
          }],
        };
        data = ex;
      } else data = req.system.startsWith("You compare") ? { same_event: false, confidence: 0.9 }
        : req.system.startsWith("You check event listings") ? { takes_place_in_city: true, actual_city: "Indore", confidence: 0.95 } : DESCRIPTION;
      return { id: req.id, ok: true, data: req.schema.parse(data), model: "fake", usd: 0.001, inputTokens: 10, outputTokens: 10 };
    });
  }
}

const post = (shortCode: string, owner: string, caption: string, daysAgo = 1) => ({
  shortCode, ownerUsername: owner, caption, type: "Image", url: `https://www.instagram.com/p/${shortCode}/`, timestamp: ago(daysAgo),
  inputUrl: `https://www.instagram.com/${owner}/`, displayUrl: "https://cdn.example/x.jpg",
});

describe("artist tracking", () => {
  it("reads handles, guards the release line, and tells an artist's own channel from a namesake", () => {
    expect(instagramHandle("https://www.instagram.com/TheYellowDiary/")).toBe("theyellowdiary");
    expect(instagramHandle("@the.band_1")).toBe("the.band_1");
    expect(instagramHandle("https://example.com/x")).toBeNull();
    expect(cleanUpdate("  The band released a single,  Roz Roz #newmusic ", "caption")).toBe("The band released a single, Roz Roz.");
    expect(cleanUpdate(Array.from({ length: 50 }, () => "word").join(" "), "caption")).toBeNull();
    const lifted = "Our brand new single is finally out on every platform, go listen now";
    expect(cleanUpdate(lifted, `Hey! ${lifted} ❤`)).toBeNull();

    expect(isOwnChannel("The Yellow Diary", "The Yellow Diary")).toBe(true);
    expect(isOwnChannel("TheYellowDiaryOfficial", "The Yellow Diary")).toBe(true);
    expect(isOwnChannel("The Yellow Diary - Topic", "The Yellow Diary")).toBe(true);
    expect(isOwnChannel("Sumit Gupta Vlogs", "Sumit Gupta")).toBe(false);
    expect(isOwnChannel("Yellow Diary Fans", "The Yellow Diary")).toBe(false);
    expect(parseChannelLink("https://www.youtube.com/@theyellowdiary")).toEqual({ handle: "theyellowdiary" });
    expect(parseChannelLink("https://youtube.com/channel/UCabcdefghijklmnopqrstuv")).toEqual({ id: "UCabcdefghijklmnopqrstuv" });
    expect(parseChannelLink("https://www.youtube.com/watch?v=abc")).toBeNull();
    expect(isoSeconds("PT4M13S")).toBe(253);
    expect(isoSeconds("PT1H2M")).toBe(3720);
    expect(roundedViews(12_480_000)).toBe("12.4 million");
    expect(roundedViews(3_000_000)).toBe("3 million");
  });

  it("tracks only artists with a show soon or a pin, sorts their new posts, and publishes nothing from general posts", async () => {
    const diary = await artist("the-yellow-diary", "The Yellow Diary", { instagram: "theyellowdiary", eventInDays: 10 });
    await artist("old-act", "Old Act", { instagram: "oldact", eventInDays: -20 });           // last show over a week ago: not tracked
    await artist("recent-act", "Recent Act", { eventInDays: -3 });                            // within a week of the last show, but no Instagram on record
    const poet = await artist("pinned-poet", "Pinned Poet", { instagram: "https://www.instagram.com/pinnedpoet/", pinned: true });
    await artist("venue-band", "Venue Band", { instagram: "venueband", eventInDays: 5 });
    await pool.query("INSERT INTO handles (handle, handle_type, city_id, tier) VALUES ('venueband','artist',$1,'A')", [cityId]);

    expect((await trackedArtists(pool, { now: NOW })).map((a) => a.name)).toEqual(["Pinned Poet", "Venue Band", "The Yellow Diary", "Recent Act"]);

    const apify = new FakeApify(() => [
      post("R1", "theyellowdiary", "Our new single 'Roz Roz' is out now on all platforms!"),
      post("S1", "theyellowdiary", "Indore, we are back. Phoenix Citadel, 8 PM. Tickets ₹999, link in bio."),
      post("O1", "theyellowdiary", "Sunday with the family ❤"),
      post("T1", "pinnedpoet", "something big is coming soon..."),
      post("V1", "pinnedpoet", "New video up on the channel, go watch"),
      post("C1", "pinnedpoet", "Sad news: tomorrow's Bhopal show is postponed."),
      { error: "not_found", errorDescription: "Profile does not exist", inputUrl: "https://www.instagram.com/ghost/" },
    ]);
    const llm = new FakeLlm();

    const dry = await trackArtists(pool, apify, llm, { jobName: "test", dryRun: true, now: NOW });
    expect(dry).toMatchObject({ tracked: 4, due: 2, noHandle: ["Recent Act"], alreadyAHandle: ["Venue Band"], postsNew: 0,
      status: "dry run: would check 2 artist(s), up to 6 posts, at most $0.02 to scrape" });
    expect(apify.calls).toHaveLength(0);

    const rep = await trackArtists(pool, apify, llm, { jobName: "test", now: NOW });
    expect(rep).toMatchObject({ status: "ok", due: 2, checked: 2, postsReturned: 7, postsNew: 6, sentToPipeline: 2,
      byLabel: { new_show: 1, event_change: 1, new_release: 1, other: 3 } });
    expect(rep.updates).toEqual([{ artist: "The Yellow Diary", text: "The Yellow Diary released a new single, Roz Roz, on streaming platforms.", url: "https://www.instagram.com/p/R1/" }]);
    expect(rep.ignored.map((i) => [i.url.slice(-3, -1), i.reason])).toEqual([
      ["O1", "personal post"],
      ["T1", "unsure after a second opinion (looked like new_release)"],
      ["V1", "no release title could be stated from the post"],
    ]);
    expect(rep.errors).toEqual(["@ghost: Profile does not exist"]);
    // One actor run for both artists, first check: the newest 3 posts each from the last 14 days.
    expect(apify.calls).toHaveLength(1);
    expect(apify.calls[0].input).toMatchObject({
      directUrls: ["https://www.instagram.com/pinnedpoet/", "https://www.instagram.com/theyellowdiary/"], resultsLimit: 3,
      onlyPostsNewerThan: new Date(NOW.getTime() - 14 * 86_400_000).toISOString().slice(0, 10) });
    // Fast tier sorts; the unsure teaser gets one mid-tier second opinion; lines are written by the mid tier. All under the artist text limit.
    expect(llm.runs.map((r) => [r.subBudget, r.tiers.join(",")])).toEqual([
      ["artistText", "fast,fast,fast,fast,fast,fast"], ["artistText", "mid"], ["artistText", "mid,mid"]]);
    expect(llm.seen[0].text).toContain("Shows of theirs we already list:\n- The Yellow Diary Live,");
    expect((await pool.query("SELECT sub_budget, estimated_usd FROM cost_log WHERE NOT dry_run")).rows).toEqual([{ sub_budget: "artistTracking", estimated_usd: "0.018900" }]);

    // The two show posts wait for the normal pipeline as event posts; nothing else was stored from the posts.
    expect((await pool.query("SELECT shortcode, handle, filter_result, processing_state, city_id FROM raw_posts ORDER BY shortcode")).rows).toEqual([
      { shortcode: "C1", handle: "pinnedpoet", filter_result: "event", processing_state: "new", city_id: cityId },
      { shortcode: "S1", handle: "theyellowdiary", filter_result: "event", processing_state: "new", city_id: cityId },
    ]);
    expect((await pool.query("SELECT shortcode, label, update_text IS NOT NULL AS has_line FROM artist_posts ORDER BY shortcode")).rows).toEqual([
      { shortcode: "C1", label: "event_change", has_line: false }, { shortcode: "O1", label: "other", has_line: false },
      { shortcode: "R1", label: "new_release", has_line: true }, { shortcode: "S1", label: "new_show", has_line: false },
      { shortcode: "T1", label: "other", has_line: false }, { shortcode: "V1", label: "other", has_line: false },
    ]);

    // Not due again for three days; a forced run reads the same posts and pays no model for them.
    expect((await trackArtists(pool, apify, llm, { jobName: "test", now: NOW })).status).toBe("no artist is due");
    const sorted = llm.seen.length;
    expect(await trackArtists(pool, apify, llm, { jobName: "test", now: NOW, force: true })).toMatchObject({ checked: 2, postsNew: 0 });
    expect(llm.seen.length).toBe(sorted);

    // The show announcement becomes an event through the usual rules.
    const result = await processPosts(pool, { llm, apify, fetchFn: (async () => new Response("", { status: 404 })) as typeof fetch }, { jobName: "test" });
    expect(result.resolve.created).toBeGreaterThanOrEqual(1);
    expect((await pool.query("SELECT title FROM events WHERE is_published AND title LIKE '%Winter Tour'")).rows).toHaveLength(1);

    // The artist page shows the release line with its date and a link to the post; hiding it removes it.
    const updates = await artistUpdates(diary, "en");
    expect(updates).toMatchObject([{ text: "The Yellow Diary released a new single, Roz Roz, on streaming platforms.", post_url: "https://www.instagram.com/p/R1/" }]);
    const html = renderToStaticMarkup(UpdateList({ updates, timeZone: "Asia/Kolkata" })!);
    expect(html).toContain("released a new single, Roz Roz");
    expect(html).toContain('href="https://www.instagram.com/p/R1/"');
    expect((await pendingItems(pool)).filter((i) => i.type === "artist_post").map((i) => i.field)).toEqual(["update_text"]);
    await pool.query("UPDATE artist_posts SET hidden = true WHERE shortcode = 'R1'");
    expect(await artistUpdates(diary, "en")).toEqual([]);
    expect(await artistUpdates(poet, "en")).toEqual([]);
  });

  it("stops at its monthly limit without failing the job", async () => {
    await artist("the-yellow-diary", "The Yellow Diary", { instagram: "theyellowdiary", eventInDays: 10 });
    await pool.query("INSERT INTO cost_log (bucket, sub_budget, service, estimated_usd, job_name) VALUES ('scrape','artistTracking','apify',5,'ingest')");
    const apify = new FakeApify(() => []);
    expect((await trackArtists(pool, apify, new FakeLlm(), { jobName: "test", now: NOW })).status).toMatch(/^stopped by the budget guard/);
    expect(apify.calls).toHaveLength(0);
  });
});

describe("official video", () => {
  class FakeYoutube implements YoutubeClient {
    searches = 0;
    calls: string[] = [];
    async get(resource: string, p: Record<string, string>) {
      this.calls.push(`${resource}?${Object.entries(p).filter(([k]) => k !== "part" && k !== "maxResults").map(([k, v]) => `${k}=${v}`).join("&")}`);
      if (resource === "search") this.searches++;
      const channel = (id: string, title: string, subs: number) => ({ id, snippet: { title }, statistics: { subscriberCount: String(subs) } });
      if (resource === "channels" && p.forHandle === "@theyellowdiary") return { items: [channel("UC_DIARY", "The Yellow Diary", 250000)] };
      if (resource === "search" && p.type === "channel" && p.q === "Sumit Gupta") {
        return { items: [{ id: { channelId: "UC_V" }, snippet: { title: "Sumit Gupta Vlogs" } }, { id: { channelId: "UC_F" }, snippet: { title: "Sumit Gupta Fan Club" } }] };
      }
      if (resource === "search" && p.type === "channel" && p.q === "Major Minor") {
        return { items: [{ id: { channelId: "UC_T" }, snippet: { title: "Major Minor - Topic" } }, { id: { channelId: "UC_M" }, snippet: { title: "Major Minor Official" } }, { id: { channelId: "UC_X" }, snippet: { title: "Major Minor Covers" } }] };
      }
      if (resource === "channels" && p.id === "UC_T,UC_M") return { items: [channel("UC_T", "Major Minor - Topic", 900000), channel("UC_M", "Major Minor Official", 4000)] };
      if (resource === "search" && p.type === "video") return { items: ["v_hit", "v_short", "v_blocked", "v_second", "v_live"].map((videoId) => ({ id: { videoId } })) };
      if (resource === "videos") {
        const video = (id: string, title: string, views: number, duration: string, extra: Record<string, unknown> = {}) => ({
          id, snippet: { title, publishedAt: "2019-03-01T10:00:00Z", description: "From the album Izafa.", liveBroadcastContent: "none", ...(extra.snippet as object) },
          statistics: { viewCount: String(views) }, contentDetails: { duration }, status: { embeddable: true, privacyStatus: "public", ...(extra.status as object) },
        });
        return { items: [
          video("v_second", "Rab Raakha", 3_100_000, "PT4M2S"), video("v_hit", "Marz (Official Video)", 12_480_000, "PT4M13S"),
          video("v_short", "Teaser", 99_000_000, "PT30S"), video("v_blocked", "Not embeddable", 50_000_000, "PT4M", { status: { embeddable: false } }),
          video("v_live", "Live now", 40_000_000, "PT0S", { snippet: { liveBroadcastContent: "live" } }),
        ] };
      }
      return { items: [] };
    }
  }

  it("finds the official channel, takes its best-known embeddable videos, and shows nothing until approved", async () => {
    await artist("the-yellow-diary", "The Yellow Diary", { youtube: "https://www.youtube.com/@theyellowdiary", eventInDays: 10 });
    await artist("sumit-gupta", "Sumit Gupta", { eventInDays: 12 });
    await artist("major-minor", "Major Minor", { eventInDays: 14 });
    await artist("old-act", "Old Act", { eventInDays: -30 });
    const yt = new FakeYoutube();
    const llm = new FakeLlm();

    expect((await findArtistVideos(pool, new HttpYoutube(""), llm, { jobName: "test", now: NOW })).status).toBe("YOUTUBE_API_KEY is not set");
    expect((await findArtistVideos(pool, yt, llm, { jobName: "test", now: NOW, dryRun: true })).status)
      .toBe("dry run: would look up 3 artist(s), at most 6 of the day's 100 YouTube searches (free)");

    const rep = await findArtistVideos(pool, yt, llm, { jobName: "test", now: NOW });
    expect(rep).toMatchObject({ status: "ok", waiting: 3, lookedUp: 3, searchesUsed: 4, noChannel: ["Sumit Gupta"] });
    expect(rep.selections.map((s) => [s.artist, s.channel, s.foundBy, s.videos.map((v) => v.id)])).toEqual([
      ["The Yellow Diary", "The Yellow Diary", "the YouTube link on the artist's page", ["v_hit", "v_second"]],
      ["Major Minor", "Major Minor Official", "a name search: check it is the right channel", ["v_hit", "v_second"]],
    ]);
    // The model's note where it gave one; plain facts where it did not. Never an invented claim.
    expect(rep.selections[0].videos[0]).toMatchObject({ title: "Marz (Official Video)", year: 2019, views: 12_480_000 });
    expect(llm.seen.find((s) => s.system.startsWith("You write the one-sentence note"))!.text).toContain("Views: 12480000");
    expect(llm.runs.every((r) => r.subBudget === "artistText")).toBe(true);
    expect(yt.calls.slice(0, 3)).toEqual(["channels?forHandle=@theyellowdiary", "search?channelId=UC_DIARY&type=video&order=viewCount", "videos?id=v_hit,v_short,v_blocked,v_second,v_live"]);

    expect((await pool.query("SELECT a.slug, v.video_id, v.status, v.position FROM artist_videos v JOIN artists a ON a.id = v.artist_id ORDER BY a.slug, v.position")).rows).toEqual([
      { slug: "major-minor", video_id: "v_hit", status: "pending", position: 0 }, { slug: "major-minor", video_id: "v_second", status: "pending", position: 1 },
      { slug: "the-yellow-diary", video_id: "v_hit", status: "pending", position: 0 }, { slug: "the-yellow-diary", video_id: "v_second", status: "pending", position: 1 },
    ]);
    expect((await pool.query("SELECT videos_note FROM artists WHERE slug = 'sumit-gupta'")).rows[0].videos_note).toBe("No official YouTube channel could be told apart by name.");
    // Looked up once: a second run has nothing to do and spends no searches.
    expect((await findArtistVideos(pool, yt, llm, { jobName: "test", now: NOW })).status).toBe("every tracked artist has been looked up");
    expect(yt.searches).toBe(4);

    // Nothing is public until approved.
    expect(await artistVideos(["the-yellow-diary", "major-minor"], 5, "en")).toEqual([]);
    await pool.query("UPDATE artist_videos SET status = 'approved' WHERE artist_id = (SELECT id FROM artists WHERE slug = 'the-yellow-diary')");
    const live = await artistVideos(["the-yellow-diary", "major-minor"], 5, "en");
    expect(live.map((v) => [v.artist_slug, v.video_id])).toEqual([["the-yellow-diary", "v_hit"], ["the-yellow-diary", "v_second"]]);
    expect(await artistVideos(["the-yellow-diary"], 1, "en")).toHaveLength(1);

    // The page has YouTube's own player, loaded lazily, and plain text beside it saying what the video is.
    const html = renderToStaticMarkup(VideoList({ videos: live, heading: "Official videos", id: "videos-heading", note: "Videos from the official channel." })!);
    expect(html).toContain('<iframe src="https://www.youtube-nocookie.com/embed/v_hit" title="Marz (Official Video)" loading="lazy"');
    expect(html).toContain("<strong>Marz (Official Video)</strong> (2019). A music video that is among the most-watched on the official channel (v_hit).");
    expect(html).toContain('href="https://www.youtube.com/watch?v=v_hit"');
    expect(html).not.toContain("<script");
    expect((await pendingItems(pool)).filter((i) => i.type === "artist_video")).toHaveLength(2);
  });
});
