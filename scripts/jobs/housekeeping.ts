/**
 * Housekeeping job (run daily by a Railway cron service). No paid calls.
 * Usage: npm run job:housekeeping -- [--dry-run]
 */
import { main } from "../../src/lib/pipeline/job";
import { housekeeping } from "../../src/lib/pipeline/housekeeping";

main("housekeeping", async (pool, report, args) => {
  Object.assign(report, await housekeeping(pool, { dryRun: args.dryRun }));
});
