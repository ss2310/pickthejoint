/**
 * Attaches each year's events to their festival series (Prompt 9). An event
 * belongs to a series when its title contains one of the series' aliases as
 * whole words and it falls in one of the series' months (local time), in the
 * series' city. Runs when an event is created and daily in housekeeping (for
 * submitted and older events).
 */
import type { Pool, PoolClient } from "pg";

export interface SeriesRule { id: number; city_id: number | null; aliases: string[]; months: number[] }

const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** The series an event belongs to, or null. The first matching series in the list wins. */
export function matchSeries(title: string, cityId: number, localMonth: number, rules: SeriesRule[]): number | null {
  const t = norm(title);
  for (const r of rules) {
    if (r.city_id !== null && Number(r.city_id) !== Number(cityId)) continue;
    if (r.months.length && !r.months.includes(localMonth)) continue;
    if (r.aliases.some((a) => a.trim() && t.includes(norm(a)))) return Number(r.id);
  }
  return null;
}

async function rules(db: Pool | PoolClient): Promise<SeriesRule[]> {
  return (await db.query<SeriesRule>(
    "SELECT id, city_id, aliases, months FROM series WHERE cardinality(aliases) > 0 ORDER BY cardinality(months) DESC, id")).rows;
}

/** Sets series_id on events that have none and match a series. Returns how many were attached. */
export async function attachSeries(db: Pool | PoolClient, eventIds?: number[]): Promise<number> {
  const list = await rules(db);
  if (list.length === 0) return 0;
  const { rows } = await db.query<{ id: number; city_id: number; title: string; month: number }>(
    `SELECT e.id, e.city_id, e.title, extract(month FROM e.starts_at AT TIME ZONE c.timezone)::int AS month
     FROM events e JOIN cities c ON c.id = e.city_id
     WHERE e.series_id IS NULL AND ($1::bigint[] IS NULL OR e.id = ANY($1))`, [eventIds ?? null]);
  let n = 0;
  for (const e of rows) {
    const id = matchSeries(e.title, e.city_id, e.month, list);
    if (id === null) continue;
    await db.query("UPDATE events SET series_id = $2, updated_at = now() WHERE id = $1", [e.id, id]);
    n++;
  }
  return n;
}
