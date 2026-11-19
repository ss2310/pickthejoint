/**
 * Scrape job: fetch the latest posts of handles that are due and store the
 * new ones in raw_posts. Tier A is due daily, tier B weekly. A post is never
 * stored twice (shortcode is unique) and the actor is asked only for posts
 * newer than the handle's last check, so repeats are not paid for.
 */
import type { Pool } from "pg";
import { apify, ingestion } from "../../config";
import { guardedCall } from "../budget-guard";
import type { ApifyClient } from "./apify";

export interface DueHandle {
  id: number;
  handle: string;
  handle_type: string;
  tier: "A" | "B";
  city_id: number;
  city_slug: string;
  last_checked_at: Date | null;
}

export interface NormalisedPost {
  shortcode: string;
  handle: string;
  postUrl: string;
  postType: "image" | "carousel" | "reel";
  caption: string;
  /** Image URLs for the vision step (reference only; never rehosted). */
  mediaUrls: string[];
  /** Accounts tagged, credited as co-authors or @mentioned. */
  taggedHandles: string[];
  postedAt: Date | null;
  isPinned: boolean;
}

const HANDLE_RE = /^[a-z0-9._]{1,30}$/;

function usernames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((u) => (typeof u === "string" ? u : (u as { username?: unknown })?.username))
    .filter((u): u is string => typeof u === "string")
    .map((u) => u.toLowerCase().replace(/^@/, ""));
}

/** Maps one dataset item from Apify's Instagram post actors to our shape; null if unusable. */
export function normalisePost(item: Record<string, unknown>): NormalisedPost | null {
  const shortcode = typeof item.shortCode === "string" ? item.shortCode : undefined;
  const handle = typeof item.ownerUsername === "string" ? item.ownerUsername.toLowerCase() : undefined;
  if (!shortcode || !handle) return null; // error rows ("no posts found") have neither
  const caption = typeof item.caption === "string" ? item.caption : "";
  const type = String(item.type ?? "").toLowerCase();
  const postType = type === "video" || item.productType === "clips" ? "reel" : type === "sidecar" ? "carousel" : "image";
  const media: string[] = [];
  const push = (u: unknown) => { if (typeof u === "string" && u.startsWith("http") && !media.includes(u)) media.push(u); };
  push(item.displayUrl);
  if (Array.isArray(item.images)) item.images.forEach(push);
  if (Array.isArray(item.childPosts)) item.childPosts.forEach((c) => push((c as { displayUrl?: unknown })?.displayUrl));
  const mentions = [...caption.matchAll(/@([A-Za-z0-9._]{1,30})/g)].map((m) => m[1].toLowerCase().replace(/\.+$/, ""));
  const tagged = [...usernames(item.taggedUsers), ...usernames(item.coauthorProducers), ...usernames(item.mentions), ...mentions]
    .filter((h, i, all) => HANDLE_RE.test(h) && h !== handle && all.indexOf(h) === i);
  const ts = typeof item.timestamp === "string" ? new Date(item.timestamp) : null;
  return {
    shortcode,
    handle,
    postUrl: typeof item.url === "string" ? item.url : `https://www.instagram.com/p/${shortcode}/`,
    postType,
    caption,
    mediaUrls: media,
    taggedHandles: tagged,
    postedAt: ts && !Number.isNaN(ts.getTime()) ? ts : null,
    isPinned: item.isPinned === true,
  };
}

/** The handle a profile URL points at ("https://www.instagram.com/name/" -> "name"). */
export function profileOf(inputUrl: unknown): string | null {
  const m = typeof inputUrl === "string" ? inputUrl.match(/instagram\.com\/([A-Za-z0-9._]+)\/?(?:[?#].*)?$/) : null;
  return m ? m[1].toLowerCase() : null;
}

export interface DueOptions {
  city?: string;
  handles?: string[];
  /** With `handles`: check them even if they are not due. */
  force?: boolean;
  limit?: number;
  now?: Date;
}

/** Active handles due a check: tier A daily (at most 50 per city), tier B weekly. */
export async function dueHandles(pool: Pool, opts: DueOptions = {}): Promise<DueHandle[]> {
  const now = opts.now ?? new Date();
  const { rows } = await pool.query<DueHandle>(
    `SELECT h.id, h.handle, h.handle_type, h.tier, h.city_id, c.slug AS city_slug, h.last_checked_at
     FROM handles h JOIN cities c ON c.id = h.city_id
     WHERE h.active
       AND ($1::text IS NULL OR c.slug = $1)
       AND ($2::text[] IS NULL OR h.handle = ANY($2))
     ORDER BY h.last_checked_at ASC NULLS FIRST, h.id`,
    [opts.city ?? null, opts.handles?.length ? opts.handles : null],
  );
  const hoursSince = (d: Date | null) => (d ? (now.getTime() - d.getTime()) / 3_600_000 : Infinity);
  const tierACount = new Map<number, number>();
  const due = rows.filter((h) => {
    if (h.tier === "A") {
      // The cap applies to the tier A set itself, not just to today's due ones.
      const n = (tierACount.get(h.city_id) ?? 0) + 1;
      tierACount.set(h.city_id, n);
      if (n > ingestion.tierAMaxPerCity) return false;
    }
    if (opts.force && opts.handles?.length) return true;
    return hoursSince(h.last_checked_at) >= (h.tier === "A" ? ingestion.tierAIntervalHours : ingestion.tierBIntervalHours);
  });
  return opts.limit ? due.slice(0, opts.limit) : due;
}

export interface ScrapeReport {
  handlesDue: number;
  handlesChecked: number;
  actorRuns: number;
  postsReturned: number;
  postsNew: number;
  postsAlreadyStored: number;
  estimatedUsd: number;
  spentUsd: number;
  errors: string[];
  /** Runs that had to use the fallback actor because the main one failed twice in a row. */
  fallbackRuns: number;
  /** Handles the actor returned no posts and no named error for: a wrong handle, or nothing recent. */
  handlesWithNothing: string[];
}

/** Input for Apify's Instagram post actors (apify/instagram-post-scraper and apify/instagram-scraper). */
export function buildActorInput(actorId: string, handles: string[], newerThan: Date): Record<string, unknown> {
  const since = newerThan.toISOString().slice(0, 10);
  if (/instagram-scraper$/.test(actorId)) {
    return {
      directUrls: handles.map((h) => `https://www.instagram.com/${h}/`),
      resultsType: "posts",
      resultsLimit: ingestion.postsPerHandle,
      onlyPostsNewerThan: since,
      skipPinnedPosts: true,
    };
  }
  return {
    username: handles,
    resultsLimit: ingestion.postsPerHandle,
    onlyPostsNewerThan: since,
    skipPinnedPosts: true,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function scrapeInstagram(
  pool: Pool,
  client: ApifyClient,
  opts: DueOptions & { dryRun?: boolean; jobName: string },
): Promise<ScrapeReport> {
  const now = opts.now ?? new Date();
  const due = await dueHandles(pool, opts);
  const report: ScrapeReport = {
    handlesDue: due.length, handlesChecked: 0, actorRuns: 0, postsReturned: 0, postsNew: 0,
    postsAlreadyStored: 0, estimatedUsd: 0, spentUsd: 0, errors: [], fallbackRuns: 0, handlesWithNothing: [],
  };
  if (due.length === 0) return report;
  if (!opts.dryRun && !apify.instagramPostsActorId) throw new Error("APIFY_IG_POSTS_ACTOR_ID (or APIFY_ACTOR_ID) is not set");

  // Never-checked handles look back a fixed window; the rest only since their last check.
  const firstTime = due.filter((h) => !h.last_checked_at);
  const repeat = due.filter((h) => h.last_checked_at);
  const groups = [...chunk(firstTime, ingestion.handlesPerActorRun), ...chunk(repeat, ingestion.handlesPerActorRun)];

  for (const group of groups) {
    const oldest = group.reduce<Date | null>(
      (min, h) => (h.last_checked_at && (!min || h.last_checked_at < min) ? h.last_checked_at : min), null);
    // One day of overlap covers clock drift; the shortcode check drops the repeats.
    const newerThan = oldest
      ? new Date(oldest.getTime() - 86_400_000)
      : new Date(now.getTime() - ingestion.firstCheckLookbackDays * 86_400_000);
    const maxPosts = group.length * ingestion.postsPerHandle;
    const estimate = maxPosts * apify.usdPerPost;
    report.estimatedUsd += estimate;
    const names = group.map((h) => h.handle);

    let items: Record<string, unknown>[] | undefined;
    try {
      items = await guardedCall(
        {
          bucket: "scrape", service: "apify", model: apify.instagramPostsActorId || "(actor not set)",
          units: maxPosts, unitLabel: "posts", estimatedUsd: estimate, jobName: opts.jobName, dryRun: opts.dryRun,
        },
        async () => {
          const attempt = (actorId: string) =>
            client.runActor(actorId, buildActorInput(actorId, names, newerThan), { maxChargeUsd: estimate, maxItems: maxPosts });
          let run;
          try {
            run = await attempt(apify.instagramPostsActorId);
          } catch (first) {
            console.warn(`[scrape] actor failed, retrying once: ${(first as Error).message}`);
            try {
              run = await attempt(apify.instagramPostsActorId);
            } catch (second) {
              // Two failures in a row: switch to the fallback actor for this run, if one is configured.
              if (!apify.instagramPostsFallbackActorId) throw second;
              console.warn(`[scrape] actor failed twice, using fallback ${apify.instagramPostsFallbackActorId}: ${(second as Error).message}`);
              run = await attempt(apify.instagramPostsFallbackActorId);
              report.fallbackRuns++;
            }
          }
          return { result: run.items, actualUsd: run.items.length * apify.usdPerPost, units: run.items.length };
        },
        { pool },
      );
    } catch (err) {
      if ((err as Error).name === "BudgetExceededError") throw err;
      report.errors.push(`${names.join(", ")}: ${(err as Error).message}`);
      continue;
    }
    if (opts.dryRun || !items) continue;

    report.actorRuns++;
    report.postsReturned += items.length;
    report.spentUsd += items.length * apify.usdPerPost;
    const cityOf = new Map(group.map((h) => [h.handle, h.city_id]));
    const seen = new Set<string>();
    for (const item of items) {
      const post = normalisePost(item);
      if (!post) {
        // Error rows ("Profile does not exist", "Empty or private data") are still charged by the actor.
        const why = String(item.errorDescription ?? item.error ?? "unusable item");
        const which = profileOf(item.inputUrl);
        report.errors.push(which ? `@${which}: ${why}` : why);
        if (which) seen.add(which);
        continue;
      }
      // A collab post appears on our handle's profile but is owned by the other account:
      // file it under the profile it was fetched from, and keep the owner as a tagged account.
      const profile = profileOf(item.inputUrl);
      const handle = profile && cityOf.has(profile) ? profile : post.handle;
      if (!cityOf.has(handle)) continue;
      seen.add(handle);
      if (post.isPinned) continue;
      const tagged = handle === post.handle ? post.taggedHandles : [...new Set([post.handle, ...post.taggedHandles])].filter((h) => h !== handle);
      const res = await pool.query(
        `INSERT INTO raw_posts (shortcode, handle, post_url, post_type, caption, media_urls, tagged_handles, posted_at, city_id, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (shortcode) DO NOTHING`,
        [post.shortcode, handle, post.postUrl, post.postType, post.caption, JSON.stringify(post.mediaUrls),
          JSON.stringify(tagged), post.postedAt, cityOf.get(handle), now],
      );
      if (res.rowCount) report.postsNew++; else report.postsAlreadyStored++;
    }
    for (const h of names) if (!seen.has(h)) report.handlesWithNothing.push(h);
    await pool.query("UPDATE handles SET last_checked_at = $1, updated_at = now() WHERE id = ANY($2)", [now, group.map((h) => h.id)]);
    report.handlesChecked += group.length;
  }
  report.estimatedUsd = Number(report.estimatedUsd.toFixed(4));
  report.spentUsd = Number(report.spentUsd.toFixed(4));
  return report;
}
