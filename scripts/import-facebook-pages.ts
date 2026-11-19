/**
 * Loads public Facebook pages from a CSV with columns: page_url, name, city,
 * tier (A, B or C), category, city_filter (yes for statewide or national
 * pages, whose posts are kept only when they name the city).
 * Usage: npm run import:facebook-pages -- path/to/pages.csv [--dry-run]
 *
 * Safe to run on every release: a page already on record keeps its tier and
 * its on/off switch (those are the admin's to change at /admin/coverage); it
 * only gains a name or category it lacked.
 */
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/lib/db";
import { facebookPage } from "../src/lib/pipeline/facebook";
import { splitCsvLine } from "./import-handles";

export interface PageRow {
  page: string;
  name: string | null;
  city: string;
  tier: "A" | "B" | "C";
  category: string | null;
  cityFilter: boolean;
  line: number;
}

export interface PageImportResult {
  inserted: number;
  alreadyKnown: number;
  errors: { line: number; message: string }[];
}

export function parsePagesCsv(text: string): { rows: PageRow[]; errors: PageImportResult["errors"] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const missing = ["page_url", "city"].filter((r) => idx(r) === -1);
  if (missing.length) return { rows: [], errors: [{ line: 1, message: `missing column(s): ${missing.join(", ")}` }] };
  const col = (cols: string[], name: string) => (idx(name) === -1 ? "" : cols[idx(name)] ?? "");
  const rows: PageRow[] = [];
  const errors: PageImportResult["errors"] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = splitCsvLine(lines[i]);
    const page = facebookPage(col(cols, "page_url"));
    const city = col(cols, "city");
    const tier = (col(cols, "tier") || "B").toUpperCase();
    if (!page) { errors.push({ line: i + 1, message: `not a link to a Facebook page: "${col(cols, "page_url")}"` }); continue; }
    if (!city) { errors.push({ line: i + 1, message: "city is empty" }); continue; }
    if (tier !== "A" && tier !== "B" && tier !== "C") { errors.push({ line: i + 1, message: `tier must be A, B or C, got "${tier}"` }); continue; }
    const key = `${city.toLowerCase()}/${page.toLowerCase()}`;
    if (seen.has(key)) { errors.push({ line: i + 1, message: `facebook.com/${page} is listed twice` }); continue; }
    seen.add(key);
    rows.push({
      page, name: col(cols, "name") || null, city, tier, category: col(cols, "category") || null,
      cityFilter: /^(yes|true|1)$/i.test(col(cols, "city_filter")), line: i + 1,
    });
  }
  return { rows, errors };
}

export async function importFacebookPages(pool: Pool, csvText: string, dryRun = false): Promise<PageImportResult> {
  const { rows, errors } = parsePagesCsv(csvText);
  const result: PageImportResult = { inserted: 0, alreadyKnown: 0, errors };
  const cities = await pool.query<{ id: number; slug: string; name: string }>("SELECT id, slug, name FROM cities");
  const cityId = (c: string) => cities.rows.find((r) => r.slug === c.toLowerCase() || r.name.toLowerCase() === c.toLowerCase())?.id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const id = cityId(row.city);
      if (!id) { result.errors.push({ line: row.line, message: `unknown city "${row.city}"` }); continue; }
      // Facebook addresses ignore case, so "MarqIndore" and "marqindore" are one page.
      const known = await client.query(
        `UPDATE facebook_pages SET name = coalesce(name, $3), category = coalesce(category, $4), city_filter = city_filter OR $5
         WHERE city_id = $1 AND lower(page) = lower($2)`, [id, row.page, row.name, row.category, row.cityFilter]);
      if (known.rowCount) { result.alreadyKnown++; continue; }
      await client.query(
        `INSERT INTO facebook_pages (city_id, page, name, tier, category, city_filter, added_via) VALUES ($1,$2,$3,$4,$5,$6,'import')`,
        [id, row.page, row.name, row.tier, row.category, row.cityFilter]);
      result.inserted++;
    }
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (!file) {
    console.error("usage: npm run import:facebook-pages -- <file.csv> [--dry-run]");
    process.exit(1);
  }
  importFacebookPages(getPool(), readFileSync(file, "utf8"), dryRun)
    .then((r) => {
      console.log(`${dryRun ? "[dry run] would add" : "added"} ${r.inserted} Facebook page(s), ${r.alreadyKnown} already on record, errors ${r.errors.length}`);
      for (const e of r.errors) console.log(`  line ${e.line}: ${e.message}`);
      // A bad line must not block a release: the rest of the list is loaded and the line is reported.
      return closePool().then(() => process.exit(0));
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
