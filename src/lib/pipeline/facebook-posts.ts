/**
 * Posts of public Facebook pages (the owner's decision of 19 Nov 2026). Most
 * pages announce events in ordinary posts and flyers, not through Facebook's
 * Events feature, so the newest posts of each page on record are read, logged
 * out, through an Apify actor (no Facebook account is used).
 *
 * This step only fetches and stores: new posts land in raw_posts as
 * source_kind 'facebook' with a shortcode of "fbp:<post id>", and the normal
 * pipeline (filter -> extract -> match / dedup -> publish or review) does the
 * rest, exactly as for Instagram posts. Images are never stored, only their
 * links for the one reading (hard rule 4).
 *
 * Cost control: the actor is asked only for posts newer than the page's last
 * check, a page's tier sets how often it is read and how many posts are taken,
 * a page that never yields an event drops to the slowest pace by itself, and
 * the `facebookPosts` sub-budget caps the month.
 */
import type { Pool } from "pg";
import { sourcing } from "../../config";
import { guardedCall } from "../budget-guard";
import type { ApifyClient } from "./apify";
import { facebookPage } from "./facebook";
import { forCity } from "./sourcing-data";

export type PageTier = "A" | "B" | "C";

export interface FacebookPost {
  id: string;
  url: string;
  text: string;
  /** Text the actor read off the post's images; helps the caption filter with flyer-only posts. */
  imageText: string;
  mediaUrls: string[];
  postedAt: Date | null;
  isVideo: boolean;
  /** The page the post was fetched from, lower-cased, when the item says so. */
  page: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const pageKey = (v: unknown) => (typeof v === "string" ? facebookPage(v.split(/[?#]/)[0]) : null)?.toLowerCase() ?? null;

/** Maps one item of apify/facebook-posts-scraper to our shape; null for error rows and anything without an id and a link. */
export function facebookPost(item: Record<string, unknown>): FacebookPost | null {
  const url = str(item.url) ?? str(item.topLevelUrl);
  const id = str(item.postId) ?? (typeof item.postId === "number" ? String(item.postId) : null)
    ?? url?.match(/\/(?:posts|videos|reel|photos)\/(?:[^/?#]+\/)*([A-Za-z0-9]{6,})\/?(?:[?#].*)?$/)?.[1] ?? null;
  if (!id || !url || !/^https?:\/\//.test(url)) return null;
  const media = Array.isArray(item.media) ? (item.media as Record<string, unknown>[]) : [];
  const mediaUrls: string[] = [];
  const imageText: string[] = [];
  for (const m of media) {
    if (!m || typeof m !== "object") continue;
    const image = str((m.photo_image as Record<string, unknown> | undefined)?.uri) ?? str(m.thumbnail);
    if (image && image.startsWith("http") && !mediaUrls.includes(image)) mediaUrls.push(image);
    const read = str(m.ocrText);
    if (read && !imageText.includes(read)) imageText.push(read);
  }
  const iso = str(item.time);
  const secs = typeof item.timestamp === "number" ? item.timestamp : null;
  const when = iso ? new Date(iso) : secs ? new Date(secs * 1000) : null;
  return {
    id, url, text: str(item.text) ?? "", imageText: imageText.join("\n"), mediaUrls,
    postedAt: when && !Number.isNaN(when.getTime()) ? when : null,
    isVideo: /\/(videos|reel)\//.test(url) || media.some((m) => m && typeof m === "object" && /video/i.test(String(m.__typename ?? ""))),
    page: pageKey(item.inputUrl) ?? pageKey(item.facebookUrl) ?? str(item.pageName)?.toLowerCase() ?? null,
  };
}

/** What is stored as the post's caption: its text, then any text read off its images. */
export function postCaption(post: FacebookPost): string {
  const parts = [post.text, post.imageText && `Text on the image (read automatically, may contain errors):\n${post.imageText}`].filter(Boolean);
  return parts.join("\n\n").slice(0, sourcing.facebookPosts.maxChars);
}

export interface DuePage {
  id: number;
  page: string;
  tier: PageTier;
  /** The pace the page is actually read at: its tier, or C once it has proved quiet. */
  pace: PageTier;
  city_filter: boolean;
  posts_checked_at: Date | null;
}

/** Active pages of a city that are due a posts check, tier A first, then the longest unchecked. */
export async function dueFacebookPages(
  pool: Pool, cityId: number, opts: { now?: Date; force?: boolean; limit?: number } = {},
): Promise<DuePage[]> {
  const cfg = sourcing.facebookPosts;
  const now = opts.now ?? new Date();
  const { rows } = await pool.query<Omit<DuePage, "pace"> & { posts_seen: number; event_posts: number }>(
    `SELECT f.id, f.page, f.tier, f.city_filter, f.posts_checked_at, f.posts_seen,
            (SELECT count(*) FROM raw_posts rp
              WHERE rp.source_kind = 'facebook' AND rp.handle = f.page AND rp.city_id = f.city_id AND rp.shortcode LIKE 'fbp:%'
                AND rp.processing_state IN ('published', 'merged', 'queued_review'))::int AS event_posts
     FROM facebook_pages f WHERE f.city_id = $1 AND f.active
     ORDER BY f.posts_checked_at ASC NULLS FIRST, f.id`, [cityId]);
  const due = rows
    .map((r): DuePage => ({
      id: r.id, page: r.page, tier: r.tier, city_filter: r.city_filter, posts_checked_at: r.posts_checked_at,
      pace: r.posts_seen >= cfg.quietAfterPosts && r.event_posts === 0 ? "C" : r.tier,
    }))
    .filter((p) => opts.force || !p.posts_checked_at
      || (now.getTime() - p.posts_checked_at.getTime()) / 3_600_000 >= cfg.tiers[p.pace].everyHours)
    .sort((a, b) => a.pace.localeCompare(b.pace));
  return due.slice(0, Math.min(opts.limit ?? cfg.maxPagesPerRun, cfg.maxPagesPerRun));
}

export interface FacebookPostsReport {
  status: string;
  pagesKnown: number;
  pagesDue: number;
  pagesChecked: number;
  actorRuns: number;
  /** The most posts the due pages could return, which is what the estimate is priced on. */
  maxPosts: number;
  postsReturned: number;
  postsNew: number;
  alreadyStored: number;
  /** Posts from statewide or national pages that did not name the city: dropped before any model call. */
  otherCity: number;
  skipped: number;
  /** Why items were set aside (first few), so a change in the actor's output shows up in the run report. */
  skipReasons: string[];
  /** Pages the actor returned nothing for: a wrong address, a page it cannot read, or nothing new. */
  pagesWithNothing: string[];
  estimatedUsd: number;
  spentUsd: number;
  errors: string[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function fetchFacebookPosts(
  pool: Pool, apify: ApifyClient,
  opts: { jobName: string; dryRun?: boolean; city?: string; maxPages?: number; force?: boolean; now?: Date },
): Promise<FacebookPostsReport> {
  const cfg = sourcing.facebookPosts;
  const now = opts.now ?? new Date();
  const rep: FacebookPostsReport = {
    status: "ok", pagesKnown: 0, pagesDue: 0, pagesChecked: 0, actorRuns: 0, maxPosts: 0, postsReturned: 0, postsNew: 0,
    alreadyStored: 0, otherCity: 0, skipped: 0, skipReasons: [], pagesWithNothing: [], estimatedUsd: 0, spentUsd: 0, errors: [],
  };
  const finish = () => { rep.estimatedUsd = Number(rep.estimatedUsd.toFixed(4)); rep.spentUsd = Number(rep.spentUsd.toFixed(4)); return rep; };
  if (!cfg.enabled) { rep.status = "switched off (set FACEBOOK_POSTS=on to start)"; return rep; }
  const skip = (why: string) => { rep.skipped++; if (rep.skipReasons.length < 5) rep.skipReasons.push(why.slice(0, 200)); };
  const cities = (await pool.query<{ id: number; slug: string; name: string }>(
    "SELECT id, slug, name FROM cities WHERE is_live AND ($1::text IS NULL OR slug = $1) ORDER BY id", [opts.city ?? null])).rows;

  for (const city of cities) {
    rep.pagesKnown += Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM facebook_pages WHERE city_id = $1 AND active", [city.id])).rows[0].n);
    const due = await dueFacebookPages(pool, city.id, { now, force: opts.force, limit: opts.maxPages });
    rep.pagesDue += due.length;
    if (due.length === 0) { if (rep.status === "ok") rep.status = rep.pagesKnown ? "no page is due" : "no Facebook pages on record yet"; continue; }
    const cityNames = [city.name, ...forCity(city.slug).cityNames].map((n) => n.toLowerCase());

    // One actor run takes one posts limit and one "newer than" date, so pages are grouped by both.
    const groups = new Map<string, DuePage[]>();
    for (const p of due) {
      const key = `${cfg.tiers[p.pace].posts}:${p.posts_checked_at ? "repeat" : "first"}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    for (const group of [...groups.values()].flatMap((g) => chunk(g, cfg.pagesPerActorRun))) {
      const limit = cfg.tiers[group[0].pace].posts;
      const oldest = group.reduce<Date | null>(
        (min, p) => (p.posts_checked_at && (!min || p.posts_checked_at < min) ? p.posts_checked_at : min), null);
      // One day of overlap covers clock drift; the shortcode check drops the repeats.
      const newerThan = oldest
        ? new Date(oldest.getTime() - 86_400_000)
        : new Date(now.getTime() - cfg.firstCheckLookbackDays * 86_400_000);
      const maxPosts = group.length * limit;
      const estimate = maxPosts * cfg.usdPerPost;
      rep.maxPosts += maxPosts;
      rep.estimatedUsd += estimate;

      let items: Record<string, unknown>[] | undefined;
      try {
        items = await guardedCall(
          {
            bucket: "scrape", subBudget: "facebookPosts", service: "apify", model: cfg.actorId,
            units: maxPosts, unitLabel: "posts", estimatedUsd: estimate, jobName: opts.jobName, dryRun: opts.dryRun,
          },
          async () => {
            const run = await apify.runActor(cfg.actorId, {
              startUrls: group.map((p) => ({ url: `https://www.facebook.com/${p.page}/` })),
              resultsLimit: limit,
              onlyPostsNewerThan: newerThan.toISOString().slice(0, 10),
            }, { maxChargeUsd: estimate, maxItems: maxPosts, timeoutSecs: 900 });
            return { result: run.items, actualUsd: run.items.length * cfg.usdPerPost, units: run.items.length };
          },
          { pool },
        );
      } catch (err) {
        // The month's limit for this source is reached: stop reading pages, but let the rest of the job run.
        if ((err as Error).name === "BudgetExceededError") { rep.status = `stopped by the budget guard: ${(err as Error).message}`; return finish(); }
        rep.errors.push(`${group.map((p) => p.page).join(", ")}: ${(err as Error).message}`.slice(0, 400));
        continue;
      }
      if (opts.dryRun || !items) continue;

      rep.actorRuns++;
      rep.postsReturned += items.length;
      rep.spentUsd += items.length * cfg.usdPerPost;
      const byKey = new Map(group.map((p) => [p.page.toLowerCase(), p]));
      const seen = new Map<number, number>();
      const tooOld = newerThan.getTime() - 2 * 86_400_000;
      for (const item of items) {
        const post = facebookPost(item);
        const page = byKey.get(post?.page ?? pageKey(item.inputUrl) ?? "") ?? (group.length === 1 ? group[0] : undefined);
        if (page) seen.set(page.id, (seen.get(page.id) ?? 0) + (post ? 1 : 0));
        if (!post) {
          const err = item.error ?? item.errorDescription ?? item.message;
          skip(err ? `actor said${page ? ` for ${page.page}` : ""}: ${String(err)}` : `unreadable item with fields: ${Object.keys(item).slice(0, 12).join(", ")}`);
          continue;
        }
        if (!page) { skip(`post from a page that was not asked for: ${post.url}`); continue; }
        if (post.postedAt && post.postedAt.getTime() < tooOld) { skip(`older than asked for (${post.postedAt.toISOString().slice(0, 10)}): ${post.url}`); continue; }
        const caption = postCaption(post);
        if (!caption && post.mediaUrls.length === 0) { skip(`nothing to read: ${post.url}`); continue; }
        if (page.city_filter && !cityNames.some((n) => caption.toLowerCase().includes(n))) { rep.otherCity++; continue; }
        const res = await pool.query(
          `INSERT INTO raw_posts (shortcode, handle, post_url, post_type, caption, media_urls, posted_at, source_kind, city_id, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'facebook',$8,$9) ON CONFLICT (shortcode) DO NOTHING`,
          [`fbp:${post.id}`, page.page, post.url, post.isVideo ? "reel" : post.mediaUrls.length ? "image" : null, caption,
            JSON.stringify(post.mediaUrls), post.postedAt, city.id, now]);
        if (res.rowCount) rep.postsNew++; else rep.alreadyStored++;
      }
      for (const p of group) {
        if (!seen.has(p.id)) rep.pagesWithNothing.push(p.page);
        await pool.query("UPDATE facebook_pages SET posts_checked_at = $2, posts_seen = posts_seen + $3 WHERE id = $1", [p.id, now, seen.get(p.id) ?? 0]);
      }
      rep.pagesChecked += group.length;
    }
    if (opts.dryRun) rep.status = `dry run: would read ${due.length} page(s), up to ${rep.maxPosts} posts, at most $${rep.estimatedUsd.toFixed(2)}`;
  }
  return finish();
}
