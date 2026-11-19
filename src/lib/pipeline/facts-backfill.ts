/**
 * Practical facts for events listed before Prompt 11 (run by hand, not on a schedule).
 * Reads each upcoming published event's source post again with the extraction
 * that now asks for practical facts, and stores only those facts: nothing else
 * about the event is changed. One mid-tier call per post, with its poster image.
 */
import type { Pool } from "pg";
import { storeFacts } from "../practical";
import { fetchImages, extractionRequest } from "./extract";
import { estimateUsd, type LlmClient } from "./llm";
import { RAW_SELECT, cityLists, toInput, type RawRow } from "./process";
import { titleSimilarity } from "./text";

export interface BackfillReport {
  posts: number;
  estimatedUsd: number;
  usd: number;
  eventsWithNewFacts: number;
  factsStored: number;
  examples: { event: string; facts: string[] }[];
  /** Calls that failed, and the first few reasons. */
  failed: number;
  errors: string[];
}

export async function backfillFacts(
  pool: Pool, llm: LlmClient, opts: { jobName: string; dryRun?: boolean; batch?: boolean; limit?: number; fetchFn?: typeof fetch },
): Promise<BackfillReport> {
  // One post per upcoming published event that has no practical facts yet: its first scraped source.
  const { rows: targets } = await pool.query<{ event_id: number; title: string; raw_post_id: number }>(
    `SELECT DISTINCT ON (e.id) e.id AS event_id, e.title, s.raw_post_id
     FROM events e JOIN sources s ON s.event_id = e.id AND s.raw_post_id IS NOT NULL
     WHERE e.is_published AND e.status = 'scheduled' AND e.starts_at > now()
       AND NOT EXISTS (SELECT 1 FROM practical_facts pf WHERE pf.entity_type = 'event' AND pf.entity_id = e.id)
     ORDER BY e.id, s.id LIMIT $1`, [opts.limit ?? 20]);
  const report: BackfillReport = { posts: 0, estimatedUsd: 0, usd: 0, eventsWithNewFacts: 0, factsStored: 0, examples: [], failed: 0, errors: [] };
  if (targets.length === 0) return report;
  const rows = (await pool.query<RawRow>(`${RAW_SELECT} WHERE rp.id = ANY($1::bigint[])`, [targets.map((t) => t.raw_post_id)])).rows;
  const lists = await cityLists(pool);
  const byPost = new Map(rows.map((r) => [Number(r.id), r]));
  const requests = [];
  for (const t of targets) {
    const row = byPost.get(Number(t.raw_post_id));
    if (!row) continue;
    const images = opts.dryRun ? [] : await fetchImages(row.media_urls ?? [], opts.fetchFn);
    requests.push(extractionRequest({ ...toInput(row, lists, images), id: `${t.event_id}:${row.id}` }));
  }
  report.posts = requests.length;
  // The estimate counts each post's image, as the real run sends it.
  report.estimatedUsd = Number(requests.reduce((s, r) => s + estimateUsd({ ...r, estInputTokens: r.estInputTokens + 2200 }, opts.batch), 0).toFixed(4));
  if (opts.dryRun) return report;

  const results = await llm.run(requests, { jobName: opts.jobName, batch: opts.batch, pool });
  for (const r of results) {
    report.usd += r.usd;
    const [eventId, postId] = r.id.split(":").map(Number);
    if (r.usd > 0) await pool.query("UPDATE raw_posts SET model_usd = model_usd + $2 WHERE id = $1", [postId, r.usd]);
    if (!r.ok || !r.data) {
      report.failed++;
      if (r.error && report.errors.length < 5 && !report.errors.includes(r.error)) report.errors.push(r.error);
      continue;
    }
    const target = targets.find((t) => Number(t.event_id) === eventId)!;
    // A line-up post lists several events: the facts are taken from the one that is this event.
    const events = r.data.events.filter((e) => e.announcement === "new_event");
    const match = events.length === 1 ? events[0]
      : events.map((e) => ({ e, s: titleSimilarity(e.title.value ?? "", target.title) })).sort((a, b) => b.s - a.s).find((x) => x.s >= 0.5)?.e;
    if (!match) continue;
    const row = byPost.get(postId)!;
    const stored = await storeFacts(pool, eventId, match.practical, { type: "post", url: row.post_url, rawPostId: postId });
    if (stored.stored) {
      report.eventsWithNewFacts++;
      report.factsStored += stored.stored;
      if (report.examples.length < 10) report.examples.push({ event: target.title, facts: (match.practical ?? []).map((p) => `${p.key}: ${p.answer}`) });
    }
  }
  report.usd = Number(report.usd.toFixed(4));
  return report;
}
