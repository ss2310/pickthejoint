/**
 * Practical facts for events listed before Prompt 11: reads each upcoming event's source post again and
 * stores only the practical facts it states. Paid (about a cent or two per post); run by hand.
 * Usage: npm run job:facts-backfill -- [--dry-run] [--limit 20] [--batch]
 */
import { main } from "../../src/lib/pipeline/job";
import { AnthropicLlm } from "../../src/lib/pipeline/llm";
import { backfillFacts } from "../../src/lib/pipeline/facts-backfill";
import { pingIndexNow } from "../../src/lib/indexnow";

main("facts-backfill", async (pool, report, args) => {
  report.facts = await backfillFacts(pool, new AnthropicLlm(), { jobName: "facts-backfill", dryRun: args.dryRun, batch: args.batch, limit: args.limit });
  if (!args.dryRun) report.indexNow = await pingIndexNow(pool);
});
