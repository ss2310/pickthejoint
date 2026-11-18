import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { freshDb } from "./helpers";
import { seed } from "../db/seed";
import { importHandles, normaliseHandle } from "../scripts/import-handles";

let pool: Pool;
beforeAll(async () => { pool = await freshDb(); await seed(pool); });
afterAll(async () => { await pool.end(); });

describe("handle import", () => {
  it("imports the 3-row sample CSV", async () => {
    const csv = readFileSync(join(__dirname, "..", "data", "sample-handles.csv"), "utf8");
    const r = await importHandles(pool, csv);
    expect(r).toEqual({ inserted: 3, updated: 0, errors: [] });
    const { rows } = await pool.query("SELECT handle, handle_type, tier FROM handles ORDER BY handle");
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.tier === "A" || x.tier === "B")).toBe(true);
  });

  it("is idempotent and updates tiers on re-import", async () => {
    const csv = "handle,type,city,tier\n@sample_venue_one,venue,Indore,B\n";
    const r = await importHandles(pool, csv);
    expect(r).toEqual({ inserted: 0, updated: 1, errors: [] });
    const { rows } = await pool.query("SELECT tier FROM handles WHERE handle = 'sample_venue_one'");
    expect(rows[0].tier).toBe("B");
  });

  it("reports bad rows without importing them", async () => {
    const csv = "handle,type,city,tier\nok_handle,cafe,indore,C\nbad handle!,cafe,indore,A\nnew_one,cafe,bhopal,A\n";
    const r = await importHandles(pool, csv);
    expect(r.inserted).toBe(0);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
  });

  it("normalises handles from @names and profile URLs", () => {
    expect(normaliseHandle("@Some.Venue")).toBe("some.venue");
    expect(normaliseHandle("https://www.instagram.com/some_venue/?hl=en")).toBe("some_venue");
  });

  it("dry run writes nothing", async () => {
    const r = await importHandles(pool, "handle,type,city,tier\ndry_only,cafe,indore,A\n", true);
    expect(r.inserted).toBe(1);
    const { rows } = await pool.query("SELECT 1 FROM handles WHERE handle = 'dry_only'");
    expect(rows).toHaveLength(0);
  });
});
