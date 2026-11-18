/**
 * Imports Instagram handles from a CSV with columns: handle, type, city, tier.
 * `city` may be the city slug or name (case-insensitive) and must already exist.
 * Existing handles are updated (type, city, tier) and reactivated.
 * Usage: npm run import:handles -- path/to/handles.csv [--dry-run] [--if-empty]
 * --if-empty imports only when the handles table has no rows yet. The release
 * command uses it to load the starting list once, without later overwriting
 * tiers changed by hand.
 */
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { getPool, closePool } from "../src/lib/db";

export interface HandleRow {
  handle: string;
  type: string;
  city: string;
  tier: "A" | "B";
}

export interface ImportResult {
  inserted: number;
  updated: number;
  errors: { line: number; message: string }[];
}

/** Minimal CSV line splitter that understands double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function normaliseHandle(raw: string): string {
  let h = raw.trim();
  const m = h.match(/instagram\.com\/([^/?#]+)/i);
  if (m) h = m[1];
  return h.replace(/^@/, "").toLowerCase();
}

export function parseHandlesCsv(text: string): { rows: (HandleRow & { line: number })[]; errors: ImportResult["errors"] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const required = ["handle", "type", "city", "tier"];
  const missing = required.filter((r) => idx(r) === -1);
  if (missing.length) {
    return { rows: [], errors: [{ line: 1, message: `missing column(s): ${missing.join(", ")}` }] };
  }
  const rows: (HandleRow & { line: number })[] = [];
  const errors: ImportResult["errors"] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = splitCsvLine(lines[i]);
    const handle = normaliseHandle(cols[idx("handle")] ?? "");
    const type = (cols[idx("type")] ?? "").toLowerCase();
    const city = cols[idx("city")] ?? "";
    const tier = (cols[idx("tier")] ?? "").toUpperCase();
    if (!/^[a-z0-9._]{1,30}$/.test(handle)) { errors.push({ line: i + 1, message: `invalid handle "${handle}"` }); continue; }
    if (!type) { errors.push({ line: i + 1, message: "type is empty" }); continue; }
    if (!city) { errors.push({ line: i + 1, message: "city is empty" }); continue; }
    if (tier !== "A" && tier !== "B") { errors.push({ line: i + 1, message: `tier must be A or B, got "${tier}"` }); continue; }
    rows.push({ handle, type, city, tier, line: i + 1 });
  }
  return { rows, errors };
}

export async function importHandles(pool: Pool, csvText: string, dryRun = false): Promise<ImportResult> {
  const { rows, errors } = parseHandlesCsv(csvText);
  const result: ImportResult = { inserted: 0, updated: 0, errors };
  const cities = await pool.query<{ id: number; slug: string; name: string }>("SELECT id, slug, name FROM cities");
  const cityId = (c: string) =>
    cities.rows.find((r) => r.slug === c.toLowerCase() || r.name.toLowerCase() === c.toLowerCase())?.id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const id = cityId(row.city);
      if (!id) { result.errors.push({ line: row.line, message: `unknown city "${row.city}"` }); continue; }
      const { rows: r } = await client.query<{ inserted: boolean }>(
        `INSERT INTO handles (handle, handle_type, city_id, tier) VALUES ($1,$2,$3,$4)
         ON CONFLICT (handle) DO UPDATE SET handle_type = EXCLUDED.handle_type, city_id = EXCLUDED.city_id,
           tier = EXCLUDED.tier, active = true, updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [row.handle, row.type, id, row.tier],
      );
      if (r[0].inserted) result.inserted++; else result.updated++;
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
    console.error("usage: npm run import:handles -- <file.csv> [--dry-run] [--if-empty]");
    process.exit(1);
  }
  const ifEmpty = args.includes("--if-empty");
  (async () => {
    if (ifEmpty && (await getPool().query("SELECT 1 FROM handles LIMIT 1")).rowCount) {
      console.log("handles table is not empty; nothing imported");
      await closePool();
      process.exit(0);
    }
    return importHandles(getPool(), readFileSync(file, "utf8"), dryRun);
  })()
    .then((r) => {
      console.log(`${dryRun ? "[dry run] would insert" : "inserted"} ${r.inserted}, updated ${r.updated}, errors ${r.errors.length}`);
      for (const e of r.errors) console.log(`  line ${e.line}: ${e.message}`);
      return closePool().then(() => process.exit(r.errors.length ? 2 : 0));
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
