/**
 * Snowball discovery (Prompt 9): a weekly, capped pull of recent Instagram
 * posts for a few city hashtags (and, once proven to work, venue location
 * tags). Its only purpose is to find accounts and places we do not know yet:
 *   - the posting account and every account tagged, mentioned or credited as
 *     a co-author becomes (or counts again as) a suggested handle;
 *   - the post's location tag becomes (or counts again as) a census place.
 * Nothing found here is published, and the posts themselves are not stored.
 * Suggested handles are ranked by how often they appear; the admin approves.
 */
import type { Pool } from "pg";
import { apify as apifyCfg, sourcing } from "../../config";
import { guardedCall } from "../budget-guard";
import type { ApifyClient } from "./apify";
import { normalisePost } from "./scrape";
import { forCity } from "./sourcing-data";
import { claimFetch } from "./sources";
import { nameKey } from "./text";

export interface DiscoveryReport {
  city: string;
  status: string;
  hashtags: number;
  locations: number;
  postsReturned: number;
  handlesSeen: number;
  newSuggestions: number;
  seenAgain: number;
  alreadyTracked: number;
  newPlaces: number;
  placesSeenAgain: number;
  spentUsd: number;
}

/** Which hashtag or location page a returned post came from. */
function origin(item: Record<string, unknown>): { via: "hashtag" | "location"; label: string } {
  const u = String(item.inputUrl ?? "");
  const tag = u.match(/explore\/tags\/([^/?#]+)/)?.[1];
  if (tag) return { via: "hashtag", label: `#${decodeURIComponent(tag)}` };
  const loc = u.match(/explore\/locations\/(\d+)/)?.[1];
  return loc ? { via: "location", label: `location ${loc}` } : { via: "hashtag", label: "a city hashtag" };
}

/** "Indore", "Indore, Madhya Pradesh" or "Indore City, India" is the city itself, not a place in it. */
export function isJustThePlace(location: string, city: string, state: string): boolean {
  const general = new Set([...`${city} ${state} india city district`.toLowerCase().split(/\s+/)]);
  return location.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).every((w) => general.has(w));
}

export async function runDiscovery(
  pool: Pool, client: ApifyClient,
  opts: { jobName: string; dryRun?: boolean; city?: string; maxPosts?: number; force?: boolean; now?: Date },
): Promise<DiscoveryReport[]> {
  const cfg = sourcing.discovery;
  const now = opts.now ?? new Date();
  const cities = (await pool.query<{ id: number; slug: string; name: string; state: string }>(
    "SELECT id, slug, name, state FROM cities WHERE is_live AND ($1::text IS NULL OR slug = $1) ORDER BY id", [opts.city ?? null])).rows;
  const reports: DiscoveryReport[] = [];

  for (const city of cities) {
    const rep: DiscoveryReport = {
      city: city.slug, status: "ok", hashtags: 0, locations: 0, postsReturned: 0, handlesSeen: 0, newSuggestions: 0,
      seenAgain: 0, alreadyTracked: 0, newPlaces: 0, placesSeenAgain: 0, spentUsd: 0,
    };
    reports.push(rep);
    const tags = forCity(city.slug).hashtags;
    const locations = cfg.locationsPerWeek > 0
      ? (await pool.query<{ source_ref: string }>(
          `SELECT source_ref FROM venue_census WHERE city_id = $1 AND source = 'instagram_location' AND NOT ignored
           ORDER BY seen_count DESC, id LIMIT $2`, [city.id, cfg.locationsPerWeek])).rows.map((r) => r.source_ref)
      : [];
    const urls = [
      ...tags.map((t) => `https://www.instagram.com/explore/tags/${encodeURIComponent(t.replace(/^#/, ""))}/`),
      ...locations.map((id) => `https://www.instagram.com/explore/locations/${id}/`),
    ];
    rep.hashtags = tags.length;
    rep.locations = locations.length;
    if (urls.length === 0) { rep.status = "no hashtags or locations for this city in data/sourcing.json"; continue; }
    const cap = Math.min(opts.maxPosts ?? cfg.maxPostsPerWeek, cfg.maxPostsPerWeek);
    const perUrl = Math.max(1, Math.floor(cap / urls.length));
    const maxItems = perUrl * urls.length;
    const due = opts.force || await claimFetch(pool, `discovery:${city.slug}`, cfg.everyHours, !!opts.dryRun);
    if (!due) { rep.status = "not due (weekly)"; continue; }

    const estimate = maxItems * apifyCfg.usdPerPost;
    const items = await guardedCall(
      {
        bucket: "scrape", subBudget: "discovery", service: "apify", model: `${cfg.actorId} (discovery)`,
        units: maxItems, unitLabel: "posts", estimatedUsd: estimate, jobName: opts.jobName, dryRun: opts.dryRun,
      },
      async () => {
        const since = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
        const run = await client.runActor(cfg.actorId, {
          directUrls: urls, resultsType: "posts", resultsLimit: perUrl, onlyPostsNewerThan: since, skipPinnedPosts: true,
        }, { maxChargeUsd: estimate, maxItems });
        return { result: run.items, actualUsd: run.items.length * apifyCfg.usdPerPost, units: run.items.length };
      },
      { pool },
    );
    if (opts.dryRun || !items) { rep.status = `dry run: would pull up to ${maxItems} posts (${perUrl} per page), about $${estimate.toFixed(2)}`; continue; }
    rep.postsReturned = items.length;
    rep.spentUsd = Number((items.length * apifyCfg.usdPerPost).toFixed(4));

    const seen = new Map<string, { via: "hashtag" | "location"; label: string; post: string }>();
    const places = new Map<string, { name: string; count: number }>();
    for (const item of items) {
      const post = normalisePost(item);
      if (!post) continue;
      const from = origin(item);
      for (const h of [post.handle, ...post.taggedHandles]) if (!seen.has(h)) seen.set(h, { ...from, post: post.shortcode });
      const locId = item.locationId ?? (item.location as Record<string, unknown> | undefined)?.id;
      const locName = typeof item.locationName === "string" ? item.locationName.trim() : "";
      const key = nameKey(locName, city.name);
      if (locId && locName && key && !isJustThePlace(locName, city.name, city.state)) {
        const p = places.get(String(locId)) ?? { name: locName, count: 0 };
        p.count++;
        places.set(String(locId), p);
      }
    }
    rep.handlesSeen = seen.size;
    const tracked = new Set((await pool.query<{ handle: string }>("SELECT handle FROM handles WHERE handle = ANY($1)", [[...seen.keys()]])).rows.map((r) => r.handle));
    for (const [handle, s] of seen) {
      if (tracked.has(handle)) { rep.alreadyTracked++; continue; }
      const r = await pool.query<{ inserted: boolean }>(
        `INSERT INTO suggested_handles (handle, city_id, reason, first_seen_post, via, last_seen_at) VALUES ($1,$2,$3,$4,ARRAY[$5::text],now())
         ON CONFLICT (handle) DO UPDATE SET seen_count = suggested_handles.seen_count + 1, last_seen_at = now(), updated_at = now(),
           via = CASE WHEN $5::text = ANY(suggested_handles.via) THEN suggested_handles.via ELSE suggested_handles.via || ARRAY[$5::text] END
         RETURNING (xmax = 0) AS inserted`,
        [handle, city.id, `seen in posts under ${s.label}`, s.post, s.via]);
      if (r.rows[0].inserted) rep.newSuggestions++; else rep.seenAgain++;
    }
    for (const [id, p] of places) {
      const r = await pool.query<{ inserted: boolean }>(
        `INSERT INTO venue_census (city_id, name, name_key, source, source_ref, seen_count) VALUES ($1,$2,$3,'instagram_location',$4,$5)
         ON CONFLICT (city_id, source, source_ref) WHERE source_ref IS NOT NULL
         DO UPDATE SET seen_count = venue_census.seen_count + EXCLUDED.seen_count, last_seen_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [city.id, p.name, nameKey(p.name, city.name), id, p.count]);
      if (r.rows[0].inserted) rep.newPlaces++; else rep.placesSeenAgain++;
    }
  }
  return reports;
}
