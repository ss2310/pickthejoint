/**
 * Daily housekeeping. No paid calls.
 *   - merges duplicate venues and duplicate listings of the same event (dedupe.ts);
 *   - marks events whose end has passed as "happened" (past events are never deleted);
 *   - reports the last day's activity and the month's spend.
 */
import type { Pool } from "pg";
import { search, submissions } from "../../config";
import { mergeDuplicates } from "./dedupe";

/**
 * Deletes what is only kept for a while (Prompt 6): poster photos once their
 * time is up (the day after the event, or sooner when unused), drafts that
 * were never sent (with their photo), rate-limit records and expired admin
 * sessions; and (Prompt 7) cached search readings past their time.
 */
export async function cleanUp(pool: Pool, now = new Date()) {
  const drafts = await pool.query<{ poster_id: number | null }>(
    "DELETE FROM submissions WHERE status = 'draft' AND updated_at < $1::timestamptz - make_interval(days => $2) RETURNING poster_id",
    [now, submissions.draftDays]);
  const orphanPosters = drafts.rows.map((d) => d.poster_id).filter((id): id is number => id !== null);
  const posters = await pool.query(
    `DELETE FROM poster_images WHERE delete_after < $1 OR (id = ANY($2::bigint[]) AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.poster_id = poster_images.id))`,
    [now, orphanPosters]);
  const hits = await pool.query("DELETE FROM rate_hits WHERE hit_at < $1::timestamptz - interval '2 days'", [now]);
  const sessions = await pool.query("DELETE FROM admin_sessions WHERE expires_at < $1", [now]);
  const readings = await pool.query("DELETE FROM search_parse_cache WHERE created_at < $1::timestamptz - make_interval(days => $2)", [now, search.cacheDays]);
  return {
    posterPhotosDeleted: posters.rowCount ?? 0, unsentDraftsDeleted: drafts.rowCount ?? 0, rateRecordsDeleted: hits.rowCount ?? 0,
    expiredSessions: sessions.rowCount ?? 0, searchReadingsExpired: readings.rowCount ?? 0,
  };
}

export async function housekeeping(pool: Pool, opts: { dryRun?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const duplicates = await mergeDuplicates(pool, { dryRun: opts.dryRun });
  // Without an end time an event is over 6 hours after it starts, or at the
  // end of its day when no start time was stated either.
  const ended = `coalesce(ends_at, CASE WHEN start_time_known THEN starts_at + interval '6 hours' ELSE starts_at + interval '1 day' END) < $1`;
  const marked = opts.dryRun
    ? Number((await pool.query<{ n: number }>(`SELECT count(*) AS n FROM events WHERE status = 'scheduled' AND ${ended}`, [now])).rows[0].n)
    : (await pool.query(`UPDATE events SET status = 'happened', updated_at = now() WHERE status = 'scheduled' AND ${ended}`, [now])).rowCount ?? 0;

  const one = async (sql: string) => Number((await pool.query<{ n: number }>(sql, [now])).rows[0].n);
  const since = "$1::timestamptz - interval '24 hours'";
  const cleanup = opts.dryRun ? { skipped: "dry run" } : await cleanUp(pool, now);
  return {
    duplicates,
    eventsMarkedHappened: marked,
    cleanup,
    last24Hours: {
      postsFetched: await one(`SELECT count(*) AS n FROM raw_posts WHERE fetched_at >= ${since}`),
      eventsPublished: await one(`SELECT count(*) AS n FROM events WHERE is_published AND created_at >= ${since}`),
      queuedForReview: await one(`SELECT count(*) AS n FROM review_queue WHERE created_at >= ${since}`),
    },
    totals: {
      upcomingPublishedEvents: await one("SELECT count(*) AS n FROM events WHERE is_published AND status = 'scheduled' AND starts_at >= $1"),
      openReviewItems: await one("SELECT count(*) AS n FROM review_queue WHERE status = 'open' AND created_at <= $1"),
      suggestedHandlesPending: await one("SELECT count(*) AS n FROM suggested_handles WHERE status = 'pending' AND created_at <= $1"),
    },
  };
}
