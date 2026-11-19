/**
 * Second look, run by itself over the review queue: tries to settle the
 * uncertain events already waiting there. See src/lib/pipeline/second-look.ts.
 * (The daily ingest job runs the same step after it has processed new posts.)
 *
 * Usage: npm run job:second-look -- [--dry-run] [--batch] [--city indore] [--limit 5]
 * --dry-run lists what a run would work on and its estimated cost. It calls no paid
 *   service and changes no item, and it is allowed whether or not the step is switched on.
 * A real run is refused unless SECOND_LOOK=on is set.
 * --limit lowers the number of paid lookups for this run (never above SECOND_LOOK_MAX_PER_RUN).
 * --batch sends the reading of the search notes through the Message Batches API
 *   (half price, slower); the search itself always runs live.
 * SECOND_LOOK_ARGS on the service adds flags for one run without changing the start command.
 */
import { main } from "../../src/lib/pipeline/job";
import { AnthropicLlm } from "../../src/lib/pipeline/llm";
import { AnthropicResearch } from "../../src/lib/pipeline/research";
import { runSecondLook } from "../../src/lib/pipeline/second-look";
import { pingIndexNow } from "../../src/lib/indexnow";
import { secondLook, translation } from "../../src/config";
import { translatePending } from "../../src/lib/pipeline/translate";

// Flags set on the service for a one-off run are read as if typed after the command.
process.argv.push(...(process.env.SECOND_LOOK_ARGS ?? "").split(/\s+/).filter(Boolean));

main("second-look", async (pool, report, args) => {
  if (!args.dryRun && !secondLook.enabled) {
    // Refused, not failed: being switched off is the owner's choice, so no failure alert is sent.
    report.refused = "The second look is switched off, so nothing was looked up. Set SECOND_LOOK=on to allow a real run, or add --dry-run to see what it would do (free).";
    return;
  }
  const llm = new AnthropicLlm();
  const result = await runSecondLook(
    pool,
    { llm, research: new AnthropicResearch() },
    { jobName: "second-look", dryRun: args.dryRun, batch: args.batch, city: args.city, maxPerRun: args.limit },
  );
  Object.assign(report, result);
  if (args.dryRun) return;

  // An event published here gets its Hindi now, so it is never translated on page load.
  if (translation.enabled && (result.published > 0 || result.mergedIntoListed > 0)) {
    try {
      report.translation = await translatePending(pool, llm, { jobName: "second-look", batch: false });
    } catch (err) {
      // A translation problem must not fail the job: Hindi pages fall back to English until the next run.
      report.translation = { error: (err as Error).message.slice(0, 300) };
    }
  }

  if (result.published > 0 || result.mergedIntoListed > 0) report.indexNow = await pingIndexNow(pool);
});
