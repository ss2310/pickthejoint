/**
 * Ingestion job (run daily by a Railway cron service):
 *   1. scrape Instagram handles that are due (tier A daily, tier B weekly)
 *   2. fetch the Google event results and enabled news roundups (once a day each),
 *      the web calendars (every few days), public Facebook events and the
 *      hashtag discovery pull (weekly), and the newest posts of the Facebook
 *      pages that are due (every 2, 7 or 14 days by tier)
 *   3. process everything waiting: filter -> extract -> match / dedup -> publish
 *
 * Usage: npm run job:ingest -- [--dry-run] [--batch] [--city indore]
 *          [--handles a,b,c [--force]] [--limit 5]
 *          [--sources instagram,google,news,web,facebook,facebook-posts,discovery] [--process-only]
 *          [--max-items 5] (new items per web source, Facebook pages, discovery posts: for checks)
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
import { fetchCalendars } from "../../src/lib/pipeline/calendars";
import { fetchFacebookEvents } from "../../src/lib/pipeline/facebook";
import { fetchFacebookPosts } from "../../src/lib/pipeline/facebook-posts";
import { runDiscovery } from "../../src/lib/pipeline/discovery";
import { processPosts } from "../../src/lib/pipeline/process";
import { ingestion, translation } from "../../src/config";
import { translatePending } from "../../src/lib/pipeline/translate";
import { secondLook } from "../../src/config";
import { AnthropicResearch } from "../../src/lib/pipeline/research";
import { runSecondLook } from "../../src/lib/pipeline/second-look";

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
  const force = args.force && !args.handles?.length;
  if (!args.processOnly && args.sources.includes("web")) {
    report.web = await fetchCalendars(pool, llm, { jobName, dryRun: args.dryRun, city: args.city, maxItems: args.maxItems, force, batch: args.batch });
  }
  if (!args.processOnly && args.sources.includes("facebook")) {
    report.facebook = await fetchFacebookEvents(pool, apify, llm, { jobName, dryRun: args.dryRun, city: args.city, maxPages: args.maxItems, force, batch: args.batch });
  }
  if (!args.processOnly && args.sources.includes("facebook-posts")) {
    const posts = await fetchFacebookPosts(pool, apify, { jobName, dryRun: args.dryRun, city: args.city, maxPages: args.maxItems, force });
    report.facebookPosts = posts;
    if (args.dryRun) expectedNewPosts += posts.maxPosts;
  }
  if (!args.processOnly && args.sources.includes("discovery")) {
    report.discovery = await runDiscovery(pool, apify, { jobName, dryRun: args.dryRun, city: args.city, maxPosts: args.maxItems, force });
  }
  const pipeline = await processPosts(pool, { llm, apify }, { jobName, dryRun: args.dryRun, batch: args.batch, expectedNewPosts });
  report.pipeline = pipeline;

  // Second look (off unless SECOND_LOOK=on): tries to settle the uncertain events waiting in the review queue.
  if (secondLook.enabled) {
    try {
      report.secondLook = await runSecondLook(pool, { llm, research: new AnthropicResearch() }, { jobName, dryRun: args.dryRun, batch: args.batch, city: args.city });
    } catch (err) {
      // A second-look problem must not fail the job: the items simply stay in the queue for a person.
      report.secondLook = { error: (err as Error).message.slice(0, 300) };
    }
  }
  if (args.dryRun) return;

  // New or changed text gets its Hindi now, so it is never translated on page load.
  if (translation.enabled) {
    try {
      report.translation = await translatePending(pool, llm, { jobName: jobName, batch: args.batch });
    } catch (err) {
      // A translation problem must not fail the job: Hindi pages fall back to English until the next run.
      report.translation = { error: (err as Error).message.slice(0, 300) };
    }
  }

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
