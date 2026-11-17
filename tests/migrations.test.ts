import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { freshDb } from "./helpers";
import { migrate } from "../scripts/migrate";
import { seed, seedAreas, seedCategories } from "../db/seed";

let pool: Pool;
beforeAll(async () => { pool = await freshDb(); });
afterAll(async () => { await pool.end(); });

describe("migrations and seed", () => {
  it("creates every table on a fresh database", async () => {
    const { rows } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    const names = rows.map((r) => r.tablename);
    for (const t of ["cities", "areas", "categories", "venues", "artists", "organisers", "series", "events",
      "event_artists", "event_organisers", "sources", "translations", "handles", "suggested_handles", "raw_posts",
      "review_queue", "cost_log", "search_log", "crawler_log", "citation_queries", "citation_results"]) {
      expect(names).toContain(t);
    }
  });

  it("is a no-op when run again", async () => {
    expect(await migrate(process.env.TEST_DATABASE_URL!, () => {})).toEqual([]);
  });

  it("seeds idempotently", async () => {
    await seed(pool);
    await seed(pool);
    const counts = await pool.query(`SELECT (SELECT count(*) FROM cities)::int c, (SELECT count(*) FROM areas)::int a,
      (SELECT count(*) FROM categories)::int k`);
    expect(counts.rows[0]).toEqual({ c: 1, a: seedAreas.indore.length, k: seedCategories.length });
  });

  it("full-text search finds an event by title", async () => {
    const city = (await pool.query("SELECT id FROM cities WHERE slug = 'indore'")).rows[0].id;
    await pool.query(`INSERT INTO events (city_id, slug, title, starts_at, origin) VALUES ($1, 'x', 'Open mic comedy night', now(), 'scraped')`, [city]);
    const { rows } = await pool.query(`SELECT title FROM events WHERE search_tsv @@ plainto_tsquery('simple', 'comedy')`);
    expect(rows).toHaveLength(1);
  });
});
