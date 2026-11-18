/**
 * Budget guard (CLAUDE.md hard rule 1). Every paid call goes through
 * `guardedCall`. It:
 *   1. checks the month's spend for the bucket (and sub-budget, if any),
 *      and throws BudgetExceededError BEFORE the call if the cap is reached
 *      or this call's estimate would push spend over it;
 *   2. reserves the estimated cost in cost_log under an advisory lock, so two
 *      jobs running at once cannot both squeeze under the cap;
 *   3. runs the call, then replaces the estimate with the actual cost if the
 *      call reports one;
 *   4. logs a warning once spend reaches 80% of a cap.
 * A sub-budget listed in `dailyCaps` (features any visitor can trigger, such
 * as search) is also held to a cap per calendar day in UTC.
 * In dry-run mode the paid call is skipped and the would-be cost is logged
 * with dry_run = true (excluded from monthly totals).
 * Months are calendar months in UTC, matching how vendors bill.
 */
import { getPool } from "./db";
import { budgets, dailyCaps, subBudgetParent, type BudgetBucket, type SubBudget } from "../config";
import type { Pool } from "pg";

export class BudgetExceededError extends Error {
  constructor(
    public readonly budget: string,
    public readonly spentUsd: number,
    public readonly capUsd: number,
    public readonly estimateUsd: number,
  ) {
    super(
      `Budget "${budget}" blocked: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)} this month; ` +
        `this call would add ~$${estimateUsd.toFixed(4)}`,
    );
    this.name = "BudgetExceededError";
  }
}

export interface PaidCall {
  bucket: BudgetBucket;
  subBudget?: SubBudget;
  service: string; // "apify", "anthropic"
  model?: string; // model ID or actor ID
  units?: number;
  unitLabel?: string; // "results", "tokens"
  estimatedUsd: number;
  jobName: string;
  dryRun?: boolean;
}

/** What the wrapped call may return to correct the logged cost. */
export interface CallOutcome<T> {
  result: T;
  actualUsd?: number;
  units?: number;
}

export interface GuardOptions {
  pool?: Pool;
  caps?: Partial<Record<BudgetBucket | SubBudget, number>>;
  dailyCaps?: Partial<Record<SubBudget, number>>;
  warn?: (msg: string) => void;
  now?: Date;
}

function capFor(name: BudgetBucket | SubBudget, opts: GuardOptions): number {
  return opts.caps?.[name] ?? budgets[name];
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function dayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Total non-dry-run spend this month for a bucket, or for a sub-budget. */
export async function monthSpend(
  name: BudgetBucket | SubBudget,
  opts: GuardOptions = {},
): Promise<number> {
  return spendSince(name, monthStartUtc(opts.now ?? new Date()), opts);
}

/** Total non-dry-run spend today (UTC) for a bucket, or for a sub-budget. */
export async function daySpend(
  name: BudgetBucket | SubBudget,
  opts: GuardOptions = {},
): Promise<number> {
  return spendSince(name, dayStartUtc(opts.now ?? new Date()), opts);
}

async function spendSince(name: BudgetBucket | SubBudget, since: Date, opts: GuardOptions): Promise<number> {
  const pool = opts.pool ?? getPool();
  const isSub = name in subBudgetParent;
  const { rows } = await pool.query<{ total: string }>(
    `SELECT coalesce(sum(estimated_usd), 0) AS total FROM cost_log
     WHERE dry_run = false AND logged_at >= $1 AND ${isSub ? "sub_budget" : "bucket"} = $2`,
    [since, name],
  );
  return Number(rows[0].total);
}

/** Stable 32-bit key per bucket for pg_advisory_xact_lock. */
function lockKey(bucket: BudgetBucket): number {
  return bucket === "scrape" ? 71_001 : 71_002;
}

export async function guardedCall<T>(
  call: PaidCall,
  fn: () => Promise<T | CallOutcome<T>>,
  opts: GuardOptions = {},
): Promise<T | undefined> {
  if (!(call.estimatedUsd >= 0)) throw new Error("estimatedUsd must be a non-negative number");
  if (call.subBudget && subBudgetParent[call.subBudget] !== call.bucket) {
    throw new Error(`Sub-budget ${call.subBudget} does not belong to bucket ${call.bucket}`);
  }
  const pool = opts.pool ?? getPool();
  const warn = opts.warn ?? ((m: string) => console.warn(`[budget] ${m}`));
  const now = opts.now ?? new Date();

  if (call.dryRun) {
    await pool.query(
      `INSERT INTO cost_log (logged_at, bucket, sub_budget, service, model, units, unit_label, estimated_usd, job_name, dry_run)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
      [now, call.bucket, call.subBudget ?? null, call.service, call.model ?? null, call.units ?? 0,
        call.unitLabel ?? null, call.estimatedUsd, call.jobName],
    );
    return undefined;
  }

  // Check caps and reserve the estimate atomically.
  const client = await pool.connect();
  let costLogId: number;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey(call.bucket)]);
    const checks: (BudgetBucket | SubBudget)[] = [call.bucket];
    if (call.subBudget) checks.push(call.subBudget);
    for (const name of checks) {
      const spent = await monthSpend(name, { ...opts, pool: client as unknown as Pool, now });
      const cap = capFor(name, opts);
      if (spent >= cap || spent + call.estimatedUsd > cap) {
        throw new BudgetExceededError(name, spent, cap, call.estimatedUsd);
      }
    }
    const dailyCap = call.subBudget ? (opts.dailyCaps ?? dailyCaps)[call.subBudget] : undefined;
    if (call.subBudget && dailyCap !== undefined) {
      const spent = await daySpend(call.subBudget, { ...opts, pool: client as unknown as Pool, now });
      if (spent >= dailyCap || spent + call.estimatedUsd > dailyCap) {
        throw new BudgetExceededError(`${call.subBudget} (daily)`, spent, dailyCap, call.estimatedUsd);
      }
    }
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO cost_log (logged_at, bucket, sub_budget, service, model, units, unit_label, estimated_usd, job_name, dry_run)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false) RETURNING id`,
      [now, call.bucket, call.subBudget ?? null, call.service, call.model ?? null, call.units ?? 0,
        call.unitLabel ?? null, call.estimatedUsd, call.jobName],
    );
    costLogId = rows[0].id;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Run the paid call. On failure the reservation stays logged: vendors often
  // charge for failed runs, and over-counting is the safe direction.
  const raw = await fn();
  const outcome: CallOutcome<T> =
    raw !== null && typeof raw === "object" && "result" in (raw as object)
      ? (raw as CallOutcome<T>)
      : { result: raw as T };
  if (outcome.actualUsd !== undefined || outcome.units !== undefined) {
    await pool.query(
      `UPDATE cost_log SET estimated_usd = coalesce($2, estimated_usd), units = coalesce($3, units) WHERE id = $1`,
      [costLogId, outcome.actualUsd ?? null, outcome.units ?? null],
    );
  }

  // 80% warnings.
  const names: (BudgetBucket | SubBudget)[] = [call.bucket];
  if (call.subBudget) names.push(call.subBudget);
  for (const name of names) {
    const spent = await monthSpend(name, { ...opts, pool, now });
    const cap = capFor(name, opts);
    if (cap > 0 && spent >= cap * budgets.warnAt) {
      warn(`"${name}" at ${Math.round((spent / cap) * 100)}% of monthly cap ($${spent.toFixed(2)} / $${cap.toFixed(2)})`);
    }
  }

  return outcome.result;
}
