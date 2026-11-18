/**
 * Clean-up pass run by the daily housekeeping job. No paid calls.
 *   1. Venues in the same city whose names are the same place written at
 *      different lengths are merged into one.
 *   2. Events at the same venue on the same date with similar titles are
 *      merged: the older listing is kept, and the other's sources, performers
 *      and missing facts are moved onto it.
 * The ingestion pipeline already prevents both at the moment a post is
 * processed; this catches pairs created before a matching rule existed, or
 * created in the same run before either was stored.
 */
import type { Pool, PoolClient } from "pg";
import { ingestion } from "../../config";
import { nameKey, sameVenueKey, titleSimilarity } from "./text";

export interface DedupeReport {
  venuesMerged: { kept: string; removed: string }[];
  eventsMerged: { kept: string; removed: string; venue: string | null; date: string }[];
}

interface VenueRow { id: number; city_id: number; city_name: string; name: string; instagram: string | null; events: number }

/** The row to keep: one with an Instagram handle, then the fuller name, then the older row. */
function keeper(a: VenueRow, b: VenueRow): [VenueRow, VenueRow] {
  const score = (v: VenueRow) => [v.instagram ? 1 : 0, v.name.length, -v.id];
  const [sa, sb] = [score(a), score(b)];
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] > sb[i] ? [a, b] : [b, a];
  return [a, b];
}

async function mergeVenue(db: PoolClient, keep: VenueRow, drop: VenueRow) {
  await db.query("UPDATE events SET venue_id = $1, updated_at = now() WHERE venue_id = $2", [keep.id, drop.id]);
  await db.query("UPDATE entity_sources SET entity_id = $1 WHERE entity_type = 'venue' AND entity_id = $2", [keep.id, drop.id]);
  // Keep every fact either row had; the kept row's own values win.
  await db.query(
    `UPDATE venues k SET
       area_id = coalesce(k.area_id, d.area_id), address = coalesce(k.address, d.address), lat = coalesce(k.lat, d.lat),
       lng = coalesce(k.lng, d.lng), capacity = coalesce(k.capacity, d.capacity), parking = coalesce(k.parking, d.parking),
       how_to_reach = coalesce(k.how_to_reach, d.how_to_reach), description = coalesce(k.description, d.description),
       venue_type = coalesce(k.venue_type, d.venue_type), official_links = d.official_links || k.official_links, updated_at = now()
     FROM venues d WHERE k.id = $1 AND d.id = $2`, [keep.id, drop.id]);
  await db.query("DELETE FROM venues WHERE id = $1", [drop.id]);
}

interface EventRow { id: number; title: string; venue_id: number; venue: string | null; day: string }

async function mergeEvent(db: PoolClient, keep: EventRow, drop: EventRow) {
  await db.query(
    `UPDATE events k SET
       description = coalesce(nullif(k.description, ''), d.description), price_text = coalesce(k.price_text, d.price_text),
       is_free = coalesce(k.is_free, d.is_free), booking_url = coalesce(k.booking_url, d.booking_url),
       ends_at = coalesce(k.ends_at, d.ends_at), category_id = coalesce(k.category_id, d.category_id),
       series_id = coalesce(k.series_id, d.series_id),
       starts_at = CASE WHEN NOT k.start_time_known AND d.start_time_known THEN d.starts_at ELSE k.starts_at END,
       start_time_known = k.start_time_known OR d.start_time_known,
       is_published = k.is_published OR d.is_published,
       confidence = least(1, greatest(coalesce(k.confidence, 0), coalesce(d.confidence, 0)) + $3),
       last_verified_at = greatest(k.last_verified_at, d.last_verified_at), updated_at = now()
     FROM events d WHERE k.id = $1 AND d.id = $2`, [keep.id, drop.id, ingestion.secondSourceBoost]);
  await db.query(
    `INSERT INTO sources (event_id, source_type, raw_post_id, url, submission, observed_at)
     SELECT $1, s.source_type, s.raw_post_id, s.url, s.submission, s.observed_at FROM sources s WHERE s.event_id = $2
       AND NOT EXISTS (SELECT 1 FROM sources k WHERE k.event_id = $1 AND (k.raw_post_id = s.raw_post_id OR k.url = s.url))`,
    [keep.id, drop.id]);
  await db.query(
    `INSERT INTO event_artists (event_id, artist_id, billing_order)
     SELECT $1, artist_id, billing_order FROM event_artists WHERE event_id = $2 ON CONFLICT DO NOTHING`, [keep.id, drop.id]);
  await db.query(
    `INSERT INTO event_organisers (event_id, organiser_id)
     SELECT $1, organiser_id FROM event_organisers WHERE event_id = $2 ON CONFLICT DO NOTHING`, [keep.id, drop.id]);
  await db.query("UPDATE review_queue SET item_id = $1 WHERE item_type = 'event' AND item_id = $2", [keep.id, drop.id]);
  // Its sources and links now live on the kept listing; the leftover rows go with it.
  await db.query("DELETE FROM events WHERE id = $1", [drop.id]);
}

export async function mergeDuplicates(pool: Pool, opts: { dryRun?: boolean } = {}): Promise<DedupeReport> {
  const report: DedupeReport = { venuesMerged: [], eventsMerged: [] };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Same lock the pipeline takes per city, taken for all: nothing is created while rows are being merged.
    await client.query("SELECT pg_advisory_xact_lock(72001, c.id::int) FROM cities c ORDER BY c.id");

    const venues = (await client.query<VenueRow>(
      `SELECT v.id, v.city_id, c.name AS city_name, v.name, v.official_links->>'instagram' AS instagram,
              (SELECT count(*) FROM events e WHERE e.venue_id = v.id) AS events
       FROM venues v JOIN cities c ON c.id = v.city_id ORDER BY v.id`)).rows;
    const gone = new Set<number>();
    for (let i = 0; i < venues.length; i++) {
      for (let j = i + 1; j < venues.length; j++) {
        let a = venues[i];
        const b = venues[j];
        if (gone.has(a.id) || gone.has(b.id) || a.city_id !== b.city_id) continue;
        // Two different Instagram accounts are two different places, whatever the names.
        if (a.instagram && b.instagram && a.instagram !== b.instagram) continue;
        if (!sameVenueKey(nameKey(a.name, a.city_name), nameKey(b.name, b.city_name))) continue;
        const [keep, drop] = keeper(a, b);
        await mergeVenue(client, keep, drop);
        gone.add(drop.id);
        report.venuesMerged.push({ kept: keep.name, removed: drop.name });
        // Carry on comparing with the surviving row.
        if (drop.id === a.id) { venues[i] = keep; a = keep; }
        keep.instagram = keep.instagram ?? drop.instagram;
      }
    }

    const events = (await client.query<EventRow>(
      `SELECT e.id, e.title, e.venue_id, v.name AS venue, (e.starts_at AT TIME ZONE c.timezone)::date::text AS day
       FROM events e JOIN cities c ON c.id = e.city_id LEFT JOIN venues v ON v.id = e.venue_id
       WHERE e.venue_id IS NOT NULL AND e.status <> 'cancelled' ORDER BY e.id`)).rows;
    const removed = new Set<number>();
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const [keep, drop] = [events[i], events[j]];
        if (removed.has(keep.id) || removed.has(drop.id)) continue;
        if (keep.venue_id !== drop.venue_id || keep.day !== drop.day) continue;
        if (titleSimilarity(keep.title, drop.title) < ingestion.titleSimilarity.same) continue;
        await mergeEvent(client, keep, drop);
        removed.add(drop.id);
        report.eventsMerged.push({ kept: keep.title, removed: drop.title, venue: keep.venue, date: keep.day });
      }
    }
    await client.query(opts.dryRun ? "ROLLBACK" : "COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return report;
}
