/**
 * Citation tracker (Prompt 8): does an AI assistant cite pickthejoint.com when
 * someone asks what is on in a city?
 *
 * A fixed set of questions per city and language (data/citation-queries.json,
 * approved by the owner) is asked every week. The automated engines are asked
 * through the owner's GeoGrid tool on the owner's own computer
 * (scripts/citations/geogrid_run.py); its results file is imported here, which
 * judges each answer from the sources it cited, logs the run's cost against the
 * `citations` budget and stores one row per question, engine and week. Engines
 * with no automated route are entered by hand, with a screenshot link.
 *
 * Weeks are IST weeks starting Monday. A check the engine did not answer
 * (Google showed no AI Overview, or the request failed) is kept but left out of
 * the share, so "cited in 3 of 28" never counts a non-answer as a miss.
 */
import type { Pool } from "pg";
import { z } from "zod";
import { budgets, citations as cfg, displayTimeZone } from "../config";
import { monthSpend } from "./budget-guard";
import { getPool } from "./db";
import { addDays, isoDay, weekdayOf } from "./format";

export type EngineKey = (typeof cfg.engines)[number]["key"];
export const ENGINE_KEYS = cfg.engines.map((e) => e.key) as EngineKey[];
export const engineLabel = (key: string) => cfg.engines.find((e) => e.key === key)?.label ?? key;

/** Monday of the IST week a moment falls in, "YYYY-MM-DD". */
export function weekStart(at: Date): string {
  const day = isoDay(at, displayTimeZone);
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

/** Monday of the week a "YYYY-MM-DD" date falls in. */
export function weekOfDay(day: string): string {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

/** A URL's host without "www.", lower case; "" when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const isOrUnder = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export interface Judgement {
  cited: boolean;
  mentioned: boolean;
  ourUrls: string[];
  competitors: string[];
  hosts: string[];
}

/** Reads one answer: our pages among its sources, our name in its text, and which listing sites it cited. */
export function judge(text: string, urls: string[]): Judgement {
  const clean = [...new Set(urls.map((u) => u.trim()).filter((u) => hostOf(u)))];
  const hosts = [...new Set(clean.map(hostOf))];
  const ourUrls = clean.filter((u) => isOrUnder(hostOf(u), cfg.ourDomain));
  // A link to us written into the answer counts as a citation too (some engines inline their sources).
  const inline = (text.match(/https?:\/\/[^\s)\]>"']+/g) ?? []).filter((u) => isOrUnder(hostOf(u), cfg.ourDomain));
  for (const u of inline) if (!ourUrls.includes(u)) ourUrls.push(u);
  // The domain written out as a word, not part of a longer name ("notpickthejoint.com", "pickthejoint.com.evil.example").
  const bareDomain = new RegExp(`(^|[^a-z0-9.-])${cfg.ourDomain.replace(/\./g, "\\.")}(?![a-z0-9-]|\\.[a-z0-9])`, "i").test(text);
  return {
    cited: ourUrls.length > 0 || bareDomain,
    mentioned: cfg.namePatterns.some((p) => p.test(text)),
    ourUrls,
    competitors: cfg.competitors.filter((d) => hosts.some((h) => isOrUnder(h, d))),
    hosts,
  };
}

// ---------------------------------------------------------------- automated runs

const CellSchema = z.object({
  locale: z.enum(["en", "hi"]),
  query: z.string().min(1),
  engine: z.string().min(1),
  model: z.string().nullish(),
  answered: z.boolean(),
  error: z.string().nullish(),
  text: z.string().nullish(),
  citations: z.array(z.string()).default([]),
  cost_usd: z.number().min(0).default(0),
  cached: z.boolean().nullish(),
  asked_at: z.string().nullish(),
});
export const RunFileSchema = z.object({
  format: z.literal("ptj-citations/1"),
  run_id: z.string().regex(/^[A-Za-z0-9._-]{4,120}$/),
  tool: z.string(),
  city: z.string(),
  asked_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "asked_at must be a date"),
  engines: z.record(z.string(), z.string()).default({}),
  cost_usd: z.number().min(0),
  stopped: z.string().nullish(),
  cells: z.array(CellSchema).min(1),
});
export type RunFile = z.infer<typeof RunFileSchema>;

export interface ImportReport {
  runId: string;
  weekStart: string;
  imported: number;
  answered: number;
  cited: number;
  mentioned: number;
  costUsd: number;
  /** Cells that matched no active question or engine. */
  skipped: string[];
  /** Set when the month's citations spend is now over its cap. */
  overBudget?: string;
}

export class ImportError extends Error {}

/** The engine key for a GeoGrid label or one of our own keys. */
function engineKey(engine: string): EngineKey | null {
  const k = cfg.geogridLabels[engine] ?? engine.toLowerCase();
  return (ENGINE_KEYS as string[]).includes(k) ? (k as EngineKey) : null;
}

/** Which account a model ID was paid through, for the cost log. */
const serviceOf = (model: string | null | undefined) =>
  model && /^(dataforseo:|google-search:)/.test(model) ? "dataforseo" : model ? "openrouter" : "geogrid";

/** Imports one results file. Each run is imported once; a later run in the same week replaces that week's rows. */
export async function importRun(raw: unknown, pool: Pool = getPool()): Promise<ImportReport> {
  const parsed = RunFileSchema.safeParse(raw);
  if (!parsed.success) throw new ImportError(`Not a citation results file: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const run = parsed.data;
  const city = (await pool.query<{ id: number }>("SELECT id FROM cities WHERE slug = $1", [run.city])).rows[0];
  if (!city) throw new ImportError(`Unknown city "${run.city}"`);
  const askedAt = new Date(run.asked_at);
  const week = weekStart(askedAt);
  const queries = (await pool.query<{ id: number; locale: string; query: string }>(
    "SELECT id, locale, query FROM citation_queries WHERE city_id = $1 AND active", [city.id])).rows;
  const queryId = new Map(queries.map((q) => [`${q.locale}\u0000${q.query.normalize("NFC")}`, q.id]));

  const client = await pool.connect();
  const report: ImportReport = { runId: run.run_id, weekStart: week, imported: 0, answered: 0, cited: 0, mentioned: 0, costUsd: 0, skipped: [] };
  try {
    await client.query("BEGIN");
    const seen = await client.query("INSERT INTO citation_runs (run_id, tool, week_start, asked_at, checks, answered, cost_usd, engines) VALUES ($1,$2,$3,$4,0,0,0,$5) ON CONFLICT DO NOTHING RETURNING run_id",
      [run.run_id, run.tool, week, askedAt, run.engines]);
    if (seen.rowCount === 0) throw new ImportError(`Run ${run.run_id} has already been imported`);

    const costByModel = new Map<string, { usd: number; answers: number }>();
    for (const c of run.cells) {
      const qid = queryId.get(`${c.locale}\u0000${c.query.normalize("NFC")}`);
      const engine = engineKey(c.engine);
      if (!qid || !engine) { report.skipped.push(`${c.engine}: ${c.query}`); continue; }
      const text = c.text ?? "";
      const j = judge(text, c.citations);
      const answered = c.answered && !c.error;
      await client.query(
        `INSERT INTO citation_results (query_id, engine, week_start, cited, mentioned_by_name, competitors_cited, method, recorded_at,
           answered, cited_urls, our_urls, answer_excerpt, model, cost_usd, asked_at, run_id, note, screenshot_url)
         VALUES ($1,$2,$3,$4,$5,$6,'automated',now(),$7,$8,$9,$10,$11,$12,$13,$14,$15,NULL)
         ON CONFLICT (query_id, engine, week_start) DO UPDATE SET cited = EXCLUDED.cited, mentioned_by_name = EXCLUDED.mentioned_by_name,
           competitors_cited = EXCLUDED.competitors_cited, method = 'automated', recorded_at = now(), answered = EXCLUDED.answered,
           cited_urls = EXCLUDED.cited_urls, our_urls = EXCLUDED.our_urls, answer_excerpt = EXCLUDED.answer_excerpt, model = EXCLUDED.model,
           cost_usd = EXCLUDED.cost_usd, asked_at = EXCLUDED.asked_at, run_id = EXCLUDED.run_id, note = EXCLUDED.note, screenshot_url = NULL`,
        [qid, engine, week, answered && j.cited, answered && j.mentioned, JSON.stringify(answered ? j.competitors : []), answered,
          JSON.stringify(c.citations), JSON.stringify(j.ourUrls), text.slice(0, cfg.excerptChars) || null, c.model ?? null, c.cost_usd,
          c.asked_at ? new Date(c.asked_at) : askedAt, run.run_id, c.error ? c.error.slice(0, 300) : null]);
      report.imported++;
      if (answered) report.answered++;
      if (answered && j.cited) report.cited++;
      if (answered && j.mentioned) report.mentioned++;
      const key = c.model ?? c.engine;
      const agg = costByModel.get(key) ?? { usd: 0, answers: 0 };
      agg.usd += c.cost_usd;
      agg.answers += answered ? 1 : 0;
      costByModel.set(key, agg);
    }
    if (report.imported === 0) throw new ImportError("No cell matched an active question and engine; nothing imported");

    // The run's spend, by the account it was paid through (hard rule 1). The money is already spent, so it is
    // recorded whatever the cap; the admin page shows what is left before the next run.
    for (const [model, agg] of costByModel) {
      if (agg.usd <= 0) continue;
      await client.query(
        `INSERT INTO cost_log (bucket, sub_budget, service, model, units, unit_label, estimated_usd, job_name, dry_run)
         VALUES ('scrape', 'citations', $1, $2, $3, 'answers', $4, 'citations', false)`,
        [serviceOf(model), model, agg.answers, agg.usd]);
      report.costUsd += agg.usd;
    }
    report.costUsd = Number(report.costUsd.toFixed(6));
    await client.query("UPDATE citation_runs SET checks = $2, answered = $3, cost_usd = $4, report = $5 WHERE run_id = $1",
      [run.run_id, report.imported, report.answered, report.costUsd, { ...report, stopped: run.stopped ?? null }]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await snapshotWeek(pool);
  const spent = await monthSpend("citations", { pool });
  if (spent > budgets.citations) report.overBudget = `$${spent.toFixed(2)} spent of the $${budgets.citations.toFixed(2)} monthly citations budget`;
  return report;
}

// ---------------------------------------------------------------- manual entry

export interface ManualResult {
  queryId: number;
  engine: string;
  weekStart: string;
  answered: boolean;
  cited: boolean;
  mentioned: boolean;
  competitors: string;
  screenshotUrl: string;
  note: string;
}

/** Records one check done by hand. Competitors may be typed as domains or URLs, comma-separated. */
export async function saveManualResult(m: ManualResult, pool: Pool = getPool()): Promise<void> {
  if (!engineKey(m.engine)) throw new ImportError(`Unknown engine "${m.engine}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.weekStart)) throw new ImportError("Week must be a date");
  const shot = m.screenshotUrl.trim();
  if (shot && !/^https:\/\//.test(shot)) throw new ImportError("The screenshot link must start with https://");
  const competitors = [...new Set(m.competitors.split(/[\s,]+/).map((s) => hostOf(s.includes("://") ? s : `https://${s}`)).filter(Boolean))];
  await pool.query(
    `INSERT INTO citation_results (query_id, engine, week_start, cited, mentioned_by_name, competitors_cited, screenshot_url, method, answered, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9)
     ON CONFLICT (query_id, engine, week_start) DO UPDATE SET cited = EXCLUDED.cited, mentioned_by_name = EXCLUDED.mentioned_by_name,
       competitors_cited = EXCLUDED.competitors_cited, screenshot_url = EXCLUDED.screenshot_url, method = 'manual', answered = EXCLUDED.answered,
       note = EXCLUDED.note, recorded_at = now(), cited_urls = '[]', our_urls = '[]', answer_excerpt = NULL, model = NULL, cost_usd = 0, run_id = NULL`,
    [m.queryId, engineKey(m.engine), weekOfDay(m.weekStart), m.answered && m.cited, m.answered && m.mentioned, JSON.stringify(competitors),
      shot || null, m.answered, m.note.trim().slice(0, 500) || null]);
}

// ---------------------------------------------------------------- first-party sources

export type FirstPartySource = "bing_ai" | "search_console";
export interface FirstPartyNumbers { citations?: number | null; cited_pages?: number | null; impressions?: number | null; clicks?: number | null; avg_position?: number | null }
const FP_FIELDS = ["citations", "cited_pages", "impressions", "clicks", "avg_position"] as const;

export async function saveFirstParty(source: FirstPartySource, week: string, n: FirstPartyNumbers, note: string | null, pool: Pool = getPool()) {
  await pool.query(
    `INSERT INTO first_party_stats (source, week_start, citations, cited_pages, impressions, clicks, avg_position, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (source, week_start) DO UPDATE SET citations = EXCLUDED.citations, cited_pages = EXCLUDED.cited_pages,
       impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, avg_position = EXCLUDED.avg_position, note = EXCLUDED.note, entered_at = now()`,
    [source, weekOfDay(week), ...FP_FIELDS.map((f) => n[f] ?? null), note]);
}

/** A small CSV reader: commas or tabs, double-quoted fields, a header row. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const delim = (src.split(/\r?\n/)[0].match(/\t/g)?.length ?? 0) > (src.split(/\r?\n/)[0].match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/** Reads a date as written in a Search Console or Bing export: 2026-11-16, 16/11/2026, 11/16/2026 or "Nov 16, 2026". */
function csvDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (m) {
    // Day first (India) unless that is impossible.
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [d, mo] = b > 12 ? [b, a] : [a, b];
    return `${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const p = Date.parse(`${t} 12:00 UTC`);
  return Number.isNaN(p) ? null : new Date(p).toISOString().slice(0, 10);
}

const toNumber = (s: string | undefined) => {
  if (s === undefined) return null;
  const n = Number(s.replace(/[%,\s]/g, ""));
  return s.trim() === "" || Number.isNaN(n) ? null : n;
};

/**
 * Daily rows of an export (a "Date" column and any of citations, cited pages, impressions, clicks, position)
 * summed into IST weeks; position is averaged. Returns the weeks it saved.
 */
export async function importFirstPartyCsv(source: FirstPartySource, csv: string, pool: Pool = getPool()): Promise<{ weeks: string[]; rows: number }> {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new ImportError("The file has no data rows");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const dateCol = col(/date|day/);
  if (dateCol < 0) throw new ImportError("No date column found (expected a column named Date)");
  const cols = {
    citations: col(/^citations?$|total citations|ai citations/), cited_pages: col(/cited pages|pages cited/),
    impressions: col(/impressions/), clicks: col(/clicks/), avg_position: col(/position/),
  };
  if (Object.values(cols).every((c) => c < 0)) throw new ImportError("No citations, cited pages, impressions, clicks or position column found");
  const weeks = new Map<string, { sums: Record<string, number | null>; pos: number[] }>();
  let used = 0;
  for (const r of rows.slice(1)) {
    const day = csvDate(r[dateCol] ?? "");
    if (!day) continue;
    used++;
    const w = weekOfDay(day);
    const agg = weeks.get(w) ?? { sums: { citations: null, cited_pages: null, impressions: null, clicks: null }, pos: [] };
    for (const f of ["citations", "cited_pages", "impressions", "clicks"] as const) {
      const v = cols[f] >= 0 ? toNumber(r[cols[f]]) : null;
      if (v !== null) agg.sums[f] = (agg.sums[f] ?? 0) + v;
    }
    const pos = cols.avg_position >= 0 ? toNumber(r[cols.avg_position]) : null;
    if (pos !== null) agg.pos.push(pos);
    weeks.set(w, agg);
  }
  if (used === 0) throw new ImportError("No row had a date that could be read");
  for (const [w, agg] of weeks) {
    const avg = agg.pos.length ? Number((agg.pos.reduce((a, b) => a + b, 0) / agg.pos.length).toFixed(2)) : null;
    await saveFirstParty(source, w, { ...agg.sums, avg_position: avg }, `imported from CSV (${used} daily rows)`, pool);
  }
  return { weeks: [...weeks.keys()].sort(), rows: used };
}

// ---------------------------------------------------------------- weekly figures

/** Records what the site has live this week (the latest value of the week stands). */
export async function snapshotWeek(pool: Pool = getPool(), now = new Date()): Promise<void> {
  await pool.query(
    `INSERT INTO weekly_snapshots (week_start, live_events, venues, artists, updated_at)
     SELECT $1::date,
       (SELECT count(*) FROM events e WHERE e.is_published AND e.status NOT IN ('cancelled', 'happened')
          AND coalesce(e.ends_at, e.starts_at + CASE WHEN e.start_time_known THEN interval '6 hours' ELSE interval '1 day' END) >= $2),
       (SELECT count(DISTINCT e.venue_id) FROM events e WHERE e.is_published AND e.venue_id IS NOT NULL),
       (SELECT count(DISTINCT ea.artist_id) FROM event_artists ea JOIN events e ON e.id = ea.event_id WHERE e.is_published),
       $2
     ON CONFLICT (week_start) DO UPDATE SET live_events = EXCLUDED.live_events, venues = EXCLUDED.venues, artists = EXCLUDED.artists,
       updated_at = EXCLUDED.updated_at`,
    [weekStart(now), now]);
}

export interface EngineWeek { engine: string; answered: number; cited: number; mentioned: number; checks: number }
export interface Week {
  weekStart: string;
  engines: EngineWeek[];
  all: { answered: number; cited: number; mentioned: number; checks: number };
  crawlerVisits: number;
  crawlerByVendor: Record<string, number>;
  liveEvents: number | null;
  venues: number | null;
  artists: number | null;
  bing: { citations: number | null; cited_pages: number | null } | null;
  searchConsole: { impressions: number | null; clicks: number | null; avg_position: number | null } | null;
}

/** Week by week, newest first: citation share per engine, AI crawler visits and what was live. */
export async function weeklyFigures(pool: Pool = getPool(), opts: { cityId?: number; limit?: number } = {}): Promise<Week[]> {
  const [results, crawls, snaps, fp] = await Promise.all([
    pool.query<{ week: string; engine: string; checks: number; answered: number; cited: number; mentioned: number }>(
      `SELECT r.week_start::text AS week, r.engine, count(*)::int AS checks, count(*) FILTER (WHERE r.answered)::int AS answered,
              count(*) FILTER (WHERE r.answered AND r.cited)::int AS cited, count(*) FILTER (WHERE r.answered AND r.mentioned_by_name)::int AS mentioned
       FROM citation_results r JOIN citation_queries q ON q.id = r.query_id
       WHERE ($1::bigint IS NULL OR q.city_id = $1) GROUP BY 1, 2`, [opts.cityId ?? null]),
    pool.query<{ week: string; agent: string; n: number }>(
      `SELECT date_trunc('week', visited_at AT TIME ZONE $1)::date::text AS week, agent, count(*)::int AS n FROM crawler_log GROUP BY 1, 2`,
      [displayTimeZone]),
    pool.query<{ week: string; live_events: number; venues: number; artists: number }>(
      "SELECT week_start::text AS week, live_events, venues, artists FROM weekly_snapshots"),
    pool.query<{ week: string; source: string; citations: number | null; cited_pages: number | null; impressions: number | null; clicks: number | null; avg_position: string | null }>(
      "SELECT week_start::text AS week, source, citations, cited_pages, impressions, clicks, avg_position FROM first_party_stats"),
  ]);
  const weeks = new Set<string>([...results.rows.map((r) => r.week), ...snaps.rows.map((r) => r.week), ...fp.rows.map((r) => r.week)]);
  // Crawler weeks only count once the tracker has a week of its own, so the table starts at the baseline.
  const first = [...weeks].sort()[0];
  if (first) for (const c of crawls.rows) if (c.week >= first) weeks.add(c.week);
  const vendor = (agent: string) => agent;
  return [...weeks].sort().reverse().slice(0, opts.limit ?? 104).map((w) => {
    const rows = results.rows.filter((r) => r.week === w);
    const engines = ENGINE_KEYS.map((e) => {
      const r = rows.find((x) => x.engine === e);
      return { engine: e, checks: r?.checks ?? 0, answered: r?.answered ?? 0, cited: r?.cited ?? 0, mentioned: r?.mentioned ?? 0 };
    }).filter((e) => e.checks > 0);
    const sum = (k: "answered" | "cited" | "mentioned" | "checks") => engines.reduce((s, e) => s + e[k], 0);
    const visits = crawls.rows.filter((c) => c.week === w);
    const snap = snaps.rows.find((s) => s.week === w);
    const bing = fp.rows.find((f) => f.week === w && f.source === "bing_ai");
    const gsc = fp.rows.find((f) => f.week === w && f.source === "search_console");
    return {
      weekStart: w, engines, all: { answered: sum("answered"), cited: sum("cited"), mentioned: sum("mentioned"), checks: sum("checks") },
      crawlerVisits: visits.reduce((s, v) => s + v.n, 0),
      crawlerByVendor: Object.fromEntries(visits.map((v) => [vendor(v.agent), v.n])),
      liveEvents: snap?.live_events ?? null, venues: snap?.venues ?? null, artists: snap?.artists ?? null,
      bing: bing ? { citations: bing.citations, cited_pages: bing.cited_pages } : null,
      searchConsole: gsc ? { impressions: gsc.impressions, clicks: gsc.clicks, avg_position: gsc.avg_position === null ? null : Number(gsc.avg_position) } : null,
    };
  });
}

export interface QuestionRow { id: number; city: string; locale: string; query: string; position: number }

export async function activeQuestions(pool: Pool = getPool(), citySlug?: string): Promise<QuestionRow[]> {
  return (await pool.query<QuestionRow>(
    `SELECT q.id, c.slug AS city, q.locale, q.query, q.position FROM citation_queries q JOIN cities c ON c.id = q.city_id
     WHERE q.active AND ($1::text IS NULL OR c.slug = $1) ORDER BY c.slug, q.locale, q.position, q.id`, [citySlug ?? null])).rows;
}

export interface ResultRow {
  query_id: number; locale: string; query: string; engine: string; answered: boolean; cited: boolean; mentioned_by_name: boolean;
  competitors_cited: string[]; cited_urls: string[]; our_urls: string[]; answer_excerpt: string | null; screenshot_url: string | null;
  method: string; model: string | null; cost_usd: number; note: string | null;
}

/** Every check of one week, for the admin view. */
export async function weekResults(week: string, pool: Pool = getPool()): Promise<ResultRow[]> {
  return (await pool.query<ResultRow>(
    `SELECT r.query_id, q.locale, q.query, r.engine, r.answered, r.cited, r.mentioned_by_name, r.competitors_cited, r.cited_urls, r.our_urls,
            r.answer_excerpt, r.screenshot_url, r.method, r.model, r.cost_usd::float AS cost_usd, r.note
     FROM citation_results r JOIN citation_queries q ON q.id = r.query_id WHERE r.week_start = $1
     ORDER BY q.locale, q.position, r.engine`, [week])).rows;
}

/** The citations budget this month, and what one run may spend (the runner's --max-cost). */
export async function citationBudget(pool: Pool = getPool()) {
  const spent = await monthSpend("citations", { pool });
  const left = Math.max(0, budgets.citations - spent);
  return { spent, cap: budgets.citations, left, runCeiling: Number(Math.min(cfg.maxRunUsd, left).toFixed(2)) };
}

export async function lastRuns(pool: Pool = getPool(), limit = 10) {
  return (await pool.query<{ run_id: string; week_start: string; asked_at: Date; imported_at: Date; checks: number; answered: number; cost_usd: number; report: Record<string, unknown> }>(
    `SELECT run_id, week_start::text AS week_start, asked_at, imported_at, checks, answered, cost_usd::float AS cost_usd, report
     FROM citation_runs ORDER BY imported_at DESC LIMIT $1`, [limit])).rows;
}

export async function firstPartyRows(pool: Pool = getPool()) {
  return (await pool.query<{ source: string; week_start: string; citations: number | null; cited_pages: number | null; impressions: number | null; clicks: number | null; avg_position: string | null; note: string | null }>(
    "SELECT source, week_start::text AS week_start, citations, cited_pages, impressions, clicks, avg_position, note FROM first_party_stats ORDER BY week_start DESC, source LIMIT 60")).rows;
}
