/**
 * Idempotent seed: cities, areas, categories. Safe to run repeatedly.
 * Adding a city later = add it here (or insert rows directly), plus its areas.
 * Usage: npm run db:seed
 */
import type { Pool } from "pg";
import { getPool, closePool } from "../src/lib/db";

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
