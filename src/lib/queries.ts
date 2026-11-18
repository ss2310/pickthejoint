/**
 * Read queries for the public pages. Only published events are ever returned.
 * Dates are compared in the city's timezone.
 */
import { getPool } from "./db";

export interface City { id: number; slug: string; name: string; state: string; timezone: string }
export interface Named { id: number; slug: string; name: string }
export interface Area extends Named { city_id: number }

export interface EventCard {
  id: number; city_id: number; slug: string; title: string; starts_at: Date; ends_at: Date | null; start_time_known: boolean;
  status: "scheduled" | "cancelled" | "postponed" | "happened"; price_text: string | null; is_free: boolean | null;
  city_slug: string; timezone: string; venue_name: string | null; venue_slug: string | null; area_name: string | null;
  category_slug: string | null; category_name: string | null; performers: string[]; updated_at: Date;
}

export interface EventDetail extends EventCard {
  description: string | null; booking_url: string | null; last_verified_at: Date | null; origin: string;
  city_name: string; city_state: string; venue_id: number | null; venue_address: string | null; venue_lat: number | null;
  venue_lng: number | null; area_slug: string | null; category_id: number | null; series: Named | null;
  artists: { slug: string; name: string; kind: string }[]; organisers: { slug: string; name: string }[];
  sources: { source_type: string; url: string | null }[];
}

export interface EventFilter {
  cityId?: number;
  /** Inclusive local dates, "YYYY-MM-DD". */
  from?: string;
  to?: string;
  categoryId?: number;
  areaId?: number;
  venueId?: number;
  artistId?: number;
  organiserId?: number;
  seriesId?: number;
  free?: boolean;
  /** "upcoming" (default): not yet over. "past": over. "any": both. */
  when?: "upcoming" | "past" | "any";
  excludeId?: number;
  limit?: number;
}

const CARD = `
  e.id, e.city_id, e.slug, e.title, e.starts_at, e.ends_at, e.start_time_known, e.status, e.price_text, e.is_free, e.updated_at,
  c.slug AS city_slug, c.timezone, v.name AS venue_name, v.slug AS venue_slug, a.name AS area_name,
  cat.slug AS category_slug, cat.name AS category_name,
  coalesce((SELECT array_agg(ar.name ORDER BY ea.billing_order) FROM event_artists ea JOIN artists ar ON ar.id = ea.artist_id
            WHERE ea.event_id = e.id), '{}') AS performers`;
const JOINS = `
  FROM events e JOIN cities c ON c.id = e.city_id
  LEFT JOIN venues v ON v.id = e.venue_id LEFT JOIN areas a ON a.id = v.area_id
  LEFT JOIN categories cat ON cat.id = e.category_id`;
/** An event is over once marked happened, or 6 hours after its start (its end, if known). */
const OVER = `(e.status = 'happened' OR coalesce(e.ends_at, e.starts_at + CASE WHEN e.start_time_known THEN interval '6 hours' ELSE interval '1 day' END) < now())`;
const START_DAY = `(e.starts_at AT TIME ZONE c.timezone)::date`;
/** Last local day of the event; a show that runs past midnight still belongs to the day it started. */
const END_DAY = `(CASE WHEN e.ends_at IS NOT NULL AND e.ends_at - e.starts_at > interval '20 hours'
                  THEN (e.ends_at AT TIME ZONE c.timezone)::date ELSE ${START_DAY} END)`;

export async function listEvents(f: EventFilter): Promise<EventCard[]> {
  const where = ["e.is_published", "c.is_live"];
  const args: unknown[] = [];
  const add = (sql: string, value: unknown) => { args.push(value); where.push(sql.replace("?", `$${args.length}`)); };
  if (f.cityId) add("e.city_id = ?", f.cityId);
  if (f.from) add(`${END_DAY} >= ?::date`, f.from);
  if (f.to) add(`${START_DAY} <= ?::date`, f.to);
  if (f.categoryId) add("e.category_id = ?", f.categoryId);
  if (f.areaId) add("v.area_id = ?", f.areaId);
  if (f.venueId) add("e.venue_id = ?", f.venueId);
  if (f.seriesId) add("e.series_id = ?", f.seriesId);
  if (f.artistId) add("EXISTS (SELECT 1 FROM event_artists x WHERE x.event_id = e.id AND x.artist_id = ?)", f.artistId);
  if (f.organiserId) add("EXISTS (SELECT 1 FROM event_organisers x WHERE x.event_id = e.id AND x.organiser_id = ?)", f.organiserId);
  if (f.free === true) where.push("e.is_free IS TRUE");
  if (f.free === false) where.push("e.is_free IS NOT TRUE AND e.price_text IS NOT NULL");
  if (f.excludeId) add("e.id <> ?", f.excludeId);
  const when = f.when ?? "upcoming";
  if (when === "upcoming") where.push(`NOT ${OVER}`);
  if (when === "past") where.push(OVER);
  args.push(f.limit ?? 200);
  const { rows } = await getPool().query<EventCard>(
    `SELECT ${CARD} ${JOINS} WHERE ${where.join(" AND ")}
     ORDER BY e.starts_at ${when === "past" ? "DESC" : "ASC"}, e.id LIMIT $${args.length}`,
    args,
  );
  return rows;
}

export async function getCity(slug: string): Promise<City | null> {
  const { rows } = await getPool().query<City>(
    "SELECT id, slug, name, state, timezone FROM cities WHERE slug = $1 AND is_live", [slug.toLowerCase()]);
  return rows[0] ?? null;
}

export async function liveCities(): Promise<City[]> {
  return (await getPool().query<City>("SELECT id, slug, name, state, timezone FROM cities WHERE is_live ORDER BY name")).rows;
}

export async function listCategories(): Promise<Named[]> {
  return (await getPool().query<Named>("SELECT id, slug, name FROM categories ORDER BY sort_order")).rows;
}

export async function listAreas(cityId: number): Promise<Area[]> {
  return (await getPool().query<Area>("SELECT id, slug, name, city_id FROM areas WHERE city_id = $1 ORDER BY name", [cityId])).rows;
}

/** Areas that have at least one upcoming published event. */
export async function areasWithEvents(cityId: number): Promise<Area[]> {
  const { rows } = await getPool().query<Area>(
    `SELECT a.id, a.slug, a.name, a.city_id FROM areas a
     WHERE a.city_id = $1 AND EXISTS (
       SELECT 1 FROM events e JOIN venues v ON v.id = e.venue_id JOIN cities c ON c.id = e.city_id
       WHERE v.area_id = a.id AND e.is_published AND NOT ${OVER})
     ORDER BY a.name`, [cityId]);
  return rows;
}

export async function getEvent(citySlug: string, slug: string): Promise<EventDetail | null> {
  const { rows } = await getPool().query<EventDetail>(
    `SELECT ${CARD}, e.description, e.booking_url, e.last_verified_at, e.origin, c.name AS city_name, c.state AS city_state,
            v.id AS venue_id, v.address AS venue_address, v.lat AS venue_lat, v.lng AS venue_lng, a.slug AS area_slug,
            e.category_id,
            (SELECT json_build_object('id', s.id, 'slug', s.slug, 'name', s.name) FROM series s WHERE s.id = e.series_id) AS series,
            coalesce((SELECT json_agg(json_build_object('slug', ar.slug, 'name', ar.name, 'kind', ar.kind) ORDER BY ea.billing_order)
                      FROM event_artists ea JOIN artists ar ON ar.id = ea.artist_id WHERE ea.event_id = e.id), '[]') AS artists,
            coalesce((SELECT json_agg(json_build_object('slug', o.slug, 'name', o.name) ORDER BY o.name)
                      FROM event_organisers eo JOIN organisers o ON o.id = eo.organiser_id WHERE eo.event_id = e.id), '[]') AS organisers,
            coalesce((SELECT json_agg(json_build_object('source_type', s.source_type, 'url', s.url) ORDER BY s.id)
                      FROM sources s WHERE s.event_id = e.id), '[]') AS sources
     ${JOINS} WHERE c.slug = $1 AND e.slug = $2 AND e.is_published AND c.is_live`,
    [citySlug.toLowerCase(), slug],
  );
  return rows[0] ?? null;
}

export interface VenueDetail extends Named {
  city_id: number; city_slug: string; city_name: string; city_state: string; timezone: string; venue_type: string | null;
  address: string | null; lat: number | null; lng: number | null; capacity: number | null; parking: string | null;
  how_to_reach: string | null; description: string | null; official_links: Record<string, string>; same_as: string[];
  area_name: string | null; area_slug: string | null; updated_at: Date;
}

export async function getVenue(citySlug: string, slug: string): Promise<VenueDetail | null> {
  const { rows } = await getPool().query<VenueDetail>(
    `SELECT v.id, v.slug, v.name, v.city_id, c.slug AS city_slug, c.name AS city_name, c.state AS city_state, c.timezone,
            v.venue_type, v.address, v.lat, v.lng, v.capacity, v.parking, v.how_to_reach, v.description, v.official_links,
            v.same_as, a.name AS area_name, a.slug AS area_slug, v.updated_at
     FROM venues v JOIN cities c ON c.id = v.city_id LEFT JOIN areas a ON a.id = v.area_id
     WHERE c.slug = $1 AND v.slug = $2 AND c.is_live
       AND EXISTS (SELECT 1 FROM events e WHERE e.venue_id = v.id AND e.is_published)`,
    [citySlug.toLowerCase(), slug],
  );
  return rows[0] ?? null;
}

export interface PersonDetail extends Named {
  kind?: string; genre?: string | null; hometown?: string | null; bio: string | null;
  official_links: Record<string, string>; same_as: string[]; updated_at: Date;
  sources: { url: string; title: string | null }[];
}

async function getPerson(table: "artists" | "organisers", join: "event_artists" | "event_organisers", fk: string, slug: string) {
  const extra = table === "artists" ? "p.kind, p.genre, p.hometown," : "";
  const type = table === "artists" ? "artist" : "organiser";
  const { rows } = await getPool().query<PersonDetail>(
    `SELECT p.id, p.slug, p.name, ${extra} p.bio, p.official_links, p.same_as, p.updated_at,
            coalesce((SELECT json_agg(json_build_object('url', es.url, 'title', es.title) ORDER BY es.id)
                      FROM entity_sources es WHERE es.entity_type = '${type}' AND es.entity_id = p.id), '[]') AS sources
     FROM ${table} p
     WHERE p.slug = $1 AND EXISTS (SELECT 1 FROM ${join} j JOIN events e ON e.id = j.event_id WHERE j.${fk} = p.id AND e.is_published)`,
    [slug],
  );
  return rows[0] ?? null;
}
export const getArtist = (slug: string) => getPerson("artists", "event_artists", "artist_id", slug);
export const getOrganiser = (slug: string) => getPerson("organisers", "event_organisers", "organiser_id", slug);

export interface SeriesDetail extends Named { description: string | null; recurrence: string | null; official_links: Record<string, string>; updated_at: Date }
export async function getSeries(slug: string): Promise<SeriesDetail | null> {
  const { rows } = await getPool().query<SeriesDetail>(
    "SELECT id, slug, name, description, recurrence, official_links, updated_at FROM series WHERE slug = $1", [slug]);
  return rows[0] ?? null;
}

/** Rows for the XML sitemaps: path and last-modified time. */
export async function sitemapRows(type: string): Promise<{ path: string; lastmod: Date }[]> {
  const q = (sql: string) => getPool().query<{ path: string; lastmod: Date }>(sql).then((r) => r.rows);
  const published = "EXISTS (SELECT 1 FROM events e WHERE e.is_published AND";
  switch (type) {
    case "events":
      return q(`SELECT '/' || c.slug || '/events/' || e.slug AS path, e.updated_at AS lastmod
                FROM events e JOIN cities c ON c.id = e.city_id WHERE e.is_published AND c.is_live ORDER BY e.starts_at DESC LIMIT 45000`);
    case "venues":
      return q(`SELECT '/' || c.slug || '/venues/' || v.slug AS path,
                       greatest(v.updated_at, (SELECT max(e.updated_at) FROM events e WHERE e.venue_id = v.id AND e.is_published)) AS lastmod
                FROM venues v JOIN cities c ON c.id = v.city_id WHERE c.is_live AND ${published} e.venue_id = v.id) ORDER BY v.id`);
    case "artists":
      // Stub pages (no bio and a single event) carry noindex and stay out of the sitemap.
      return q(`SELECT '/artists/' || p.slug AS path, p.updated_at AS lastmod FROM artists p
                WHERE (p.bio IS NOT NULL OR (SELECT count(*) FROM event_artists j JOIN events e ON e.id = j.event_id
                       WHERE j.artist_id = p.id AND e.is_published) >= 2) ORDER BY p.id`);
    case "organisers":
      return q(`SELECT '/organisers/' || p.slug AS path, p.updated_at AS lastmod FROM organisers p
                WHERE (p.bio IS NOT NULL OR (SELECT count(*) FROM event_organisers j JOIN events e ON e.id = j.event_id
                       WHERE j.organiser_id = p.id AND e.is_published) >= 2) ORDER BY p.id`);
    case "series":
      return q(`SELECT '/series/' || s.slug AS path, s.updated_at AS lastmod FROM series s ORDER BY s.id`);
    default:
      return [];
  }
}

/** When a city's listings last changed: drives hub last-modified dates. */
export async function cityLastChange(cityId: number): Promise<Date | null> {
  const { rows } = await getPool().query<{ t: Date | null }>(
    "SELECT max(updated_at) AS t FROM events WHERE city_id = $1 AND is_published", [cityId]);
  return rows[0].t;
}
