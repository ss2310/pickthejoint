/**
 * Enrichment job (run weekly by a Railway cron service): fills in venue,
 * artist and organiser pages from public sources. See src/lib/pipeline/enrich.ts.
 *
 * Usage: npm run job:enrich -- [--dry-run] [--types venue,artist,organiser]
 *          [--limit 5] [--slugs a,b]
 * --dry-run lists what the run would work on and its estimated cost, and calls no paid service.
 * --limit is per type. --slugs re-runs named entities even if they were enriched before.
 * ENRICH_ARGS on the service adds flags for one run without changing the start command.
 *
 * Model calls here are not batched: research is a multi-step tool conversation
 * and each entity's later steps wait on its own research.
 */
import { main } from "../../src/lib/pipeline/job";
import { HttpApifyClient } from "../../src/lib/pipeline/apify";
import { AnthropicLlm } from "../../src/lib/pipeline/llm";
import { AnthropicResearch } from "../../src/lib/pipeline/research";
import { ENTITY_TYPES, enrichEntities, type EntityType } from "../../src/lib/pipeline/enrich";
import { pingIndexNow } from "../../src/lib/indexnow";
import { translation } from "../../src/config";
import { translatePending } from "../../src/lib/pipeline/translate";

// Flags set on the service for a one-off run are read as if typed after the command.
process.argv.push(...(process.env.ENRICH_ARGS ?? "").split(/\s+/).filter(Boolean));

main("enrich", async (pool, report, args) => {
  const types = args.types?.filter((t): t is EntityType => (ENTITY_TYPES as string[]).includes(t));
  if (args.types?.length && types?.length !== args.types.length) {
    throw new Error(`--types takes ${ENTITY_TYPES.join(", ")}; got "${args.types.join(",")}"`);
  }
  const llm = new AnthropicLlm();
  const result = await enrichEntities(
    pool,
    { llm, research: new AnthropicResearch(), apify: new HttpApifyClient() },
    { jobName: "enrich", dryRun: args.dryRun, types, limit: args.limit, slugs: args.slugs },
  );
  Object.assign(report, result);
  if (args.dryRun) return;

  // New or changed text gets its Hindi now, so it is never translated on page load.
  if (translation.enabled) {
    try {
      report.translation = await translatePending(pool, llm, { jobName: "enrich", batch: false });
    } catch (err) {
      // A translation problem must not fail the job: Hindi pages fall back to English until the next run.
      report.translation = { error: (err as Error).message.slice(0, 300) };
    }
  }

  report.indexNow = await pingIndexNow(pool);
});
