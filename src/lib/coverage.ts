/**
 * Weekly coverage report per city (Prompt 9): which sources find events, and
 * what each published event costs by source. Weeks are IST Monday to Sunday.
 * Housekeeping stores last week's report every Monday; the admin page also
 * shows the week so far, worked out on the spot.
 *
 * - An event is counted under the source that found it first. "Also found by
 *   another source" means a second, independent source confirmed it.
 * - Cost by source = scraping spend from cost_log (Apify, DataForSEO) in the
 *   week + model spend on that source's items fetched in the week (filtering,
 *   extraction, dedup and the event descriptions, recorded per item).
 */
import type { Pool } from "pg";
import { apify } from "../config";

export interface SourceLine {
  source: string;
  published: number;
  alsoFoundElsewhere: number;
  mergedIntoKnown: number;
  itemsFetched: number;
  scrapeUsd: number;
  modelUsd: number;
  costUsd: number;
  costPerPublishedUsd: number | null;
}

export interface CoverageReport {
  city: string;
  weekStart: string;
  weekEnd: string;
  eventsPublished: number;
  multiSourceShare: number | null;
  bySource: SourceLine[];
  newVenues: number;
  newCensusPlaces: Record<string, number>;
  newSuggestedHandles: number;
  handlesAdded: number;
  handleChanges: number;
  discoveryUsd: number;
  totalUsd: number;
}

/** Monday (IST) of the week containing `d`, as YYYY-MM-DD. */
export function weekStartIst(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 3_600_000);
  const day = (ist.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - day)).toISOString().slice(0, 10);
}

const label = (kind: string, handle: string | null, sourceType: string) =>
  sourceType === "submission" || sourceType === "poster" ? "submissions" : kind === "instagram" || !kind ? "instagram" : `${kind}:${handle}`;
const r4 = (n: number) => Number(n.toFixed(4));

export async function coverageReport(pool: Pool, citySlug: string, weekStart: string): Promise<CoverageReport | null> {
  const city = (await pool.query<{ id: number; name: string; timezone: string }>("SELECT id, name, timezone FROM cities WHERE slug = $1", [citySlug])).rows[0];
  if (!city) return null;
  const from = `${weekStart}T00:00:00+05:30`;
  const endDate = new Date(Date.parse(`${weekStart}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const to = `${endDate}T00:00:00+05:30`;
  const params = [city.id, from, to];

  // Events first published this week, with the source that found each first and how many independent sources it has.
  const events = (await pool.query<{ first_kind: string; first_handle: string | null; first_type: string; independent: number }>(
    `SELECT f.kind AS first_kind, f.handle AS first_handle, f.source_type AS first_type,
            (SELECT count(DISTINCT coalesce(rp.source_kind || ':' || rp.handle, s.source_type || ':' || s.id))
               FROM sources s LEFT JOIN raw_posts rp ON rp.id = s.raw_post_id WHERE s.event_id = e.id)::int AS independent
     FROM events e
     CROSS JOIN LATERAL (SELECT coalesce(rp.source_kind, '') AS kind, rp.handle, s.source_type
                         FROM sources s LEFT JOIN raw_posts rp ON rp.id = s.raw_post_id WHERE s.event_id = e.id ORDER BY s.id LIMIT 1) f
     WHERE e.city_id = $1 AND e.is_published AND e.created_at >= $2 AND e.created_at < $3`, params)).rows;

  // Items fetched this week by source, their model spend, and what they did to events.
  const items = (await pool.query<{ kind: string; handle: string; n: number; model_usd: string; merged: number }>(
    `SELECT rp.source_kind AS kind, rp.handle, count(*)::int AS n, coalesce(sum(rp.model_usd), 0) AS model_usd,
            count(*) FILTER (WHERE rp.processing_state = 'merged')::int AS merged
     FROM raw_posts rp WHERE rp.city_id = $1 AND rp.fetched_at >= $2 AND rp.fetched_at < $3
     GROUP BY 1, 2`, params)).rows;

  // Scraping spend by source this week. Instagram's main actor carries no sub-budget.
  const spend = (await pool.query<{ sub_budget: string | null; model: string | null; job_name: string; usd: string }>(
    `SELECT sub_budget, model, job_name, sum(estimated_usd) AS usd FROM cost_log
     WHERE NOT dry_run AND bucket = 'scrape' AND logged_at >= $1 AND logged_at < $2 GROUP BY 1, 2, 3`, [from, to])).rows;
  const scrape: Record<string, number> = {};
  let discoveryUsd = 0;
  for (const s of spend) {
    const usd = Number(s.usd);
    if (s.sub_budget === "discovery") discoveryUsd += usd;
    else if (s.sub_budget === "facebookEvents" || s.sub_budget === "facebookPosts") scrape["facebook"] = (scrape["facebook"] ?? 0) + usd;
    else if (s.sub_budget === "googleEvents") scrape["google"] = (scrape["google"] ?? 0) + usd;
    else if ((s.sub_budget === null || s.sub_budget === "reelTranscript") && s.job_name === "ingest") scrape["instagram"] = (scrape["instagram"] ?? 0) + usd;
  }

  const lines = new Map<string, SourceLine>();
  const line = (source: string) => {
    let l = lines.get(source);
    if (!l) { l = { source, published: 0, alsoFoundElsewhere: 0, mergedIntoKnown: 0, itemsFetched: 0, scrapeUsd: 0, modelUsd: 0, costUsd: 0, costPerPublishedUsd: null }; lines.set(source, l); }
    return l;
  };
  for (const e of events) {
    const l = line(label(e.first_kind, e.first_handle, e.first_type));
    l.published++;
    if (e.independent > 1) l.alsoFoundElsewhere++;
  }
  for (const it of items) {
    const l = line(label(it.kind, it.handle, ""));
    l.itemsFetched += it.n;
    l.modelUsd += Number(it.model_usd);
    l.mergedIntoKnown += it.merged;
  }
  // Facebook and Google scraping is per source kind, not per page: put it on the kind's first line.
  for (const [kind, usd] of Object.entries(scrape)) {
    const l = kind === "instagram" ? line("instagram") : [...lines.values()].find((x) => x.source.startsWith(`${kind}:`)) ?? line(`${kind}:all`);
    l.scrapeUsd += usd;
  }
  for (const l of lines.values()) {
    l.scrapeUsd = r4(l.scrapeUsd);
    l.modelUsd = r4(l.modelUsd);
    l.costUsd = r4(l.scrapeUsd + l.modelUsd);
    l.costPerPublishedUsd = l.published ? r4(l.costUsd / l.published) : null;
  }
  const one = async (sql: string, p: unknown[] = params) => Number((await pool.query<{ n: string }>(sql, p)).rows[0].n);
  const census = (await pool.query<{ source: string; n: number }>(
    "SELECT source, count(*)::int AS n FROM venue_census WHERE city_id = $1 AND first_seen_at >= $2 AND first_seen_at < $3 GROUP BY 1", params)).rows;
  const bySource = [...lines.values()].sort((a, b) => b.published - a.published || b.itemsFetched - a.itemsFetched);
  return {
    city: citySlug,
    weekStart,
    weekEnd: new Date(Date.parse(`${endDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10),
    eventsPublished: events.length,
    multiSourceShare: events.length ? Number((events.filter((e) => e.independent > 1).length / events.length).toFixed(3)) : null,
    bySource,
    newVenues: await one("SELECT count(*) AS n FROM venues WHERE city_id = $1 AND created_at >= $2 AND created_at < $3"),
    newCensusPlaces: Object.fromEntries(census.map((c) => [c.source, c.n])),
    newSuggestedHandles: await one("SELECT count(*) AS n FROM suggested_handles WHERE city_id = $1 AND created_at >= $2 AND created_at < $3"),
    handlesAdded: await one("SELECT count(*) AS n FROM handles WHERE city_id = $1 AND created_at >= $2 AND created_at < $3"),
    handleChanges: await one(
      "SELECT count(*) AS n FROM handle_changes hc JOIN handles h ON h.id = hc.handle_id WHERE h.city_id = $1 AND hc.changed_at >= $2 AND hc.changed_at < $3"),
    discoveryUsd: r4(discoveryUsd),
    totalUsd: r4(bySource.reduce((s, l) => s + l.costUsd, 0) + discoveryUsd),
  };
}

/** Stores last week's report for each live city (housekeeping, Mondays). */
export async function storeLastWeek(pool: Pool, now = new Date()): Promise<{ weekStart: string; cities: string[] }> {
  const lastWeek = weekStartIst(new Date(now.getTime() - 7 * 86_400_000));
  const cities = (await pool.query<{ slug: string; id: number }>("SELECT id, slug FROM cities WHERE is_live ORDER BY id")).rows;
  for (const c of cities) {
    const report = await coverageReport(pool, c.slug, lastWeek);
    await pool.query(
      `INSERT INTO coverage_reports (city_id, week_start, report) VALUES ($1,$2,$3)
       ON CONFLICT (city_id, week_start) DO UPDATE SET report = EXCLUDED.report, created_at = now()`, [c.id, lastWeek, report]);
  }
  return { weekStart: lastWeek, cities: cities.map((c) => c.slug) };
}

/** Stored weekly reports, newest first. */
export async function storedReports(pool: Pool, limit = 12): Promise<CoverageReport[]> {
  return (await pool.query<{ report: CoverageReport }>("SELECT report FROM coverage_reports ORDER BY week_start DESC, city_id LIMIT $1", [limit])).rows.map((r) => r.report);
}

/** Instagram's scraping cost per post on our plan, for the admin page. */
export const instagramUsdPerPost = apify.usdPerPost;
