/** Read queries for the admin area. Nothing here is used by a public page. */
import type { Pool } from "pg";
import { getPool } from "./db";
import { spendSummary } from "./pipeline/job";

export interface QueueItem {
  id: number; item_type: string; item_id: number | null; reason: string; payload: Record<string, unknown>; status: string;
  created_at: Date; resolved_at: Date | null; resolution_note: string | null;
}

export async function queueCounts(pool: Pool = getPool()): Promise<{ item_type: string; n: number }[]> {
  return (await pool.query<{ item_type: string; n: number }>(
    "SELECT item_type, count(*)::int AS n FROM review_queue WHERE status = 'open' GROUP BY item_type ORDER BY n DESC")).rows;
}

export async function queueItems(opts: { type?: string; status?: string; limit?: number }, pool: Pool = getPool()): Promise<QueueItem[]> {
  return (await pool.query<QueueItem>(
    `SELECT * FROM review_queue WHERE status = $1 AND ($2::text IS NULL OR item_type = $2)
     ORDER BY CASE item_type WHEN 'submission' THEN 0 WHEN 'poster' THEN 1 WHEN 'raw_post' THEN 2 ELSE 3 END, created_at DESC LIMIT $3`,
    [opts.status ?? "open", opts.type ?? null, opts.limit ?? 100])).rows;
}

export async function queueItem(id: number, pool: Pool = getPool()): Promise<QueueItem | null> {
  return (await pool.query<QueueItem>("SELECT * FROM review_queue WHERE id = $1", [id])).rows[0] ?? null;
}

/** The month's spend against each cap, plus by service and model and by job. Calendar month in UTC, as the budget guard counts. */
export async function spend(pool: Pool = getPool()) {
  const since = "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
  const caps = await spendSummary(pool);
  const byService = (await pool.query<{ bucket: string; service: string; model: string | null; usd: number; calls: number }>(
    `SELECT bucket, service, model, sum(estimated_usd)::float AS usd, count(*)::int AS calls FROM cost_log
     WHERE NOT dry_run AND logged_at >= ${since} GROUP BY 1, 2, 3 ORDER BY usd DESC`)).rows;
  const byJob = (await pool.query<{ job_name: string; usd: number; calls: number }>(
    `SELECT job_name, sum(estimated_usd)::float AS usd, count(*)::int AS calls FROM cost_log
     WHERE NOT dry_run AND logged_at >= ${since} GROUP BY 1 ORDER BY usd DESC`)).rows;
  return { caps, byService, byJob };
}

export interface JobRun { id: number; job_name: string; started_at: Date; finished_at: Date | null; status: string; report: Record<string, unknown>; error: string | null }

export async function lastRuns(pool: Pool = getPool()): Promise<JobRun[]> {
  return (await pool.query<JobRun>(
    "SELECT DISTINCT ON (job_name) id, job_name, started_at, finished_at, status, report, error FROM job_runs WHERE NOT dry_run ORDER BY job_name, started_at DESC")).rows;
}

export async function suggestedHandles(pool: Pool = getPool()) {
  return (await pool.query<{
    id: number; handle: string; city: string | null; reason: string | null; seen_count: number; first_seen_post: string | null; created_at: Date;
    via: string[]; event_posts: number; last_seen_at: Date | null;
  }>(
    `SELECT s.id, s.handle, c.slug AS city, s.reason, s.seen_count, s.first_seen_post, s.created_at, s.via, s.event_posts, s.last_seen_at
     FROM suggested_handles s LEFT JOIN cities c ON c.id = s.city_id WHERE s.status = 'pending' ORDER BY s.seen_count DESC, s.created_at DESC LIMIT 200`)).rows;
}

export async function handles(pool: Pool = getPool()) {
  return (await pool.query<{
    id: number; handle: string; handle_type: string; city: string; tier: "A" | "B"; active: boolean; last_checked_at: Date | null;
    tier_set_by: string; paused_reason: string | null; events30: number;
  }>(
    `SELECT h.id, h.handle, h.handle_type, c.slug AS city, h.tier, h.active, h.last_checked_at, h.tier_set_by, h.paused_reason,
            (SELECT count(DISTINCT s.event_id) FROM raw_posts rp JOIN sources s ON s.raw_post_id = rp.id
              WHERE rp.handle = h.handle AND rp.source_kind = 'instagram' AND s.observed_at >= now() - interval '30 days')::int AS events30
     FROM handles h JOIN cities c ON c.id = h.city_id ORDER BY h.active DESC, h.tier, h.handle`)).rows;
}

/** Automatic tier and pause changes, newest first. */
export async function handleChanges(pool: Pool = getPool(), limit = 30) {
  return (await pool.query<{ handle: string; changed_at: Date; from_tier: string | null; to_tier: string | null; to_active: boolean | null; reason: string }>(
    `SELECT h.handle, hc.changed_at, hc.from_tier, hc.to_tier, hc.to_active, hc.reason
     FROM handle_changes hc JOIN handles h ON h.id = hc.handle_id ORDER BY hc.changed_at DESC, hc.id DESC LIMIT $1`, [limit])).rows;
}

export interface PosterRow {
  id: number; channel: string; city: string | null; width: number | null; height: number | null; note: string | null; original_name: string | null;
  extraction: { is_event_post: boolean; notes: string; events: Record<string, unknown>[] } | null; extraction_state: string; extraction_error: string | null;
  delete_after: Date; created_at: Date; submissions: { id: number; status: string; title: string; event_id: number | null }[];
}

export async function posters(limit = 40, pool: Pool = getPool()): Promise<PosterRow[]> {
  return (await pool.query<PosterRow>(
    `SELECT p.id, p.channel, c.slug AS city, p.width, p.height, p.note, p.original_name, p.extraction, p.extraction_state, p.extraction_error,
            p.delete_after, p.created_at,
            coalesce((SELECT json_agg(json_build_object('id', s.id, 'status', s.status, 'title', s.fields->>'title', 'event_id', s.event_id) ORDER BY s.id)
                      FROM submissions s WHERE s.poster_id = p.id AND s.status <> 'draft'), '[]') AS submissions
     FROM poster_images p LEFT JOIN cities c ON c.id = p.city_id ORDER BY p.created_at DESC LIMIT $1`, [limit])).rows;
}

export interface AdminEvent {
  id: number; slug: string; city: string; title: string; local_date: string | null; status: string; is_published: boolean; origin: string;
  actions: { action: string; reason: string; created_at: string }[];
}

export async function findEvents(q: string, pool: Pool = getPool()): Promise<AdminEvent[]> {
  return (await pool.query<AdminEvent>(
    `SELECT e.id, e.slug, c.slug AS city, e.title, e.local_date::text, e.status, e.is_published, e.origin,
            coalesce((SELECT json_agg(json_build_object('action', a.action, 'reason', a.reason, 'created_at', a.created_at) ORDER BY a.created_at DESC)
                      FROM event_actions a WHERE a.event_id = e.id), '[]') AS actions
     FROM events e JOIN cities c ON c.id = e.city_id
     WHERE ($1 = '' AND e.starts_at > now() - interval '2 days') OR ($1 <> '' AND (e.title ILIKE '%' || $1 || '%' OR e.slug = $1))
     ORDER BY e.starts_at LIMIT 60`, [q.trim()])).rows;
}

export async function overviewCounts(pool: Pool = getPool()) {
  const one = async (sql: string) => Number((await pool.query<{ n: string }>(sql)).rows[0].n);
  return {
    openReview: await one("SELECT count(*) AS n FROM review_queue WHERE status = 'open'"),
    pendingSubmissions: await one("SELECT count(*) AS n FROM submissions WHERE status = 'pending'"),
    suggestedHandles: await one("SELECT count(*) AS n FROM suggested_handles WHERE status = 'pending'"),
    publishedUpcoming: await one("SELECT count(*) AS n FROM events WHERE is_published AND status IN ('scheduled','postponed') AND starts_at > now() - interval '6 hours'"),
    postersStored: await one("SELECT count(*) AS n FROM poster_images"),
  };
}

export interface SearchQueryRow { normalized: string; example: string; searches: number; zero: number; last_at: Date; last_method: string; last_results: number }
export interface SearchLogRow {
  id: number; searched_at: Date; query: string; locale: string | null; parse_method: string | null; parsed: Record<string, unknown> | null;
  result_count: number; cost_usd: number;
}

/**
 * Search queries over the last `days` days (Prompt 7): the most common, the
 * ones that found nothing (the hub pages and handles that are missing), how
 * they were read, and what reading them cost.
 */
export async function searchReport(days = 30, pool: Pool = getPool()) {
  const since = `now() - make_interval(days => ${Math.max(1, Math.floor(days))})`;
  const grouped = (where: string, order: string) => pool.query<SearchQueryRow>(
    `SELECT normalized, (array_agg(query ORDER BY searched_at DESC))[1] AS example, count(*)::int AS searches,
            count(*) FILTER (WHERE result_count = 0)::int AS zero, max(searched_at) AS last_at,
            (array_agg(parse_method ORDER BY searched_at DESC))[1] AS last_method, (array_agg(result_count ORDER BY searched_at DESC))[1] AS last_results
     FROM search_log WHERE searched_at >= ${since} GROUP BY normalized ${where} ORDER BY ${order} LIMIT 50`);
  const [common, zero, methods, recent, today] = await Promise.all([
    grouped("", "searches DESC, last_at DESC"),
    grouped("HAVING (array_agg(result_count ORDER BY searched_at DESC))[1] = 0", "searches DESC, last_at DESC"),
    pool.query<{ parse_method: string; searches: number; usd: number }>(
      `SELECT coalesce(parse_method, 'unknown') AS parse_method, count(*)::int AS searches, sum(cost_usd)::float AS usd
       FROM search_log WHERE searched_at >= ${since} GROUP BY 1 ORDER BY searches DESC`),
    pool.query<SearchLogRow>(
      `SELECT id, searched_at, query, locale, parse_method, parsed, result_count, cost_usd::float AS cost_usd
       FROM search_log ORDER BY searched_at DESC, id DESC LIMIT 60`),
    pool.query<{ usd: number; calls: number }>(
      `SELECT coalesce(sum(estimated_usd), 0)::float AS usd, count(*)::int AS calls FROM cost_log
       WHERE NOT dry_run AND sub_budget = 'search' AND logged_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`),
  ]);
  const cached = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM search_parse_cache")).rows[0].n;
  return { common: common.rows, zero: zero.rows, methods: methods.rows, recent: recent.rows, today: today.rows[0], cached };
}
