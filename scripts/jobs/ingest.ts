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
import { scrapeInstagram } from "../../src/lib/pipeline/scrape";
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
  report.pipeline = await processPosts(pool, { llm, apify }, { jobName, dryRun: args.dryRun, batch: args.batch, expectedNewPosts });
});
