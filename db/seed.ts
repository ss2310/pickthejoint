/**
 * Idempotent seed: cities, areas, categories, citation questions, festival series. Safe to run repeatedly.
 * Adding a city later = add it here (or insert rows directly), plus its areas.
 * Usage: npm run db:seed
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/lib/db";

/** The owner-approved citation questions (Prompt 8): { city: { en: [...], hi: [...] } }. */
export function citationQuestions(): Record<string, Record<"en" | "hi", string[]>> {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "citation-queries.json"), "utf8")) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_"))) as Record<string, Record<"en" | "hi", string[]>>;
}

export interface SeedSeries {
  slug: string; name: string; recurrence: string; months: number[]; aliases: string[]; description: string;
  sources: { url: string; title: string; fact: string }[];
}

/** Recurring festivals seeded before their dates are announced (Prompt 9): { city: [...] }. */
export function seedSeries(): Record<string, SeedSeries[]> {
  const raw = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "series.json"), "utf8")) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_"))) as Record<string, SeedSeries[]>;
}

export const seedCities = [{ slug: "indore", name: "Indore", state: "Madhya Pradesh", is_live: true }];

/** Starter Indore areas (localities people use when saying where something is). */
export const seedAreas: Record<string, string[]> = {
  indore: [
    "Vijay Nagar", "Scheme No. 54", "Scheme No. 78", "Nipania", "Bicholi Mardana",
    "Old Palasia", "New Palasia", "South Tukoganj", "Race Course Road", "MG Road",
    "AB Road", "Rajwada", "Sarafa", "Chhawni", "Malharganj",
    "Rajendra Nagar", "Annapurna", "Sudama Nagar", "Bhawarkuan", "Navlakha",
    "Geeta Bhawan", "Manorama Ganj", "Saket Nagar", "Tilak Nagar", "Bengali Square",
    "Khajrana", "LIG Colony", "Sukhliya", "Sapna Sangeeta", "Pipliyahana",
    "Lasudia", "Super Corridor", "Bypass Road", "Rau", "Mhow",
  ],
};

export const seedCategories = [
  ["music", "Music"],
  ["comedy", "Comedy"],
  ["theatre", "Theatre"],
  ["dance", "Dance"],
  ["workshops", "Workshops"],
  ["kids", "Kids"],
  ["food", "Food"],
  ["festivals", "Festivals"],
  ["religious-and-cultural", "Religious and cultural"],
  ["sports-and-fitness", "Sports and fitness"],
  ["exhibitions", "Exhibitions"],
  ["college-events", "College events"],
  ["business-and-networking", "Business and networking"],
  ["nightlife", "Nightlife"],
] as const;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function seed(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const c of seedCities) {
      await client.query(
        `INSERT INTO cities (slug, name, state, is_live) VALUES ($1,$2,$3,$4)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, state = EXCLUDED.state, updated_at = now()`,
        [c.slug, c.name, c.state, c.is_live],
      );
    }
    for (const [citySlug, areas] of Object.entries(seedAreas)) {
      const { rows } = await client.query<{ id: number }>("SELECT id FROM cities WHERE slug = $1", [citySlug]);
      for (const name of areas) {
        await client.query(
          `INSERT INTO areas (city_id, slug, name) VALUES ($1,$2,$3)
           ON CONFLICT (city_id, slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
          [rows[0].id, slugify(name), name],
        );
      }
    }
    let order = 0;
    for (const [slug, name] of seedCategories) {
      await client.query(
        `INSERT INTO categories (slug, name, sort_order) VALUES ($1,$2,$3)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order`,
        [slug, name, order++],
      );
    }
    // Citation questions: the file is the list. A question no longer in it is switched off, never deleted
    // (its past results stay comparable).
    for (const [citySlug, byLocale] of Object.entries(citationQuestions())) {
      const city = (await client.query<{ id: number }>("SELECT id FROM cities WHERE slug = $1", [citySlug])).rows[0];
      if (!city) continue;
      const keep: number[] = [];
      for (const locale of ["en", "hi"] as const) {
        for (const [i, query] of (byLocale[locale] ?? []).entries()) {
          const { rows } = await client.query<{ id: number }>(
            `INSERT INTO citation_queries (city_id, locale, query, position, active) VALUES ($1,$2,$3,$4,true)
             ON CONFLICT (city_id, locale, query) DO UPDATE SET position = EXCLUDED.position, active = true RETURNING id`,
            [city.id, locale, query, i + 1]);
          keep.push(rows[0].id);
        }
      }
      await client.query("UPDATE citation_queries SET active = false WHERE city_id = $1 AND NOT (id = ANY($2::bigint[]))", [city.id, keep]);
    }
    // Festival series: the file adds and updates; a series is never deleted (its past events point at it).
    // A series' sources are replaced from the file; its text changes only when the file changes.
    for (const [citySlug, list] of Object.entries(seedSeries())) {
      const city = (await client.query<{ id: number }>("SELECT id FROM cities WHERE slug = $1", [citySlug])).rows[0];
      if (!city) continue;
      for (const s of list) {
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO series (slug, name, city_id, description, recurrence, aliases, months) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, city_id = EXCLUDED.city_id, description = EXCLUDED.description,
             recurrence = EXCLUDED.recurrence, aliases = EXCLUDED.aliases, months = EXCLUDED.months,
             updated_at = CASE WHEN (series.name, series.description, series.recurrence) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.description, EXCLUDED.recurrence)
                               THEN now() ELSE series.updated_at END
           RETURNING id`,
          [s.slug, s.name, city.id, s.description, s.recurrence, s.aliases.map((a) => a.toLowerCase()), s.months]);
        await client.query("DELETE FROM entity_sources WHERE entity_type = 'series' AND entity_id = $1", [rows[0].id]);
        for (const src of s.sources) {
          await client.query(
            "INSERT INTO entity_sources (entity_type, entity_id, url, title, fact, strength) VALUES ('series',$1,$2,$3,$4,$5)",
            [rows[0].id, src.url, src.title, src.fact, /\.gov\.in\//.test(src.url) ? "official" : /wikipedia\.org/.test(src.url) ? "weak" : "reputable"]);
        }
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seed(getPool())
    .then(() => console.log("seeded"))
    .then(closePool)
    .catch((err) => { console.error(err); process.exit(1); });
}
