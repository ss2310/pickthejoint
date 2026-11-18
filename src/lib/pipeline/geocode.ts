/**
 * Venue coordinates from OpenStreetMap's Nominatim, the free geocoder whose
 * usage policy allows this: identified by a User-Agent with a contact address,
 * at most one request a second, small volumes, results stored (OSM data is
 * open under the ODbL, credited on the "how we verify" page).
 * Each venue is tried once, and once more when enrichment gives it an address
 * (enrich.ts clears geocoded_at). The venue is looked up by name first; if that
 * finds nothing sure and an address is on file, the address is looked up too.
 * A confident match is saved; a doubtful one goes to the review queue instead
 * of onto the page.
 */
import type { Pool } from "pg";
import { site } from "../../config";
import { diceSimilarity, nameKey } from "./text";

export interface GeocodeReport { tried: number; located: number; queued: number; notFound: number; errors: string[] }

interface Candidate { lat: string; lon: string; name?: string; display_name: string; category?: string; type?: string; addresstype?: string }

/** Results that are a whole locality rather than a place inside it. */
const AREA_TYPES = new Set(["city", "town", "village", "suburb", "neighbourhood", "state", "county", "administrative", "postcode", "road", "residential", "state_district", "city_district"]);

/** How sure we are that a geocoder result is this venue: 0..1. */
export function matchConfidence(venueName: string, cityName: string, c: Candidate): number {
  if (!c.display_name.toLowerCase().includes(cityName.toLowerCase())) return 0;
  if (AREA_TYPES.has(c.addresstype ?? "") || AREA_TYPES.has(c.type ?? "")) return 0.2;
  const want = nameKey(venueName, cityName);
  const got = nameKey(c.name || c.display_name.split(",")[0], cityName);
  if (!want || !got) return 0.2;
  if (want === got) return 0.95;
  if (got.startsWith(`${want} `) || want.startsWith(`${got} `)) return 0.85;
  return Math.min(0.8, diceSimilarity(want, got));
}

/** Kinds of result that are a single place (a building, a shop, a hall) rather than a street or district. */
const POINT_CLASSES = new Set(["amenity", "building", "shop", "tourism", "leisure", "office", "place", "craft", "club", "historic"]);

/**
 * How sure we are that a result for the venue's address is the venue. A result
 * carrying the venue's name is judged as a name match. Any other single place at
 * that address may be the shop next door, so it is only ever good enough for
 * review, never for the page.
 */
export function addressConfidence(venueName: string, cityName: string, c: Candidate): number {
  const byName = matchConfidence(venueName, cityName, c);
  if (byName >= 0.8) return byName;
  if (byName === 0) return 0;
  if (AREA_TYPES.has(c.addresstype ?? "") || AREA_TYPES.has(c.type ?? "")) return 0.3;
  return POINT_CLASSES.has(c.category ?? "") ? 0.6 : 0.4;
}

export async function geocodeVenues(
  pool: Pool, opts: { fetchFn?: typeof fetch; limit?: number; delayMs?: number; minConfidence?: number } = {},
): Promise<GeocodeReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const min = opts.minConfidence ?? 0.8;
  const report: GeocodeReport = { tried: 0, located: 0, queued: 0, notFound: 0, errors: [] };
  const { rows } = await pool.query<{ id: number; name: string; address: string | null; area: string | null; city: string; state: string }>(
    `SELECT v.id, v.name, v.address, a.name AS area, c.name AS city, c.state
     FROM venues v JOIN cities c ON c.id = v.city_id LEFT JOIN areas a ON a.id = v.area_id
     WHERE v.lat IS NULL AND v.geocoded_at IS NULL
       AND EXISTS (SELECT 1 FROM events e WHERE e.venue_id = v.id AND e.is_published)
     ORDER BY v.id LIMIT $1`, [opts.limit ?? 15]);

  for (const v of rows) {
    report.tried++;
    try {
      const search = async (query: string) => {
        const res = await fetchFn(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: query, format: "jsonv2", limit: "3", countrycodes: "in" })}`, {
          headers: { "User-Agent": `PickTheJointBot/1.0 (+${site.url}/about${site.contactEmail ? `; ${site.contactEmail}` : ""})`, Accept: "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
        return (await res.json()) as Candidate[];
      };
      let q = [v.name, v.area, v.city, v.state, "India"].filter(Boolean).join(", ");
      let scored = (await search(q)).map((c) => ({ c, confidence: matchConfidence(v.name, v.city, c) })).sort((a, b) => b.confidence - a.confidence);
      if (v.address && !(scored[0]?.confidence >= min)) {
        // The name alone was not enough: try the address (one request a second, as the geocoder asks).
        await new Promise((r) => setTimeout(r, opts.delayMs ?? 1100));
        const byAddress = [v.address, v.address.toLowerCase().includes(v.city.toLowerCase()) ? null : v.city, v.state, "India"].filter(Boolean).join(", ");
        const found = (await search(byAddress)).map((c) => ({ c, confidence: addressConfidence(v.name, v.city, c) })).sort((a, b) => b.confidence - a.confidence);
        if (found[0] && found[0].confidence > (scored[0]?.confidence ?? 0)) { scored = found; q = byAddress; }
      }
      const best = scored[0];
      if (best && best.confidence >= min) {
        await pool.query("UPDATE venues SET lat = $2, lng = $3, geocode_confidence = $4, geocoded_at = now(), updated_at = now() WHERE id = $1",
          [v.id, Number(best.c.lat), Number(best.c.lon), best.confidence]);
        report.located++;
      } else {
        await pool.query("UPDATE venues SET geocoded_at = now() WHERE id = $1", [v.id]);
        if (best && best.confidence >= 0.4) {
          await pool.query("INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('venue_geocode', $1, $2, $3)",
            [v.id, "geocoder match is not confident enough to publish", {
              venue: v.name, query: q,
              candidates: scored.slice(0, 3).map((s) => ({ name: s.c.display_name, lat: Number(s.c.lat), lng: Number(s.c.lon), confidence: Number(s.confidence.toFixed(2)) })),
            }]);
          report.queued++;
        } else {
          report.notFound++;
        }
      }
    } catch (err) {
      // Left untried so a later run can have another go.
      report.errors.push(`${v.name}: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 1100));
  }
  return report;
}
