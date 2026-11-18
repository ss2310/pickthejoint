/**
 * Daily housekeeping. No paid calls.
 *   - marks events whose end has passed as "happened" (nothing is ever deleted);
 *   - reports the last day's activity and the month's spend.
 */
import type { Pool } from "pg";

export async function housekeeping(pool: Pool, opts: { dryRun?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  // Without an end time an event is over 6 hours after it starts, or at the
  // end of its day when no start time was stated either.
  const ended = `coalesce(ends_at, CASE WHEN start_time_known THEN starts_at + interval '6 hours' ELSE starts_at + interval '1 day' END) < $1`;
  const marked = opts.dryRun
    ? Number((await pool.query<{ n: number }>(`SELECT count(*) AS n FROM events WHERE status = 'scheduled' AND ${ended}`, [now])).rows[0].n)
    : (await pool.query(`UPDATE events SET status = 'happened', updated_at = now() WHERE status = 'scheduled' AND ${ended}`, [now])).rowCount ?? 0;

  const one = async (sql: string) => Number((await pool.query<{ n: number }>(sql, [now])).rows[0].n);
  const since = "$1::timestamptz - interval '24 hours'";
  return {
    eventsMarkedHappened: marked,
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
