/**
 * IndexNow: tells Bing (and the engines that share its index, which ChatGPT
 * search draws on) which pages are new, changed or gone, in one batched ping
 * per job run. A page is announced when its event changed since the last
 * successful ping: the event page, its venue, performer and organiser pages,
 * and the hub pages it appears on. An unpublished or cancelled event is
 * announced too, so its change is picked up as quickly as a new one.
 */
import type { Pool } from "pg";
import { indexNow, locales, site } from "../config";
import { localePath } from "./locale";
import { DATE_HUBS } from "./hubs";

export interface IndexNowReport { urls: number; status: string; sample?: string[] }

const STATE_KEY = "indexnow";

export async function changedPaths(pool: Pool, since: Date | null): Promise<string[]> {
  const paths = new Set<string>();
  const { rows } = await pool.query<{
    city: string; slug: string; venue: string | null; area: string | null; category: string | null;
    artists: string[] | null; organisers: string[] | null; series: string | null;
  }>(
    `SELECT c.slug AS city, e.slug, v.slug AS venue, a.slug AS area, cat.slug AS category, s.slug AS series,
            (SELECT array_agg(ar.slug) FROM event_artists ea JOIN artists ar ON ar.id = ea.artist_id WHERE ea.event_id = e.id) AS artists,
            (SELECT array_agg(o.slug) FROM event_organisers eo JOIN organisers o ON o.id = eo.organiser_id WHERE eo.event_id = e.id) AS organisers
     FROM events e JOIN cities c ON c.id = e.city_id
     LEFT JOIN venues v ON v.id = e.venue_id LEFT JOIN areas a ON a.id = v.area_id
     LEFT JOIN categories cat ON cat.id = e.category_id LEFT JOIN series s ON s.id = e.series_id
     WHERE c.is_live AND ($1::timestamptz IS NULL OR e.updated_at > $1)
       -- The first ping announces what is live; later ones also announce pages that have just come down.
       AND ($1::timestamptz IS NOT NULL OR e.is_published)
     ORDER BY e.updated_at DESC LIMIT 5000`, [since]);
  for (const r of rows) {
    const base = `/${r.city}`;
    paths.add(`${base}/events/${r.slug}`);
    paths.add(base);
    for (const h of DATE_HUBS) paths.add(`${base}/${h}`);
    paths.add(`${base}/past`);
    if (r.venue) paths.add(`${base}/venues/${r.venue}`);
    if (r.area) paths.add(`${base}/area/${r.area}`);
    if (r.category) paths.add(`${base}/${r.category}`);
    if (r.series) paths.add(`/series/${r.series}`);
    for (const s of r.artists ?? []) paths.add(`/artists/${s}`);
    for (const s of r.organisers ?? []) paths.add(`/organisers/${s}`);
  }
  // Venue, artist and organiser pages filled in by enrichment since the last ping.
  if (since) {
    const enriched = await pool.query<{ path: string }>(
      `SELECT '/' || c.slug || '/venues/' || v.slug AS path FROM venues v JOIN cities c ON c.id = v.city_id
       WHERE c.is_live AND v.enriched_at > $1 AND EXISTS (SELECT 1 FROM events e WHERE e.venue_id = v.id AND e.is_published)
       UNION ALL
       SELECT '/artists/' || p.slug FROM artists p WHERE p.enriched_at > $1 AND p.bio IS NOT NULL
         AND EXISTS (SELECT 1 FROM event_artists j JOIN events e ON e.id = j.event_id WHERE j.artist_id = p.id AND e.is_published)
       UNION ALL
       SELECT '/organisers/' || p.slug FROM organisers p WHERE p.enriched_at > $1 AND p.bio IS NOT NULL
         AND EXISTS (SELECT 1 FROM event_organisers j JOIN events e ON e.id = j.event_id WHERE j.organiser_id = p.id AND e.is_published)`, [since]);
    for (const r of enriched.rows) paths.add(r.path);
  }
  // Weekly guides published, unpublished or reworded since the last ping (Prompt 11).
  const guides = await pool.query<{ city: string; slug: string }>(
    `SELECT c.slug AS city, r.slug FROM roundups r JOIN cities c ON c.id = r.city_id
     WHERE c.is_live AND r.published_at IS NOT NULL AND ($1::timestamptz IS NULL OR r.updated_at > $1)`, [since]);
  for (const g of guides.rows) { paths.add(`/${g.city}/guide/${g.slug}`); paths.add(`/${g.city}/guide`); }
  // Every one of these pages exists in each language.
  return [...paths].flatMap((p) => locales.map((l) => localePath(p, l)));
}

export async function pingIndexNow(pool: Pool, opts: { dryRun?: boolean; fetchFn?: typeof fetch; force?: boolean } = {}): Promise<IndexNowReport> {
  if (!indexNow.enabled && !opts.force) return { urls: 0, status: "off (INDEXNOW is not set to on)" };
  const started = new Date();
  const state = await pool.query<{ last_fetched_at: Date | null }>("SELECT last_fetched_at FROM source_state WHERE source_key = $1", [STATE_KEY]);
  const paths = await changedPaths(pool, state.rows[0]?.last_fetched_at ?? null);
  if (paths.length === 0) return { urls: 0, status: "nothing changed" };
  const sample = paths.slice(0, 5);
  if (opts.dryRun) return { urls: paths.length, status: "dry run: not sent", sample };

  const host = new URL(site.url).hostname;
  const fetchFn = opts.fetchFn ?? fetch;
  // One request carries up to 10,000 URLs.
  for (let i = 0; i < paths.length; i += 10_000) {
    const res = await fetchFn(indexNow.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host, key: indexNow.key, keyLocation: `${site.url}/${indexNow.key}.txt`,
        urlList: paths.slice(i, i + 10_000).map((p) => `${site.url}${p}`),
      }),
    });
    // 200 = accepted, 202 = accepted, key check pending.
    if (res.status !== 200 && res.status !== 202) {
      return { urls: paths.length, status: `failed: IndexNow answered ${res.status} ${(await res.text()).slice(0, 200)}`, sample };
    }
  }
  await pool.query(
    `INSERT INTO source_state (source_key, last_fetched_at, last_status) VALUES ($1, $2, 'ok')
     ON CONFLICT (source_key) DO UPDATE SET last_fetched_at = $2, last_status = 'ok'`, [STATE_KEY, started]);
  return { urls: paths.length, status: "sent", sample };
}
