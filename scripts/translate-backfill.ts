/**
 * Translates all public text that has no Hindi yet, or whose English has
 * changed since it was translated. Safe to run again: text that is already
 * translated and unchanged is skipped.
 *
 * Usage: npm run translate:backfill -- [--dry-run] [--batch] [--limit 200]
 * --dry-run reports how much text is waiting and what translating it would cost; nothing is sent.
 * --batch uses the Message Batches API (half price, slower).
 */
import { main } from "../src/lib/pipeline/job";
import { AnthropicLlm } from "../src/lib/pipeline/llm";
import { translatePending } from "../src/lib/pipeline/translate";

main("translate", async (pool, report, args) => {
  Object.assign(report, await translatePending(pool, new AnthropicLlm(), { jobName: "translate", dryRun: args.dryRun, batch: args.batch, limit: args.limit }));
});
