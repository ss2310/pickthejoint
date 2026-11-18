/**
 * Venue census (Prompt 9). Free: OpenStreetMap through the Overpass API.
 *
 * Usage: npm run census -- --city indore [--dry-run] [--csv data/places.csv]
 *   --csv adds places by hand, columns: name,type,address,instagram,facebook
 * Housekeeping re-runs the OpenStreetMap part each month and links new venues daily.
 */
import { readFileSync } from "node:fs";
import { main } from "../src/lib/pipeline/job";
import { runCensus } from "../src/lib/pipeline/census";
import { addCensusRows, parseCensusCsv } from "../src/lib/pipeline/census-import";

main("census", async (pool, report, args) => {
  const city = args.city ?? "indore";
  report.osm = await runCensus(pool, { city, dryRun: args.dryRun });
  const i = process.argv.indexOf("--csv");
  if (i > 0 && process.argv[i + 1]) {
    const rows = parseCensusCsv(readFileSync(process.argv[i + 1], "utf8"));
    report.csv = args.dryRun ? { rows: rows.length, written: 0 } : await addCensusRows(pool, city, rows);
  }
});
