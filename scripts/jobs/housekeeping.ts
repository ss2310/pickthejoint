/**
 * Housekeeping job (run daily by a Railway cron service). No paid calls.
 *   - merges duplicates and moves finished events to the archive;
 *   - looks up coordinates for venues that have none (a few per day);
 *   - once a week (Mondays), or with --crawl-check, requests the live site as
 *     each AI crawler and alerts if any is turned away;
 *   - links new venues into the venue census and events into festival series;
 *   - on the first of the month (or with --retier): re-tiers Instagram handles
 *     and refreshes the OpenStreetMap part of the census;
 *   - on Mondays (or with --coverage): stores last week's coverage report;
 *   - tells IndexNow which pages changed.
 * Usage: npm run job:housekeeping -- [--dry-run] [--crawl-check] [--retier] [--coverage]
 */
import { main } from "../../src/lib/pipeline/job";
import { sendAlert } from "../../src/lib/alerts";
import { crawlCheck } from "../../src/lib/crawl-check";
import { pingIndexNow } from "../../src/lib/indexnow";
import { geocodeVenues } from "../../src/lib/pipeline/geocode";
import { housekeeping } from "../../src/lib/pipeline/housekeeping";
import { displayTimeZone, site } from "../../src/config";
import { linkCensus, runCensus } from "../../src/lib/pipeline/census";
import { attachSeries } from "../../src/lib/pipeline/series";
import { retierHandles } from "../../src/lib/pipeline/tiering";
import { storeLastWeek } from "../../src/lib/coverage";
import { sourcingData } from "../../src/lib/pipeline/sourcing-data";

main("housekeeping", async (pool, report, args) => {
  Object.assign(report, await housekeeping(pool, { dryRun: args.dryRun }));
  if (args.dryRun) return;

  report.geocoding = await geocodeVenues(pool);
  report.census = { linked: await linkCensus(pool) };
  report.seriesAttached = await attachSeries(pool);

  const dayOfMonth = Number(new Intl.DateTimeFormat("en-US", { timeZone: displayTimeZone, day: "numeric" }).format(new Date()));
  if (args.retier || dayOfMonth === 1) {
    report.retier = await retierHandles(pool);
    const live = (await pool.query<{ slug: string }>("SELECT slug FROM cities WHERE is_live")).rows.map((c) => c.slug);
    report.censusRefresh = [];
    for (const slug of live.filter((s) => sourcingData()[s]?.censusBbox)) {
      (report.censusRefresh as unknown[]).push(await runCensus(pool, { city: slug }).catch((err) => ({ city: slug, status: `failed: ${(err as Error).message}` })));
    }
  }

  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: displayTimeZone, weekday: "long" }).format(new Date());
  if (args.crawlCheck || process.env.CRAWL_CHECK === "now" || weekday === "Monday") {
    const check = await crawlCheck(pool, { delayMs: 300 });
    report.crawlAccess = check;
    if (!check.ok) {
      await sendAlert("AI crawlers are being blocked",
        `The crawl access check on ${site.url} found ${check.blocked.length} blocked request(s) out of ${check.requests}.\n\n` +
        Object.entries(check.byAgent).filter(([, v]) => v !== "200 on every page").map(([k, v]) => `${k}: ${v}`).join("\n") +
        "\n\nA 403 or challenge page usually means a CDN setting (for example Cloudflare's \"Block AI bots\") has been switched on.");
    }
  }
  if (args.coverage || weekday === "Monday") report.coverage = await storeLastWeek(pool);
  report.indexNow = await pingIndexNow(pool);
});
