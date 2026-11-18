/** Places added to the venue census by hand: from a CSV, or one at a time in the admin area. */
import type { Pool } from "pg";
import { nameKey } from "./text";

export const CENSUS_TYPES = [
  "auditorium", "club_bar", "cafe", "hotel_banquet", "mall", "college", "cultural_centre", "ground", "religious", "community", "other",
] as const;

export interface ManualPlace { name: string; type: string; address: string | null; instagram: string | null; facebook: string | null }

const cleanHandle = (s: string | undefined) => {
  const m = (s ?? "").trim().match(/^(?:https?:\/\/(?:www\.)?instagram\.com\/)?@?([A-Za-z0-9._]{1,30})\/?$/);
  return m ? m[1].toLowerCase() : null;
};

/** Simple CSV (no quoted commas needed for these columns): name,type,address,instagram,facebook. */
export function parseCensusCsv(text: string): ManualPlace[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines.shift()?.toLowerCase().split(",").map((h) => h.trim()) ?? [];
  const col = (cells: string[], name: string) => {
    const i = header.indexOf(name);
    return i >= 0 ? cells[i]?.trim() || undefined : undefined;
  };
  return lines.map((l) => l.split(",")).map((cells) => ({
    name: col(cells, "name") ?? "",
    type: (CENSUS_TYPES as readonly string[]).includes(col(cells, "type") ?? "") ? col(cells, "type")! : "other",
    address: col(cells, "address") ?? null,
    instagram: cleanHandle(col(cells, "instagram")),
    facebook: col(cells, "facebook") ?? null,
  })).filter((p) => p.name);
}

export async function addCensusRows(pool: Pool, citySlug: string, places: ManualPlace[]): Promise<{ rows: number; written: number }> {
  const city = (await pool.query<{ id: number; name: string }>("SELECT id, name FROM cities WHERE slug = $1", [citySlug])).rows[0];
  if (!city) throw new Error(`Unknown city ${citySlug}`);
  let written = 0;
  for (const p of places) {
    const key = nameKey(p.name, city.name);
    const r = await pool.query(
      `INSERT INTO venue_census (city_id, name, name_key, venue_type, address, source, source_ref, instagram_handle, facebook_url)
       VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,$8) ON CONFLICT DO NOTHING`,
      [city.id, p.name, key, p.type, p.address, `manual:${key}`, p.instagram, p.facebook]);
    written += r.rowCount ?? 0;
  }
  return { rows: places.length, written };
}
