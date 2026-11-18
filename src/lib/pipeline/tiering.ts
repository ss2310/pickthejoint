/**
 * Monthly re-tiering of Instagram handles (Prompt 9). Housekeeping runs it on
 * the first day of each month (IST), or on demand with --retier.
 *   - Tier A (checked daily) goes to handles that produced at least
 *     `tierAMinEvents` real events in the last 30 days, best first, up to the
 *     per-city tier A cap; the rest are tier B (weekly).
 *   - A handle that has produced no event in 90 days is paused.
 * A handle younger than 30 days is left alone (too little to judge), and so is
 * a handle whose tier the admin set by hand in the last `manualHoldDays`. Every change is
 * logged in handle_changes and shown in the admin area.
 */
import type { Pool } from "pg";
import { ingestion, sourcing } from "../../config";

export interface RetierReport {
  considered: number;
  promoted: string[];
  demoted: string[];
  paused: string[];
  heldManual: number;
  tooNew: number;
}

interface Row {
  id: number; handle: string; city_id: number; tier: "A" | "B"; created_at: Date;
  tier_set_by: string; tier_set_at: Date | null; events30: number; events90: number;
}

export async function retierHandles(pool: Pool, opts: { dryRun?: boolean; now?: Date } = {}): Promise<RetierReport> {
  const now = opts.now ?? new Date();
  const cfg = sourcing.tiering;
  const report: RetierReport = { considered: 0, promoted: [], demoted: [], paused: [], heldManual: 0, tooNew: 0 };
  const { rows } = await pool.query<Row>(
    `SELECT h.id, h.handle, h.city_id, h.tier, h.created_at, h.tier_set_by, h.tier_set_at,
            count(DISTINCT s.event_id) FILTER (WHERE s.observed_at >= $1::timestamptz - interval '30 days')::int AS events30,
            count(DISTINCT s.event_id) FILTER (WHERE s.observed_at >= $1::timestamptz - make_interval(days => $2))::int AS events90
     FROM handles h
     LEFT JOIN raw_posts rp ON rp.handle = h.handle AND rp.source_kind = 'instagram'
     LEFT JOIN sources s ON s.raw_post_id = rp.id
     LEFT JOIN events e ON e.id = s.event_id AND e.status <> 'cancelled'
     WHERE h.active AND (s.id IS NULL OR e.id IS NOT NULL)
     GROUP BY h.id ORDER BY h.city_id, events30 DESC, h.id`,
    [now, cfg.pauseAfterDays]);

  const ageDays = (d: Date) => (now.getTime() - d.getTime()) / 86_400_000;
  const tierACount = new Map<number, number>();
  const changes: { row: Row; tier: "A" | "B"; active: boolean; reason: string }[] = [];
  for (const r of rows) {
    if (ageDays(r.created_at) < 30) { report.tooNew++; continue; }
    report.considered++;
    if (r.tier_set_by === "manual" && r.tier_set_at && ageDays(r.tier_set_at) < cfg.manualHoldDays) {
      report.heldManual++;
      if (r.tier === "A") tierACount.set(r.city_id, (tierACount.get(r.city_id) ?? 0) + 1);
      continue;
    }
    if (ageDays(r.created_at) >= cfg.pauseAfterDays && r.events90 === 0) {
      changes.push({ row: r, tier: r.tier, active: false, reason: `no event in ${cfg.pauseAfterDays} days` });
      continue;
    }
    let tier: "A" | "B" = r.events30 >= cfg.tierAMinEvents ? "A" : "B";
    if (tier === "A") {
      const n = (tierACount.get(r.city_id) ?? 0) + 1;
      if (n > ingestion.tierAMaxPerCity) tier = "B";
      else tierACount.set(r.city_id, n);
    }
    if (tier !== r.tier) changes.push({ row: r, tier, active: true, reason: `${r.events30} event(s) in the last 30 days` });
  }

  for (const c of changes) {
    if (!c.active) report.paused.push(c.row.handle);
    else if (c.tier === "A") report.promoted.push(c.row.handle);
    else report.demoted.push(c.row.handle);
    if (opts.dryRun) continue;
    await pool.query(
      `UPDATE handles SET tier = $2, active = $3, paused_reason = $4, tier_set_by = 'auto', tier_set_at = $5, updated_at = now() WHERE id = $1`,
      [c.row.id, c.tier, c.active, c.active ? null : c.reason, now]);
    await pool.query(
      `INSERT INTO handle_changes (handle_id, changed_at, from_tier, to_tier, from_active, to_active, reason) VALUES ($1,$2,$3,$4,true,$5,$6)`,
      [c.row.id, now, c.row.tier, c.tier, c.active, c.reason]);
  }
  return report;
}

/** Tier to offer for a suggested handle: A when event posts keep crediting it. */
export function suggestedTier(eventPosts: number): "A" | "B" {
  return eventPosts >= sourcing.tiering.suggestTierAMinEventPosts ? "A" : "B";
}
