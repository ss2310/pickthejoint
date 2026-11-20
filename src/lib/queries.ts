/**
 * Read queries for the public pages. Only published events are ever returned.
 * Dates are compared in the city's timezone.
 */
import { parked, type Locale } from "../config";
import { getPool } from "./db";
import { getLocale } from "./locale";

/**
 * A text column in the page's language. English is the stored text. For
 * another language the translations table is consulted and the stored text is
 * the fallback, so a missing translation never blocks a page. A translation is
 * used only while it matches the stored text (by its hash): if the English has
 * changed or been removed since, the page shows the current English until the
 * next translation run. `locale` comes from a fixed list, never from a request.
 */
function tr(locale: Locale, type: string, id: string, field: string, column: string): string {
  if (locale === "en") return column;
  return `(CASE WHEN ${column} IS NULL THEN NULL ELSE coalesce((SELECT tx.text FROM translations tx
    WHERE tx.entity_type = '${type}' AND tx.entity_id = ${id} AND tx.locale = '${locale}' AND tx.field = '${field}'
      AND tx.source_hash = md5(${column})), ${column}) END)`;
}

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
  /** Only these events (a weekly guide's). */
  ids?: number[];
  limit?: number;
  /**
   * Search words (Prompt 7), already folded by `foldText`. Latin words use full-text search over the event's
   * title and description and the names of its venue (with address), performers and organisers, matching
   * word starts. Devanagari words are looked for in the Hindi text of the same.
   */
  keywords?: string[];
  /** "all" (default): every word must match. "any": one is enough (the fallback when the query was not understood). */
  keywordMode?: "all" | "any";
}

/** Full-text document for keyword search: the event's own text plus the names around it. */
const KEYWORD_DOC = `(e.search_tsv
  || to_tsvector('simple', coalesce(v.name, '') || ' ' || coalesce(v.address, '') || ' ' || coalesce(a.name, ''))
  || to_tsvector('simple', coalesce((SELECT string_agg(ar.name, ' ') FROM event_artists x JOIN artists ar ON ar.id = x.artist_id WHERE x.event_id = e.id), '')
       || ' ' || coalesce((SELECT string_agg(o.name, ' ') FROM event_organisers x JOIN organisers o ON o.id = x.organiser_id WHERE x.event_id = e.id), '')))`;
/** The Hindi text of the same, with nuktas removed the way `foldText` removes them from the query. */
const HINDI_DOC = `replace(coalesce((SELECT string_agg(tx.text, ' ') FROM translations tx WHERE tx.locale = 'hi' AND (
    (tx.entity_type = 'event' AND tx.entity_id = e.id) OR (tx.entity_type = 'venue' AND tx.entity_id = v.id)
    OR (tx.entity_type = 'area' AND tx.entity_id = a.id)
    OR (tx.entity_type = 'artist' AND tx.entity_id IN (SELECT x.artist_id FROM event_artists x WHERE x.event_id = e.id))
    OR (tx.entity_type = 'organiser' AND tx.entity_id IN (SELECT x.organiser_id FROM event_organisers x WHERE x.event_id = e.id)))), ''), U&'\\093C', '')`;

/** One SQL condition for the search words, or null when there are none usable. */
function keywordSql(f: EventFilter, add: (value: unknown) => string): string | null {
  const parts: string[] = [];
  for (const raw of f.keywords ?? []) {
    const latin = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (latin && latin === raw.toLowerCase()) {
      // Word starts, so "workshop" finds "workshops"; a plural is cut back so "workshops" finds "workshop".
      const stem = latin.length > 4 && latin.endsWith("s") ? latin.slice(0, -1) : latin;
      parts.push(`${KEYWORD_DOC} @@ to_tsquery('simple', ${add(`${stem}:*`)})`);
    } else if (/^[ऀ-ॿ]+$/.test(raw)) {
      parts.push(`position(${add(raw)} in ${HINDI_DOC}) > 0`);
    }
  }
  if (parts.length === 0) return null;
  return `(${parts.join(f.keywordMode === "any" ? " OR " : " AND ")})`;
}

const card = (l: Locale) => `
  e.id, e.city_id, e.slug, ${tr(l, "event", "e.id", "title", "e.title")} AS title, e.starts_at, e.ends_at, e.start_time_known, e.status,
  ${tr(l, "event", "e.id", "price_text", "e.price_text")} AS price_text, e.is_free, e.updated_at,
  c.slug AS city_slug, c.timezone, ${tr(l, "venue", "v.id", "name", "v.name")} AS venue_name, v.slug AS venue_slug,
  ${tr(l, "area", "a.id", "name", "a.name")} AS area_name,
  cat.slug AS category_slug, ${tr(l, "category", "cat.id", "name", "cat.name")} AS category_name,
  coalesce((SELECT array_agg(${tr(l, "artist", "ar.id", "name", "ar.name")} ORDER BY ea.billing_order) FROM event_artists ea JOIN artists ar ON ar.id = ea.artist_id
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

export async function listEvents(f: EventFilter, locale: Locale = getLocale()): Promise<EventCard[]> {
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
  if (f.ids) add("e.id = ANY(?::bigint[])", f.ids);
  const words = keywordSql(f, (value) => { args.push(value); return `$${args.length}`; });
  if (words) where.push(words);
  const when = f.when ?? "upcoming";
  if (when === "upcoming") where.push(`NOT ${OVER}`);
  if (when === "past") where.push(OVER);
  args.push(f.limit ?? 200);
  const { rows } = await getPool().query<EventCard>(
    `SELECT ${card(locale)} ${JOINS} WHERE ${where.join(" AND ")}
     ORDER BY e.starts_at ${when === "past" ? "DESC" : "ASC"}, e.id LIMIT $${args.length}`,
    args,
  );
  return rows;
}

const cityColumns = (l: Locale) =>
  `c.id, c.slug, ${tr(l, "city", "c.id", "name", "c.name")} AS name, ${tr(l, "city", "c.id", "state", "c.state")} AS state, c.timezone`;

export async function getCity(slug: string, locale: Locale = getLocale()): Promise<City | null> {
  const { rows } = await getPool().query<City>(
    `SELECT ${cityColumns(locale)} FROM cities c WHERE c.slug = $1 AND c.is_live`, [slug.toLowerCase()]);
  return rows[0] ?? null;
}

export async function liveCities(locale: Locale = getLocale()): Promise<City[]> {
  return (await getPool().query<City>(`SELECT ${cityColumns(locale)} FROM cities c WHERE c.is_live ORDER BY c.name`)).rows;
}

export async function listCategories(locale: Locale = getLocale()): Promise<Named[]> {
  return (await getPool().query<Named>(
    `SELECT cat.id, cat.slug, ${tr(locale, "category", "cat.id", "name", "cat.name")} AS name FROM categories cat ORDER BY cat.sort_order`)).rows;
}

export async function listAreas(cityId: number, locale: Locale = getLocale()): Promise<Area[]> {
  return (await getPool().query<Area>(
    `SELECT a.id, a.slug, ${tr(locale, "area", "a.id", "name", "a.name")} AS name, a.city_id FROM areas a WHERE a.city_id = $1 ORDER BY a.name`, [cityId])).rows;
}

/** Areas that have at least one upcoming published event. */
export async function areasWithEvents(cityId: number, locale: Locale = getLocale()): Promise<Area[]> {
  const { rows } = await getPool().query<Area>(
    `SELECT a.id, a.slug, ${tr(locale, "area", "a.id", "name", "a.name")} AS name, a.city_id FROM areas a
     WHERE a.city_id = $1 AND EXISTS (
       SELECT 1 FROM events e JOIN venues v ON v.id = e.venue_id JOIN cities c ON c.id = e.city_id
       WHERE v.area_id = a.id AND e.is_published AND NOT ${OVER})
     ORDER BY a.name`, [cityId]);
  return rows;
}

export async function getEvent(citySlug: string, slug: string, locale: Locale = getLocale()): Promise<EventDetail | null> {
  const l = locale;
  const { rows } = await getPool().query<EventDetail>(
    `SELECT ${card(l)}, ${tr(l, "event", "e.id", "description", "e.description")} AS description, e.booking_url, e.last_verified_at, e.origin,
            ${tr(l, "city", "c.id", "name", "c.name")} AS city_name, ${tr(l, "city", "c.id", "state", "c.state")} AS city_state,
            v.id AS venue_id, ${tr(l, "venue", "v.id", "address", "v.address")} AS venue_address, v.lat AS venue_lat, v.lng AS venue_lng, a.slug AS area_slug,
            e.category_id,
            (SELECT json_build_object('id', s.id, 'slug', s.slug, 'name', ${tr(l, "series", "s.id", "name", "s.name")}) FROM series s WHERE s.id = e.series_id) AS series,
            coalesce((SELECT json_agg(json_build_object('slug', ar.slug, 'name', ${tr(l, "artist", "ar.id", "name", "ar.name")}, 'kind', ar.kind) ORDER BY ea.billing_order)
                      FROM event_artists ea JOIN artists ar ON ar.id = ea.artist_id WHERE ea.event_id = e.id), '[]') AS artists,
            coalesce((SELECT json_agg(json_build_object('slug', o.slug, 'name', ${tr(l, "organiser", "o.id", "name", "o.name")}) ORDER BY o.name)
                      FROM event_organisers eo JOIN organisers o ON o.id = eo.organiser_id WHERE eo.event_id = e.id), '[]') AS organisers,
            coalesce((SELECT json_agg(json_build_object('source_type', s.source_type, 'url', s.url) ORDER BY s.id)
                      FROM sources s WHERE s.event_id = e.id), '[]') AS sources
     ${JOINS} WHERE c.slug = $1 AND e.slug = $2 AND e.is_published AND c.is_live`,
    [citySlug.toLowerCase(), slug],
  );
  return rows[0] ?? null;
}

/**
 * Where an event went when its title or date was corrected: the slug it has now, or null.
 * The old address is kept in `event_redirects` and answers with a permanent redirect.
 */
export async function movedEventSlug(citySlug: string, oldSlug: string): Promise<string | null> {
  const { rows } = await getPool().query<{ slug: string }>(
    `SELECT e.slug FROM event_redirects r JOIN cities c ON c.id = r.city_id JOIN events e ON e.id = r.event_id
     WHERE c.slug = $1 AND r.old_slug = $2 AND e.is_published AND c.is_live`,
    [citySlug.toLowerCase(), oldSlug],
  );
  return rows[0]?.slug ?? null;
}

export interface VenueDetail extends Named {
  city_id: number; city_slug: string; city_name: string; city_state: string; timezone: string; venue_type: string | null;
  address: string | null; lat: number | null; lng: number | null; capacity: number | null; parking: string | null;
  how_to_reach: string | null; landmarks: string | null; description: string | null; official_links: Record<string, string>; same_as: string[];
  area_name: string | null; area_slug: string | null; updated_at: Date; sources: EntitySource[];
}

/** A page a venue, artist or organiser page draws on, with the facts taken from it. */
export interface EntitySource { url: string; title: string | null; facts: string[] }

/** Sources for an entity page, one row per page, in the order they were first stored. */
const entitySources = (type: "venue" | "artist" | "organiser" | "series", idColumn: string) => `
  coalesce((SELECT json_agg(json_build_object('url', s.url, 'title', s.title, 'facts', s.facts) ORDER BY s.first_id)
            FROM (SELECT es.url, max(es.title) AS title, min(es.id) AS first_id,
                         coalesce(array_agg(DISTINCT es.fact) FILTER (WHERE es.fact IS NOT NULL), '{}') AS facts
                  FROM entity_sources es WHERE es.entity_type = '${type}' AND es.entity_id = ${idColumn} GROUP BY es.url) s), '[]') AS sources`;

export async function getVenue(citySlug: string, slug: string, locale: Locale = getLocale()): Promise<VenueDetail | null> {
  const l = locale;
  const vt = (field: string) => `${tr(l, "venue", "v.id", field, `v.${field}`)} AS ${field}`;
  const { rows } = await getPool().query<VenueDetail>(
    `SELECT v.id, v.slug, ${vt("name")}, v.city_id, c.slug AS city_slug, ${tr(l, "city", "c.id", "name", "c.name")} AS city_name,
            ${tr(l, "city", "c.id", "state", "c.state")} AS city_state, c.timezone,
            ${vt("venue_type")}, ${vt("address")}, v.lat, v.lng, v.capacity, ${vt("parking")}, ${vt("how_to_reach")}, ${vt("landmarks")}, ${vt("description")}, v.official_links,
            v.same_as, ${tr(l, "area", "a.id", "name", "a.name")} AS area_name, a.slug AS area_slug, v.updated_at, ${entitySources("venue", "v.id")}
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
  /** Artists only: notable works that link out to official platforms. */
  notable_works?: { title: string; url: string; platform: string; year: string | null }[];
  sources: EntitySource[];
}

async function getPerson(table: "artists" | "organisers", join: "event_artists" | "event_organisers", fk: string, slug: string, locale: Locale) {
  const type = table === "artists" ? "artist" : "organiser";
  const pt = (field: string) => `${tr(locale, type, "p.id", field, `p.${field}`)} AS ${field}`;
  const extra = table === "artists" ? `p.kind, ${pt("genre")}, ${pt("hometown")}, p.notable_works,` : "";
  const { rows } = await getPool().query<PersonDetail>(
    `SELECT p.id, p.slug, ${pt("name")}, ${extra} ${pt("bio")}, p.official_links, p.same_as, p.updated_at, ${entitySources(type, "p.id")}
     FROM ${table} p
     WHERE p.slug = $1 AND EXISTS (SELECT 1 FROM ${join} j JOIN events e ON e.id = j.event_id WHERE j.${fk} = p.id AND e.is_published)`,
    [slug],
  );
  return rows[0] ?? null;
}
export const getArtist = (slug: string, locale: Locale = getLocale()) => getPerson("artists", "event_artists", "artist_id", slug, locale);
export const getOrganiser = (slug: string, locale: Locale = getLocale()) => getPerson("organisers", "event_organisers", "organiser_id", slug, locale);

export interface SeriesDetail extends Named {
  description: string | null; recurrence: string | null; official_links: Record<string, string>; updated_at: Date; sources: EntitySource[];
}
export async function getSeries(slug: string, locale: Locale = getLocale()): Promise<SeriesDetail | null> {
  const st = (field: string) => `${tr(locale, "series", "s.id", field, `s.${field}`)} AS ${field}`;
  const { rows } = await getPool().query<SeriesDetail>(
    `SELECT s.id, s.slug, ${st("name")}, ${st("description")}, ${st("recurrence")}, s.official_links, s.updated_at, ${entitySources("series", "s.id")}
     FROM series s WHERE s.slug = $1`, [slug]);
  return rows[0] ?? null;
}

/** Rows for the XML sitemaps: path and last-modified time. */
export async function sitemapRows(type: string): Promise<{ path: string; lastmod: Date }[]> {
  const q = (sql: string) => getPool().query<{ path: string; lastmod: Date }>(sql).then((r) => r.rows);
  const published = "EXISTS (SELECT 1 FROM events e WHERE e.is_published AND";
  switch (type) {
    case "events":
      // Parked (see PARKED.md): events not yet over carry noindex, so only finished ones are listed.
      return q(`SELECT '/' || c.slug || '/events/' || e.slug AS path, e.updated_at AS lastmod
                FROM events e JOIN cities c ON c.id = e.city_id WHERE e.is_published AND c.is_live
                ${parked.on ? "AND coalesce(e.ends_at, e.starts_at) < now()" : ""} ORDER BY e.starts_at DESC LIMIT 45000`);
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

/** A dated one-line note about an artist's new release, in our own words, with the post it came from (Prompt 10). */
export interface ArtistUpdate { text: string; post_url: string; posted_at: Date | null }

export async function artistUpdates(artistId: number, locale: Locale = getLocale()): Promise<ArtistUpdate[]> {
  return (await getPool().query<ArtistUpdate>(
    `SELECT ${tr(locale, "artist_post", "p.id", "update_text", "p.update_text")} AS text, p.post_url, p.posted_at
     FROM artist_posts p
     WHERE p.artist_id = $1 AND p.label = 'new_release' AND NOT p.hidden AND p.update_text IS NOT NULL
     ORDER BY p.posted_at DESC NULLS LAST, p.id DESC LIMIT 10`, [artistId])).rows;
}

/** An official video the owner has approved for an artist. Only YouTube's ID and facts are stored. */
export interface ArtistVideo {
  artist_slug: string; video_id: string; title: string; published_year: number | null; blurb: string | null; channel_title: string | null;
}

/** Approved videos for these artists, best-known first, at most `perArtist` each. */
export async function artistVideos(slugs: string[], perArtist: number, locale: Locale = getLocale()): Promise<ArtistVideo[]> {
  if (slugs.length === 0) return [];
  return (await getPool().query<ArtistVideo>(
    `SELECT artist_slug, video_id, title, published_year, blurb, channel_title FROM (
       SELECT a.slug AS artist_slug, v.video_id, v.title, v.published_year, ${tr(locale, "artist_video", "v.id", "blurb", "v.blurb")} AS blurb,
              v.channel_title, v.position, row_number() OVER (PARTITION BY v.artist_id ORDER BY v.position, v.id) AS n
       FROM artist_videos v JOIN artists a ON a.id = v.artist_id
       WHERE a.slug = ANY($1) AND v.status = 'approved') x
     WHERE n <= $2 ORDER BY artist_slug, position`, [slugs, perArtist])).rows;
}
