/**
 * Venue census (Prompt 9): the places in a city where events happen.
 *   - OpenStreetMap (free, through the Overpass API) for auditoriums, clubs
 *     and bars, hotels and banquet halls, malls, colleges, cultural centres,
 *     grounds, community and religious places;
 *   - every venue we already list;
 *   - Instagram location tags seen by discovery (discovery.ts);
 *   - rows the admin adds.
 * The census is admin only: a place gets a public venue page when an event
 * there is published. A census row is linked to a venue with the same name.
 */
import type { Pool } from "pg";
import { sourcing } from "../../config";
import { forCity } from "./sourcing-data";
import { nameKey } from "./text";

export interface CensusPlace {
  ref: string;
  name: string;
  type: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  website: string | null;
  instagram: string | null;
  facebook: string | null;
}

type OsmFilter = (typeof sourcing.census.osmFilters)[number];

export function overpassQuery(bbox: [number, number, number, number], filters: readonly OsmFilter[] = sourcing.census.osmFilters): string {
  const box = `(${bbox.join(",")})`;
  const parts = filters.map((f) => `nwr["${f.key}"~"^(${f.values})$"]${f.also ? `["${f.also.key}"="${f.also.value}"]` : ""}["name"]${box};`);
  return `[out:json][timeout:90];(${parts.join("")});out center tags;`;
}

function typeFor(tags: Record<string, string>, filters: readonly OsmFilter[]): string | null {
  for (const f of filters) {
    if (!new RegExp(`^(${f.values})$`).test(tags[f.key] ?? "")) continue;
    if (f.also && tags[f.also.key] !== f.also.value) continue;
    return f.type;
  }
  return null;
}

const handleFrom = (v: string | undefined) => {
  const m = (v ?? "").trim().match(/^(?:https?:\/\/(?:www\.)?instagram\.com\/)?@?([A-Za-z0-9._]{1,30})\/?$/);
  return m ? m[1].toLowerCase() : null;
};
const facebookFrom = (v: string | undefined) => {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (/^https?:\/\/(www\.|m\.)?facebook\.com\//i.test(s)) return s;
  return /^[A-Za-z0-9.]{3,80}$/.test(s) ? `https://www.facebook.com/${s}` : null;
};

/** Named places from an Overpass JSON response, each with our venue type. */
export function parseOverpass(json: unknown, filters: readonly OsmFilter[] = sourcing.census.osmFilters): CensusPlace[] {
  const elements = (json as { elements?: unknown[] })?.elements ?? [];
  const out: CensusPlace[] = [];
  const seen = new Set<string>();
  for (const raw of elements) {
    const e = raw as { type?: string; id?: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };
    const tags = e.tags ?? {};
    const name = (tags["name:en"] ?? tags.name ?? "").trim();
    const type = typeFor(tags, filters);
    if (!name || !type || !e.type || e.id === undefined) continue;
    const ref = `${e.type}/${e.id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const street = [tags["addr:housenumber"], tags["addr:street"], tags["addr:suburb"] ?? tags["addr:neighbourhood"], tags["addr:city"]]
      .filter(Boolean).join(", ");
    out.push({
      ref, name, type,
      address: tags["addr:full"] ?? (street || null),
      lat: e.lat ?? e.center?.lat ?? null,
      lng: e.lon ?? e.center?.lon ?? null,
      website: tags.website ?? tags["contact:website"] ?? null,
      instagram: handleFrom(tags["contact:instagram"] ?? tags.instagram),
      facebook: facebookFrom(tags["contact:facebook"] ?? tags.facebook),
    });
  }
  return out;
}

export interface CensusReport {
  city: string;
  status: string;
  placesFound: number;
  added: number;
  updated: number;
  byType: Record<string, number>;
  linked: number;
}

/** Adds or refreshes a city's OpenStreetMap places, then links census rows and venues. */
export async function runCensus(
  pool: Pool, opts: { city: string; dryRun?: boolean; fetchFn?: typeof fetch; retryDelayMs?: number },
): Promise<CensusReport> {
  const report: CensusReport = { city: opts.city, status: "ok", placesFound: 0, added: 0, updated: 0, byType: {}, linked: 0 };
  const city = (await pool.query<{ id: number; name: string }>("SELECT id, name FROM cities WHERE slug = $1", [opts.city])).rows[0];
  if (!city) { report.status = "unknown city"; return report; }
  const bbox = forCity(opts.city).censusBbox;
  if (!bbox) { report.status = "no censusBbox for this city in data/sourcing.json"; return report; }
  const fetchFn = opts.fetchFn ?? fetch;
  // The public Overpass servers are often busy (429, 502, 504): try three times, a minute apart.
  let res: Response | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetchFn(sourcing.census.overpassUrl, {
      method: "POST",
      headers: { "User-Agent": sourcing.userAgent, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: overpassQuery(bbox) }).toString(),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok || ![429, 502, 503, 504].includes(res.status) || attempt === 3) break;
    await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 60_000));
  }
  if (!res!.ok) { report.status = `Overpass returned ${res!.status} three times`; return report; }
  const places = parseOverpass(await res!.json());
  report.placesFound = places.length;
  for (const p of places) report.byType[p.type] = (report.byType[p.type] ?? 0) + 1;
  if (opts.dryRun) { report.status = "dry run: nothing written"; return report; }
  for (const p of places) {
    const r = await pool.query<{ inserted: boolean }>(
      `INSERT INTO venue_census (city_id, name, name_key, venue_type, address, lat, lng, source, source_ref, instagram_handle, facebook_url, website)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'osm',$8,$9,$10,$11)
       ON CONFLICT (city_id, source, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET
         name = EXCLUDED.name, name_key = EXCLUDED.name_key, venue_type = EXCLUDED.venue_type,
         address = coalesce(EXCLUDED.address, venue_census.address), lat = EXCLUDED.lat, lng = EXCLUDED.lng,
         instagram_handle = coalesce(venue_census.instagram_handle, EXCLUDED.instagram_handle),
         facebook_url = coalesce(venue_census.facebook_url, EXCLUDED.facebook_url),
         website = coalesce(venue_census.website, EXCLUDED.website), last_seen_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [city.id, p.name, nameKey(p.name, city.name), p.type, p.address, p.lat, p.lng, p.ref, p.instagram, p.facebook, p.website]);
    if (r.rows[0].inserted) report.added++; else report.updated++;
  }
  report.linked = await linkCensus(pool, city.id);
  return report;
}

/**
 * Keeps the census and the venue list together: every venue with a published
 * event gets a census row (venues whose events were all taken down, such as
 * ones in another city, leave it), and a census row with the same name as a venue is linked to it.
 * Free; housekeeping runs it daily. Returns the number of links made.
 */
export async function linkCensus(pool: Pool, cityId?: number): Promise<number> {
  const venues = (await pool.query<{ id: number; city_id: number; name: string; city_name: string; instagram: string | null; published: boolean }>(
    `SELECT v.id, v.city_id, v.name, c.name AS city_name, v.official_links->>'instagram' AS instagram,
            EXISTS (SELECT 1 FROM events e WHERE e.venue_id = v.id AND e.is_published) AS published
     FROM venues v JOIN cities c ON c.id = v.city_id WHERE ($1::bigint IS NULL OR v.city_id = $1)`, [cityId ?? null])).rows;
  // A venue copied in from an event whose events were all taken down (out of the city, or not real) leaves the census.
  await pool.query(
    `DELETE FROM venue_census vc WHERE vc.source = 'event' AND ($1::bigint IS NULL OR vc.city_id = $1)
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.venue_id = vc.venue_id AND e.is_published)`, [cityId ?? null]);
  let linked = 0;
  for (const v of venues) {
    const key = nameKey(v.name, v.city_name);
    if (!key) continue;
    const already = await pool.query("SELECT 1 FROM venue_census WHERE venue_id = $1 LIMIT 1", [v.id]);
    if (already.rowCount) continue;
    const match = await pool.query<{ id: number }>(
      "UPDATE venue_census SET venue_id = $1 WHERE id = (SELECT id FROM venue_census WHERE city_id = $2 AND name_key = $3 AND venue_id IS NULL ORDER BY id LIMIT 1) RETURNING id",
      [v.id, v.city_id, key]);
    if (match.rowCount) { linked++; continue; }
    if (!v.published) continue;
    await pool.query(
      `INSERT INTO venue_census (city_id, name, name_key, source, source_ref, venue_id, instagram_handle)
       VALUES ($1,$2,$3,'event',$4,$5,$6) ON CONFLICT DO NOTHING`,
      [v.city_id, v.name, key, `venue:${v.id}`, v.id, v.instagram]);
  }
  return linked;
}

export interface CensusRow {
  id: number;
  name: string;
  venue_type: string;
  source: string;
  address: string | null;
  handle: string | null;
  handle_tracked: boolean;
  facebook_url: string | null;
  venue_id: number | null;
  venue_path: string | null;
  last_event: Date | null;
  city: string;
}

/**
 * Admin gap lists: census places with no Instagram handle on record, or with
 * no event in the last `quietDays` (upcoming events count as recent).
 */
export async function censusGaps(
  pool: Pool, opts: { gap: "no_handle" | "quiet"; type?: string; city?: string; limit?: number },
): Promise<CensusRow[]> {
  const where = opts.gap === "no_handle"
    ? "coalesce(vc.instagram_handle, v.official_links->>'instagram') IS NULL"
    : `NOT EXISTS (SELECT 1 FROM events e WHERE e.venue_id = vc.venue_id AND e.is_published AND e.starts_at >= now() - make_interval(days => ${sourcing.census.quietDays}))`;
  const { rows } = await pool.query<CensusRow>(
    `SELECT vc.id, vc.name, vc.venue_type, vc.source, coalesce(vc.address, v.address) AS address,
            coalesce(vc.instagram_handle, v.official_links->>'instagram') AS handle,
            EXISTS (SELECT 1 FROM handles h WHERE h.active AND h.handle = coalesce(vc.instagram_handle, v.official_links->>'instagram')) AS handle_tracked,
            coalesce(vc.facebook_url, v.official_links->>'facebook') AS facebook_url, vc.venue_id,
            CASE WHEN v.id IS NULL THEN NULL ELSE '/' || c.slug || '/venues/' || v.slug END AS venue_path,
            (SELECT max(e.starts_at) FROM events e WHERE e.venue_id = vc.venue_id AND e.is_published) AS last_event, c.name AS city
     FROM venue_census vc JOIN cities c ON c.id = vc.city_id LEFT JOIN venues v ON v.id = vc.venue_id
     WHERE NOT vc.ignored AND ($1::text IS NULL OR vc.venue_type = $1) AND ($2::text IS NULL OR c.slug = $2) AND ${where}
     ORDER BY (vc.venue_id IS NULL), vc.seen_count DESC, vc.name LIMIT $3`,
    [opts.type ?? null, opts.city ?? null, opts.limit ?? 300]);
  return rows;
}

export async function censusSummary(pool: Pool) {
  return (await pool.query<{ city: string; venue_type: string; places: number; with_handle: number; tracked: number; with_recent_event: number }>(
    `SELECT c.name AS city, vc.venue_type, count(*)::int AS places,
            count(*) FILTER (WHERE coalesce(vc.instagram_handle, v.official_links->>'instagram') IS NOT NULL)::int AS with_handle,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM handles h WHERE h.active AND h.handle = coalesce(vc.instagram_handle, v.official_links->>'instagram')))::int AS tracked,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.venue_id = vc.venue_id AND e.is_published
                                              AND e.starts_at >= now() - make_interval(days => ${sourcing.census.quietDays})))::int AS with_recent_event
     FROM venue_census vc JOIN cities c ON c.id = vc.city_id LEFT JOIN venues v ON v.id = vc.venue_id
     WHERE NOT vc.ignored GROUP BY 1, 2 ORDER BY 1, places DESC`)).rows;
}
