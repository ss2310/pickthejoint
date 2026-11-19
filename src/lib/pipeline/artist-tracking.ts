/**
 * Artist tracking (Prompt 10). Keeps artist pages current at low cost.
 *
 * Who: only artists with a published event in one of our cities in the next
 * 30 days (until 7 days after their last one), plus artists the owner pins.
 * What: every 3 days, the artist's newest Instagram posts (3 at most, new
 * ones only) are sorted by the fast model into
 *   - new_show / event_change: handed to the normal event pipeline, which
 *     applies the usual city, confidence and dedup rules;
 *   - new_release: a dated one-line update in our own words (mid tier) with a
 *     link to the post, shown on the artist page;
 *   - other: ignored. General posts are never rewritten as news, and nothing
 *     about an artist's private life is published (hard rule 6).
 * The post itself is never stored or rehosted (hard rule 4): only its link,
 * the label and our own line.
 */
import { z } from "zod";
import type { Pool } from "pg";
import { apify as apifyConfig, artistTracking as cfg, ingestion } from "../../config";
import { guardedCall } from "../budget-guard";
import type { ApifyClient } from "./apify";
import type { LlmClient, LlmRequest } from "./llm";
import { buildActorInput, normalisePost, profileOf, type NormalisedPost } from "./scrape";
import { localDate } from "./text";

/** "name", "@name" or an Instagram profile link -> "name"; null for anything else. */
export function instagramHandle(v: string | null | undefined): string | null {
  const m = (v ?? "").trim().match(/^(?:https?:\/\/(?:www\.)?instagram\.com\/)?@?([A-Za-z0-9._]{1,30})\/?(?:\?.*)?$/);
  return m ? m[1].toLowerCase() : null;
}

export interface TrackedArtist {
  id: number;
  slug: string;
  name: string;
  handle: string | null;
  pinned: boolean;
  tracking_checked_at: Date | null;
  /** The city of the artist's nearest event (the first live city for a pinned artist with none): posts are filed there. */
  city_id: number;
  /** Their events we list around now, as context for telling a change from a new show. */
  events: { title: string; date: string; city: string }[];
}

/** Artists being tracked right now: pinned first, then the soonest events, up to the cap. */
export async function trackedArtists(pool: Pool, opts: { now?: Date; slugs?: string[] } = {}): Promise<TrackedArtist[]> {
  const now = opts.now ?? new Date();
  const { rows } = await pool.query<{
    id: number; slug: string; name: string; instagram: string | null; pinned: boolean; tracking_checked_at: Date | null;
    city_id: number | null; events: TrackedArtist["events"] | null;
  }>(
    `SELECT a.id, a.slug, a.name, a.official_links->>'instagram' AS instagram, a.tracking_pinned AS pinned, a.tracking_checked_at,
            coalesce(ev.city_id, (SELECT id FROM cities WHERE is_live ORDER BY id LIMIT 1)) AS city_id, ev.events
     FROM artists a
     LEFT JOIN LATERAL (
       SELECT min(e.starts_at) FILTER (WHERE e.starts_at >= $1) AS next_at,
              (array_agg(e.city_id ORDER BY abs(extract(epoch FROM e.starts_at - $1::timestamptz))))[1] AS city_id,
              json_agg(json_build_object('title', e.title, 'date', to_char(e.starts_at AT TIME ZONE c.timezone, 'YYYY-MM-DD'), 'city', c.name) ORDER BY e.starts_at) AS events
       FROM event_artists ea JOIN events e ON e.id = ea.event_id JOIN cities c ON c.id = e.city_id
       WHERE ea.artist_id = a.id AND e.is_published AND c.is_live AND e.status <> 'cancelled'
         AND e.starts_at >= $1::timestamptz - make_interval(days => $2) AND e.starts_at <= $1::timestamptz + make_interval(days => $3)
     ) ev ON true
     WHERE (a.tracking_pinned OR ev.events IS NOT NULL) AND ($4::text[] IS NULL OR a.slug = ANY($4))
     ORDER BY a.tracking_pinned DESC, ev.next_at NULLS LAST, a.id
     LIMIT $5`,
    [now, cfg.stopAfterDays, cfg.upcomingDays, opts.slugs?.length ? opts.slugs : null, cfg.maxTracked]);
  return rows.filter((r) => r.city_id !== null).map((r) => ({
    id: r.id, slug: r.slug, name: r.name, handle: instagramHandle(r.instagram), pinned: r.pinned,
    tracking_checked_at: r.tracking_checked_at, city_id: Number(r.city_id), events: r.events ?? [],
  }));
}

// ------------------------------------------------------------------ the two model steps

export const PostLabelSchema = z.object({
  label: z.enum(["new_show", "event_change", "new_release", "other"]),
  confidence: z.number(),
  reason: z.string(),
});
export type PostLabel = z.infer<typeof PostLabelSchema>;

const SORT_SYSTEM = `You sort Instagram posts by a performer (a musician, band, comedian, DJ, poet or speaker) for a city events guide in India.

Give exactly one label:
- "new_show": the post announces a specific upcoming show, gig or tour date the public can attend, with a place or a date. A tour poster listing several cities counts.
- "event_change": the post says an already announced show is cancelled, postponed, moved to another date or venue, or sold out.
- "new_release": the post announces a new professional release that is out now or has a stated release date: a single, album, EP, music video, comedy special, film or show they appear in, book or podcast episode.
- "other": everything else. Photos and recaps of past shows, thank-you posts, behind-the-scenes clips, brand deals and adverts, personal life, family, health, relationships, opinions, festival greetings, giveaways, memes, and vague teasers with no title or date.

When a post is about the performer's private life, the label is always "other", whatever else it mentions.
Captions may be in English, Hindi or Hinglish. Give your confidence in the label from 0 to 1, and a reason of at most 15 words.`;

export function sortRequest(id: string, artist: TrackedArtist, post: NormalisedPost, timeZone: string, tier: "fast" | "mid" = "fast"): LlmRequest<PostLabel> {
  const known = artist.events.length
    ? artist.events.map((e) => `- ${e.title}, ${e.date}, ${e.city}`).join("\n")
    : "(none)";
  const text = [
    `Performer: ${artist.name} (@${artist.handle})`,
    `Posted: ${post.postedAt ? localDate(post.postedAt, timeZone) : "unknown"}`,
    `Shows of theirs we already list:\n${known}`,
    "",
    "Caption:",
    post.caption.trim().slice(0, 2500) || "(empty)",
  ].join("\n");
  return {
    id, tier, system: SORT_SYSTEM, content: [{ type: "text", text }], schema: PostLabelSchema,
    maxTokens: 200, effort: "low", estInputTokens: 420 + Math.ceil(text.length / 3), estOutputTokens: 45,
  };
}

export const ReleaseLineSchema = z.object({
  /** False when, on a careful read, this is not a professional release after all. */
  is_release: z.boolean(),
  update: z.string(),
});
export type ReleaseLine = z.infer<typeof ReleaseLineSchema>;

const LINE_SYSTEM = `You write one-line updates for a performer's page on a city events guide in India. The line is published as-is, so a wrong fact is worse than no line.

You are given the performer's name and the caption of their Instagram post announcing a release.
Write ONE plain sentence, at most ${cfg.updateMaxWords} words, in your own words, saying what was released: the kind of work (single, album, EP, music video, comedy special, film, book, podcast episode), its title, and where it is available or when it comes out if the caption says so.

Rules
- Use only facts stated in the caption. If the caption does not give the title of the work, set is_release to false.
- Third person, past or present tense, no exclamation marks, no praise, no emojis, no hashtags, no "check it out".
- Do not quote the caption, lyrics or dialogue. A title is the only thing you may repeat.
- Nothing about the performer's private life, health, family or relationships.
- If this is not a professional release (a teaser with no title, a repost, an advert), set is_release to false and return an empty update.`;

export function lineRequest(id: string, artistName: string, post: NormalisedPost, timeZone: string): LlmRequest<ReleaseLine> {
  const text = `Performer: ${artistName}\nPosted: ${post.postedAt ? localDate(post.postedAt, timeZone) : "unknown"}\n\nCaption:\n${post.caption.trim().slice(0, 2500)}`;
  return {
    id, tier: "mid", system: LINE_SYSTEM, content: [{ type: "text", text }], schema: ReleaseLineSchema,
    maxTokens: 300, effort: "low", estInputTokens: 380 + Math.ceil(text.length / 3), estOutputTokens: 60,
  };
}

/** Last guard on a line before it is stored: one sentence, within the word limit, nothing copied wholesale. */
export function cleanUpdate(line: string, caption: string): string | null {
  const text = line.replace(/\s+/g, " ").replace(/[#@]\S+/g, "").trim();
  if (!text || text.split(" ").length > cfg.updateMaxWords + 5) return null;
  if (text.length > 40 && caption.replace(/\s+/g, " ").includes(text)) return null; // lifted from the caption
  return /[.!?।]$/.test(text) ? text : `${text}.`;
}

// ------------------------------------------------------------------ the job step

export interface TrackingReport {
  status: string;
  tracked: number;
  due: number;
  checked: number;
  /** Tracked artists with no Instagram account on record: their posts cannot be checked. */
  noHandle: string[];
  /** Tracked artists whose account is already read daily or weekly as a handle; not paid for twice. */
  alreadyAHandle: string[];
  postsReturned: number;
  postsNew: number;
  byLabel: Record<PostLabel["label"], number>;
  /** Posts handed to the event pipeline. */
  sentToPipeline: number;
  updates: { artist: string; text: string; url: string }[];
  ignored: { artist: string; url: string; label: string; reason: string }[];
  estimatedUsd: number;
  scrapeUsd: number;
  modelUsd: number;
  errors: string[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function trackArtists(
  pool: Pool, apify: ApifyClient, llm: LlmClient,
  opts: { jobName: string; dryRun?: boolean; batch?: boolean; force?: boolean; slugs?: string[]; limit?: number; now?: Date },
): Promise<TrackingReport> {
  const now = opts.now ?? new Date();
  const rep: TrackingReport = {
    status: "ok", tracked: 0, due: 0, checked: 0, noHandle: [], alreadyAHandle: [], postsReturned: 0, postsNew: 0,
    byLabel: { new_show: 0, event_change: 0, new_release: 0, other: 0 }, sentToPipeline: 0, updates: [], ignored: [],
    estimatedUsd: 0, scrapeUsd: 0, modelUsd: 0, errors: [],
  };
  const finish = () => {
    for (const k of ["estimatedUsd", "scrapeUsd", "modelUsd"] as const) rep[k] = Number(rep[k].toFixed(4));
    return rep;
  };
  if (!cfg.enabled) { rep.status = "switched off (ARTIST_TRACKING=off)"; return rep; }

  const tracked = await trackedArtists(pool, { now, slugs: opts.slugs });
  rep.tracked = tracked.length;
  const handles = new Set((await pool.query<{ handle: string }>("SELECT handle FROM handles WHERE active")).rows.map((h) => h.handle));
  const withHandle = tracked.filter((a) => {
    if (!a.handle) { rep.noHandle.push(a.name); return false; }
    if (handles.has(a.handle)) { rep.alreadyAHandle.push(a.name); return false; }
    return true;
  });
  let due = withHandle.filter((a) => opts.force || !a.tracking_checked_at
    || (now.getTime() - a.tracking_checked_at.getTime()) / 3_600_000 >= cfg.everyHours);
  if (opts.limit) due = due.slice(0, opts.limit);
  rep.due = due.length;
  if (due.length === 0) { rep.status = tracked.length ? "no artist is due" : "no artist is being tracked"; return rep; }
  if (!opts.dryRun && !apifyConfig.instagramPostsActorId) throw new Error("APIFY_IG_POSTS_ACTOR_ID (or APIFY_ACTOR_ID) is not set");

  const zones = new Map((await pool.query<{ id: number; timezone: string }>("SELECT id, timezone FROM cities")).rows.map((c) => [Number(c.id), c.timezone]));
  const fresh: { artist: TrackedArtist; post: NormalisedPost }[] = [];
  const firstTime = due.filter((a) => !a.tracking_checked_at);
  const repeat = due.filter((a) => a.tracking_checked_at);
  for (const group of [...chunk(firstTime, ingestion.handlesPerActorRun), ...chunk(repeat, ingestion.handlesPerActorRun)]) {
    const oldest = group.reduce<Date | null>(
      (min, a) => (a.tracking_checked_at && (!min || a.tracking_checked_at < min) ? a.tracking_checked_at : min), null);
    const newerThan = oldest ? new Date(oldest.getTime() - 86_400_000) : new Date(now.getTime() - cfg.firstCheckLookbackDays * 86_400_000);
    const maxPosts = group.length * ingestion.postsPerHandle;
    const estimate = maxPosts * apifyConfig.usdPerPost;
    rep.estimatedUsd += estimate;
    const actorId = apifyConfig.instagramPostsActorId;
    let items: Record<string, unknown>[] | undefined;
    try {
      items = await guardedCall(
        {
          bucket: "scrape", subBudget: "artistTracking", service: "apify", model: actorId || "(actor not set)",
          units: maxPosts, unitLabel: "posts", estimatedUsd: estimate, jobName: opts.jobName, dryRun: opts.dryRun,
        },
        async () => {
          const run = await apify.runActor(actorId, buildActorInput(actorId, group.map((a) => a.handle!), newerThan), { maxChargeUsd: estimate, maxItems: maxPosts });
          return { result: run.items, actualUsd: run.items.length * apifyConfig.usdPerPost, units: run.items.length };
        },
        { pool },
      );
    } catch (err) {
      // This source's monthly limit is reached: stop tracking for now, but let the rest of the job run.
      if ((err as Error).name === "BudgetExceededError") { rep.status = `stopped by the budget guard: ${(err as Error).message}`; break; }
      rep.errors.push(`${group.map((a) => a.handle).join(", ")}: ${(err as Error).message}`.slice(0, 400));
      continue;
    }
    if (opts.dryRun || !items) continue;

    rep.postsReturned += items.length;
    rep.scrapeUsd += items.length * apifyConfig.usdPerPost;
    const byHandle = new Map(group.map((a) => [a.handle!, a]));
    for (const item of items) {
      const post = normalisePost(item);
      if (!post) {
        const which = profileOf(item.inputUrl);
        rep.errors.push(`${which ? `@${which}: ` : ""}${String(item.errorDescription ?? item.error ?? "unusable item")}`.slice(0, 200));
        continue;
      }
      // A collab post sits on the artist's profile but may be owned by another account: file it under the profile asked for.
      const artist = byHandle.get(profileOf(item.inputUrl) ?? "") ?? byHandle.get(post.handle);
      if (!artist || post.isPinned) continue;
      if ((await pool.query("SELECT 1 FROM artist_posts WHERE shortcode = $1", [post.shortcode])).rowCount) continue;
      fresh.push({ artist, post });
    }
    await pool.query("UPDATE artists SET tracking_checked_at = $1 WHERE id = ANY($2)", [now, group.map((a) => a.id)]);
    rep.checked += group.length;
  }
  if (opts.dryRun) {
    rep.status = `dry run: would check ${due.length} artist(s), up to ${due.length * ingestion.postsPerHandle} posts, at most $${rep.estimatedUsd.toFixed(2)} to scrape`;
    return finish();
  }
  rep.postsNew = fresh.length;
  if (fresh.length === 0) return finish();

  // Sort every new post with the fast model; an unsure answer gets one second opinion from the mid tier.
  const run = { jobName: opts.jobName, batch: opts.batch, subBudget: "artistText" as const, pool };
  const zone = (a: TrackedArtist) => zones.get(a.city_id) ?? "Asia/Kolkata";
  const key = (i: number) => String(i);
  const labels = new Map<number, PostLabel>();
  const spent = new Map<number, number>();
  const add = (i: number, usd: number) => { spent.set(i, (spent.get(i) ?? 0) + usd); rep.modelUsd += usd; };
  const first = await llm.run(fresh.map((f, i) => sortRequest(key(i), f.artist, f.post, zone(f.artist))), run);
  const unsure: number[] = [];
  for (const r of first) {
    const i = Number(r.id);
    add(i, r.usd);
    if (r.ok && r.data && r.data.confidence >= cfg.minConfidence) labels.set(i, r.data);
    else unsure.push(i);
  }
  const second = await llm.run(unsure.map((i) => sortRequest(key(i), fresh[i].artist, fresh[i].post, zone(fresh[i].artist), "mid")), run);
  for (const r of second) {
    const i = Number(r.id);
    add(i, r.usd);
    // Still unsure after the second opinion: ignore the post rather than publish on a guess.
    labels.set(i, r.ok && r.data && r.data.confidence >= cfg.minConfidence ? r.data
      : { label: "other", confidence: r.data?.confidence ?? 0, reason: `unsure after a second opinion${r.data ? ` (looked like ${r.data.label})` : ""}` });
  }

  // A release gets one line in our own words from the mid tier.
  const releases = fresh.map((_, i) => i).filter((i) => labels.get(i)?.label === "new_release");
  const lines = new Map<number, string>();
  for (const r of await llm.run(releases.map((i) => lineRequest(key(i), fresh[i].artist.name, fresh[i].post, zone(fresh[i].artist))), run)) {
    const i = Number(r.id);
    add(i, r.usd);
    const text = r.ok && r.data?.is_release ? cleanUpdate(r.data.update, fresh[i].post.caption) : null;
    if (text) lines.set(i, text);
  }

  for (let i = 0; i < fresh.length; i++) {
    const { artist, post } = fresh[i];
    let { label, reason } = labels.get(i) ?? { label: "other" as const, reason: "no answer from the model" };
    const confidence = labels.get(i)?.confidence ?? 0;
    if (label === "new_release" && !lines.has(i)) { label = "other"; reason = "no release title could be stated from the post"; }
    rep.byLabel[label]++;
    await pool.query(
      `INSERT INTO artist_posts (artist_id, shortcode, post_url, posted_at, label, confidence, reason, update_text, model_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (shortcode) DO NOTHING`,
      [artist.id, post.shortcode, post.postUrl, post.postedAt, label, Math.max(0, Math.min(1, confidence)), reason.slice(0, 300), lines.get(i) ?? null, spent.get(i) ?? 0]);
    if (label === "new_show" || label === "event_change") {
      // Into the normal pipeline as an event post: extraction, the city check, confidence and dedup all apply as usual.
      const res = await pool.query(
        `INSERT INTO raw_posts (shortcode, handle, post_url, post_type, caption, media_urls, tagged_handles, posted_at, city_id, fetched_at, filter_result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'event') ON CONFLICT (shortcode) DO NOTHING`,
        [post.shortcode, artist.handle, post.postUrl, post.postType, post.caption, JSON.stringify(post.mediaUrls),
          JSON.stringify(post.taggedHandles), post.postedAt, artist.city_id, now]);
      rep.sentToPipeline += res.rowCount ?? 0;
    } else if (label === "new_release") {
      rep.updates.push({ artist: artist.name, text: lines.get(i)!, url: post.postUrl });
      await pool.query("UPDATE artists SET updated_at = now() WHERE id = $1", [artist.id]);
    }
    if (label === "other" && rep.ignored.length < 40) rep.ignored.push({ artist: artist.name, url: post.postUrl, label, reason });
  }
  return finish();
}
