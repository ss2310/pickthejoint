/**
 * Shared wrapper for scheduled jobs: parses flags, records the run in
 * job_runs (with its report) and prints the report.
 */
import type { Pool } from "pg";
import { sendAlert } from "../alerts";
import { closePool, getPool } from "../db";
import { BudgetExceededError, monthSpend } from "../budget-guard";
import { budgets, subBudgetParent, type BudgetBucket, type SubBudget } from "../../config";

export interface JobArgs {
  dryRun: boolean;
  /** Use the Message Batches API for model calls (scheduled runs). */
  batch: boolean;
  city?: string;
  /** Restrict the scrape to these handles. */
  handles?: string[];
  /** With --handles: ignore the daily / weekly schedule. */
  force: boolean;
  /** Cap on handles checked in this run. */
  limit?: number;
  /** Which sources to run: instagram, google, news. */
  sources: string[];
  /** Skip fetching; only process posts already stored. */
  processOnly: boolean;
  /** Housekeeping: run the crawl access check now instead of waiting for Monday. */
  crawlCheck: boolean;
  /** Fail on purpose, to prove the failure alert arrives. */
  failOnPurpose: boolean;
}

export function parseArgs(argv: string[]): JobArgs {
  const value = (name: string) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  const list = (name: string) => value(name)?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const limit = value("limit");
  return {
    dryRun: argv.includes("--dry-run"),
    batch: argv.includes("--batch"),
    city: value("city")?.toLowerCase(),
    handles: list("handles")?.map((h) => h.replace(/^@/, "")),
    force: argv.includes("--force"),
    limit: limit ? Number(limit) : undefined,
    sources: list("sources") ?? ["instagram", "google", "news"],
    processOnly: argv.includes("--process-only"),
    crawlCheck: argv.includes("--crawl-check"),
    failOnPurpose: argv.includes("--fail-on-purpose") || process.env.FAIL_ON_PURPOSE === jobNameFromArgv(),
  };
}

/** FAIL_ON_PURPOSE=<job name> on a service makes that job's next run fail, without changing its start command. */
function jobNameFromArgv(): string {
  return (process.argv[1] ?? "").replace(/\\/g, "/").split("/").pop()?.replace(/\.ts$/, "") ?? "";
}

export type Report = Record<string, unknown>;

/** Month-to-date spend against each cap, for run reports. */
export async function spendSummary(pool: Pool): Promise<Record<string, { spentUsd: number; capUsd: number }>> {
  const names: (BudgetBucket | SubBudget)[] = ["scrape", "model", ...(Object.keys(subBudgetParent) as SubBudget[])];
  const out: Record<string, { spentUsd: number; capUsd: number }> = {};
  for (const n of names) {
    out[n] = { spentUsd: Number((await monthSpend(n, { pool })).toFixed(4)), capUsd: budgets[n] };
  }
  return out;
}

/**
 * Runs a job body, storing its report in job_runs. A budget stop is recorded
 * as a completed run with `stoppedByBudget` set: refusing to spend is the
 * guard working, not a failure.
 */
export async function runJob(
  jobName: string,
  dryRun: boolean,
  body: (pool: Pool, report: Report) => Promise<void>,
  pool: Pool = getPool(),
): Promise<Report> {
  const { rows } = await pool.query<{ id: number }>(
    "INSERT INTO job_runs (job_name, dry_run) VALUES ($1, $2) RETURNING id",
    [jobName, dryRun],
  );
  const id = rows[0].id;
  const report: Report = { job: jobName, dryRun };
  try {
    try {
      await body(pool, report);
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      report.stoppedByBudget = err.message;
    }
    report.monthSpend = await spendSummary(pool);
    await pool.query("UPDATE job_runs SET finished_at = now(), status = 'ok', report = $2 WHERE id = $1", [id, report]);
    return report;
  } catch (err) {
    report.monthSpend = await spendSummary(pool).catch(() => undefined);
    await pool.query(
      "UPDATE job_runs SET finished_at = now(), status = 'failed', report = $2, error = $3 WHERE id = $1",
      [id, report, (err as Error).stack ?? String(err)],
    );
    throw err;
  }
}

/** Entry point for scripts/jobs/*: run, print the report, exit non-zero on failure. */
export function main(jobName: string, body: (pool: Pool, report: Report, args: JobArgs) => Promise<void>): void {
  const args = parseArgs(process.argv.slice(2));
  runJob(jobName, args.dryRun, (pool, report) => {
    if (args.failOnPurpose) throw new Error("Failed on purpose to test the job alert (FAIL_ON_PURPOSE or --fail-on-purpose).");
    return body(pool, report, args);
  })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      return closePool();
    })
    .catch(async (err) => {
      console.error(err);
      if (!args.dryRun) {
        await sendAlert(`The ${jobName} job failed`, `The scheduled ${jobName} job stopped with an error and did not finish.\n\n${(err as Error).stack ?? String(err)}`);
      }
      await closePool().catch(() => {});
      process.exit(1);
    });
}
