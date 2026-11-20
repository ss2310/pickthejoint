/**
 * Shared wrapper for scheduled jobs: parses flags, records the run in
 * job_runs (with its report) and prints the report.
 */
import type { Pool } from "pg";
import { sendAlert } from "../alerts";
import { closePool, getPool } from "../db";
import { BudgetExceededError, ParkedError, guardedCall, monthSpend } from "../budget-guard";
import { budgets, parked, subBudgetParent, type BudgetBucket, type SubBudget } from "../../config";

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
  /** Which sources to run: instagram, google, news, web, facebook (native events), facebook-posts, discovery, artists. */
  sources: string[];
  /** Skip fetching; only process posts already stored. */
  processOnly: boolean;
  /** Housekeeping: run the crawl access check now instead of waiting for Monday. */
  crawlCheck: boolean;
  /** Enrichment: which kinds of entity to work on (venue, artist, organiser). */
  types?: string[];
  /** Enrichment: these slugs only, even if already enriched. */
  slugs?: string[];
  /** Fail on purpose, to prove the failure alert arrives. */
  failOnPurpose: boolean;
  /** Wider sourcing checks: read at most this many new items (pages, events, posts) per source. */
  maxItems?: number;
  /** Housekeeping: re-tier handles now instead of waiting for the first of the month. */
  retier: boolean;
  /** Housekeeping: store last week's coverage report now instead of waiting for Monday. */
  coverage: boolean;
  /** Ingest: draft this week's roundup now instead of waiting for Thursday (with --force, draft it again). */
  roundup: boolean;
}

export const ALL_SOURCES = ["instagram", "google", "news", "web", "facebook", "facebook-posts", "discovery", "artists"];

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
    sources: list("sources") ?? ALL_SOURCES,
    processOnly: argv.includes("--process-only"),
    crawlCheck: argv.includes("--crawl-check"),
    types: list("types"),
    slugs: list("slugs"),
    failOnPurpose: argv.includes("--fail-on-purpose") || process.env.FAIL_ON_PURPOSE === jobNameFromArgv(),
    maxItems: value("max-items") ? Number(value("max-items")) : undefined,
    retier: argv.includes("--retier"),
    coverage: argv.includes("--coverage"),
    roundup: argv.includes("--roundup"),
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

/**
 * What a job does while PARKED=true: nothing, except prove the budget guard
 * still refuses a paid call. The probe's call body must never run; the guard
 * throws before it touches the database or any vendor.
 */
export async function parkedRun(jobName: string): Promise<Report> {
  const report: Report = { job: jobName, parked: true, skipped: "PARKED=true: scheduled jobs do nothing while the project is parked (see PARKED.md)" };
  try {
    await guardedCall(
      { bucket: "model", service: "anthropic", model: "parked-probe", estimatedUsd: 0.0001, jobName: `${jobName}:parked-probe` },
      async () => { throw new Error("The parked probe's paid call ran: the budget guard did not block it"); },
    );
    report.budgetGuard = "NOT BLOCKED: the probe call was allowed";
  } catch (err) {
    report.budgetGuard = err instanceof ParkedError ? `blocked: ${err.message}` : `NOT BLOCKED: ${(err as Error).message}`;
  }
  return report;
}

/** Entry point for scripts/jobs/*: run, print the report, exit non-zero on failure. */
export function main(jobName: string, body: (pool: Pool, report: Report, args: JobArgs) => Promise<void>): void {
  const args = parseArgs(process.argv.slice(2));
  if (parked.on) {
    // No job_runs row, no alert, no database work: parking must be cheap and quiet.
    void parkedRun(jobName).then((report) => {
      console.log(JSON.stringify(report, null, 2));
      process.exit(String(report.budgetGuard).startsWith("blocked") ? 0 : 1);
    });
    return;
  }
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
