/**
 * Ingestion job (run daily by a Railway cron service):
 *   1. scrape Instagram handles that are due (tier A daily, tier B weekly)
 *   2. fetch the Google event results and enabled news roundups (once a day each)
 *   3. process everything waiting: filter -> extract -> match / dedup -> publish
 *
 * Usage: npm run job:ingest -- [--dry-run] [--batch] [--city indore]
 *          [--handles a,b,c [--force]] [--limit 5]
 *          [--sources instagram,google,news] [--process-only]
 * --dry-run shows what the run would do and cost without calling any paid service.
 * --batch sends model calls through the Message Batches API (half price, slower).
 */
import { main } from "../../src/lib/pipeline/job";
import { HttpApifyClient } from "../../src/lib/pipeline/apify";
import { AnthropicLlm } from "../../src/lib/pipeline/llm";
import { sendAlert, unexpectedlyEmpty } from "../../src/lib/alerts";
import { pingIndexNow } from "../../src/lib/indexnow";
import { scrapeInstagram, type ScrapeReport } from "../../src/lib/pipeline/scrape";
import { fetchGoogleEvents, fetchNewsCalendars } from "../../src/lib/pipeline/sources";
import { processPosts } from "../../src/lib/pipeline/process";
import { ingestion } from "../../src/config";

main("ingest", async (pool, report, args) => {
  const llm = new AnthropicLlm();
  const apify = new HttpApifyClient();
  const jobName = "ingest";
  let expectedNewPosts = 0;

  if (!args.processOnly && args.sources.includes("instagram")) {
    const scrape = await scrapeInstagram(pool, apify, { ...args, jobName });
    report.instagram = scrape;
    if (args.dryRun) expectedNewPosts = scrape.handlesDue * ingestion.postsPerHandle;
  }
  if (!args.processOnly && args.sources.includes("google")) {
    report.google = await fetchGoogleEvents(pool, { jobName, dryRun: args.dryRun, city: args.city });
  }
  if (!args.processOnly && args.sources.includes("news")) {
    report.news = await fetchNewsCalendars(pool, llm, { jobName, dryRun: args.dryRun, city: args.city });
  }
  const pipeline = await processPosts(pool, { llm, apify }, { jobName, dryRun: args.dryRun, batch: args.batch, expectedNewPosts });
  report.pipeline = pipeline;
  if (args.dryRun) return;

  report.indexNow = await pingIndexNow(pool);

  // A run that checked handles but found no events, when recent runs usually found some,
  // most likely means the scraper has broken without raising an error.
  const scrape = report.instagram as ScrapeReport | undefined;
  if (scrape && scrape.handlesChecked > 0) {
    const { rows } = await pool.query<{ created: number | null }>(
      `SELECT (report->'pipeline'->'resolve'->>'created')::int AS created FROM job_runs
       WHERE job_name = 'ingest' AND status = 'ok' AND NOT dry_run AND finished_at IS NOT NULL
         AND (report->'instagram'->>'handlesChecked')::int > 0
       ORDER BY id DESC LIMIT 7`);
    const found = pipeline.resolve.created + pipeline.resolve.merged;
    if (unexpectedlyEmpty(found, rows.map((r) => r.created ?? 0))) {
      report.alert = await sendAlert("The ingest job found no events",
        `Today's run checked ${scrape.handlesChecked} handle(s) and fetched ${scrape.postsNew} new post(s) but found no events, although recent runs usually find some.\n\n` +
        `Posts returned by the actor: ${scrape.postsReturned}. Actor errors: ${scrape.errors.join("; ") || "none"}.\n` +
        "If the actor returned nothing, check it on Apify: Instagram scrapers break when Instagram changes.");
    }
  }
});
