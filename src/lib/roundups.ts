/**
 * Weekly roundup per city (Prompt 11). Every Thursday the ingest job drafts an
 * article for the coming weekend and week (Friday to the Thursday after):
 *   - the sections (by category, then "free this weekend" and "for families"
 *     when there are enough) are chosen from the database, with no model;
 *   - the model writes only the headline and a short overview, in English and
 *     Hindi, from the facts it is given;
 *   - the event lines are drawn from the database each time the page is shown,
 *     so a cancellation or correction reaches the article too.
 * Nothing here publishes: the draft waits in the admin area for one click.
 */
import { z } from "zod";
import type { Pool } from "pg";
import { roundups as cfg } from "../config";
import { addDays, clock, isoDay, longDay } from "./format";
import type { LlmClient, LlmRequest } from "./pipeline/llm";
import { estimateUsd } from "./pipeline/llm";
import { localDate, wordCount } from "./pipeline/text";
import { dropMissingFactSentences } from "./pipeline/write";
import { listEvents, type EventCard } from "./queries";

export interface Period {
  /** The Friday the guide starts on, "YYYY-MM-DD". */
  start: string;
  /** The Thursday after. */
  end: string;
  /** The Sunday: the end of "this weekend". */
  weekendEnd: string;
  isoYear: number;
  isoWeek: number;
  slug: string;
}

/** ISO 8601 week number and its year for a "YYYY-MM-DD" date. */
export function isoWeek(day: string): { year: number; week: number } {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), week: Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7) };
}

/**
 * The week a guide made today covers. Monday to Thursday: from the coming Friday. Friday to Sunday:
 * from the Friday just gone, so a guide made at the weekend still covers that weekend.
 */
export function periodFor(today: string): Period {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 Sunday ... 6 Saturday
  const toFriday = dow === 5 ? 0 : dow === 6 ? -1 : dow === 0 ? -2 : 5 - dow;
  const start = addDays(today, toFriday);
  const { year, week } = isoWeek(start);
  return { start, end: addDays(start, 6), weekendEnd: addDays(start, 2), isoYear: year, isoWeek: week, slug: `${year}-week-${week}` };
}

export function periodFromSlug(slug: string): { isoYear: number; isoWeek: number } | null {
  const m = slug.match(/^(\d{4})-week-(\d{1,2})$/);
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 53 ? { isoYear: Number(m[1]), isoWeek: Number(m[2]) } : null;
}

export interface Section { key: string; event_ids: number[] }

const localDay = (e: EventCard) => isoDay(e.starts_at, e.timezone);
const FAMILY = /\b(all ages|family|families|kids|children|child-friendly)\b/i;
const ADULT = /\b(18\s*\+|21\s*\+|adults only)\b/i;

/**
 * The sections, from the database alone: one per category (in the site's category order), then
 * "free this weekend" and "for families" when each has enough events. Cancelled events are left out.
 */
export async function chooseSections(pool: Pool, cityId: number, period: Period): Promise<{ sections: Section[]; events: EventCard[] }> {
  const events = (await listEvents({ cityId, from: period.start, to: period.end, when: "any", limit: 500 }, "en"))
    .filter((e) => e.status !== "cancelled");
  const order = (await pool.query<{ slug: string }>("SELECT slug FROM categories ORDER BY sort_order")).rows.map((c) => c.slug);
  const sections: Section[] = [];
  for (const slug of [...order, null]) {
    const ids = events.filter((e) => e.category_slug === slug || (slug === null && !e.category_slug)).map((e) => e.id);
    if (ids.length) sections.push({ key: slug ?? "other", event_ids: ids });
  }
  const free = events.filter((e) => e.is_free && localDay(e) <= period.weekendEnd).map((e) => e.id);
  if (free.length >= cfg.minForExtraSection) sections.push({ key: "free", event_ids: free });
  const ages = new Map((await pool.query<{ event_id: number; answer: string }>(
    `SELECT e.id AS event_id, pf.answer FROM practical_facts pf JOIN events e
       ON (pf.entity_type = 'event' AND pf.entity_id = e.id)
     WHERE pf.fact_key = 'age_limit' AND e.id = ANY($1::bigint[])`, [events.map((e) => e.id)])).rows.map((r) => [Number(r.event_id), r.answer]));
  const families = events.filter((e) => {
    const age = ages.get(e.id) ?? "";
    return !ADULT.test(age) && (e.category_slug === "kids" || FAMILY.test(age));
  }).map((e) => e.id);
  if (families.length >= cfg.minForExtraSection) sections.push({ key: "families", event_ids: families });
  return { sections, events };
}

// ---------------------------------------------------------------- the overview

const OverviewSchema = z.object({ title_en: z.string(), intro_en: z.string(), title_hi: z.string(), intro_hi: z.string() });
type Overview = z.infer<typeof OverviewSchema>;

const SYSTEM = `You write the opening of a weekly "what's on" guide for one city in India, in English and in Hindi. It is published on a city events guide that AI assistants and search engines quote, so it must be accurate, plain and complete.

You are given the city, the dates the guide covers, and every event in it (name, day, time, venue, type, price). Write:
- title_en: a plain headline naming the city and the dates, for example "What's on in Indore: 21 to 27 November 2026". No hype.
- intro_en: one paragraph of ${cfg.introMinWords} to ${cfg.introMaxWords} words. Say how many events are listed and over which days, name the kinds of events there are, and mention three to five specific events by name with their day and venue, choosing a spread of types. Say how many are free when some are. Use only the facts given: do not describe atmosphere, do not add background about artists or venues, do not predict anything. Neutral tone, no exclamation marks, no "you", no calls to action.
- title_hi and intro_hi: the same title and paragraph in natural, everyday Hindi in Devanagari, the way the city page of a Hindi newspaper reads. Keep the English words people use for going out (इवेंट, शो, टिकट, कॉमेडी, कॉन्सर्ट, वर्कशॉप, एंट्री). Write names of events, people and venues in Devanagari as they are pronounced. Keep every number, ₹ amount and time exactly; use Hindi month and weekday names.`;

function overviewRequest(cityName: string, period: Period, events: EventCard[], categoryNames: Map<string, string>): LlmRequest<Overview> {
  const line = (e: EventCard) => [
    e.title, longDay(localDay(e), "en"), e.start_time_known ? clock(e.starts_at, e.timezone, "en") : null, e.venue_name,
    e.category_slug ? categoryNames.get(e.category_slug) : null, e.is_free ? "free entry" : e.price_text,
  ].filter(Boolean).join(" | ");
  const shown = events.slice(0, cfg.maxEventsInPrompt);
  const text = [
    `City: ${cityName}`,
    `Guide covers: ${longDay(period.start, "en")} to ${longDay(period.end, "en")}`,
    `Events listed: ${events.length}${events.length > shown.length ? ` (the first ${shown.length} are below)` : ""}`,
    `Free events: ${events.filter((e) => e.is_free).length}`,
    "",
    "Events (name | day | time | venue | type | price):",
    ...shown.map((e) => `- ${line(e)}`),
  ].join("\n");
  return {
    id: "roundup", tier: "mid", system: SYSTEM, content: [{ type: "text", text }], schema: OverviewSchema,
    maxTokens: 4000, effort: "low", estInputTokens: 700 + Math.ceil(text.length / 3), estOutputTokens: 900,
  };
}

const DEVANAGARI = /[ऀ-ॿ]/;

/** Why an overview cannot be used, or null when it can. */
export function overviewProblem(o: Overview): string | null {
  const words = wordCount(o.intro_en);
  if (!o.title_en.trim() || o.title_en.length > 140) return "the English headline is missing or too long";
  if (words < cfg.introMinWords - 20 || words > cfg.introMaxWords + 40) return `the English overview was ${words} words`;
  if (/!/.test(o.intro_en)) return "the English overview has an exclamation mark";
  if (!DEVANAGARI.test(o.title_hi) || !DEVANAGARI.test(o.intro_hi)) return "the Hindi text is not in Hindi";
  if (o.intro_hi.length < o.intro_en.length * 0.5) return "the Hindi overview is much shorter than the English";
  return null;
}

// ---------------------------------------------------------------- drafting

export interface RoundupReport {
  city: string;
  slug: string;
  status: "drafted" | "exists" | "published already" | "too few events" | "failed" | "dry run";
  events?: number;
  sections?: { key: string; events: number }[];
  estimatedUsd?: number;
  usd?: number;
  error?: string;
}

/**
 * Drafts this week's guide for each live city (or one). An existing draft is left alone unless `force`;
 * a published guide is never replaced.
 */
export async function draftRoundups(
  pool: Pool, llm: LlmClient,
  opts: { jobName: string; dryRun?: boolean; batch?: boolean; city?: string; force?: boolean; now?: Date },
): Promise<RoundupReport[]> {
  const cities = (await pool.query<{ id: number; slug: string; name: string; timezone: string }>(
    "SELECT id, slug, name, timezone FROM cities WHERE is_live AND ($1::text IS NULL OR slug = $1) ORDER BY id", [opts.city ?? null])).rows;
  const names = new Map((await pool.query<{ slug: string; name: string }>("SELECT slug, name FROM categories")).rows.map((c) => [c.slug, c.name]));
  const out: RoundupReport[] = [];
  for (const city of cities) {
    const period = periodFor(localDate(opts.now ?? new Date(), city.timezone));
    const report: RoundupReport = { city: city.slug, slug: period.slug, status: "failed" };
    out.push(report);
    const existing = (await pool.query<{ status: string }>("SELECT status FROM roundups WHERE city_id = $1 AND slug = $2", [city.id, period.slug])).rows[0];
    if (existing?.status === "published") { report.status = "published already"; continue; }
    if (existing && !opts.force) { report.status = "exists"; continue; }

    const { sections, events } = await chooseSections(pool, city.id, period);
    report.events = events.length;
    report.sections = sections.map((s) => ({ key: s.key, events: s.event_ids.length }));
    if (events.length < cfg.minEvents) { report.status = "too few events"; continue; }
    const req = overviewRequest(city.name, period, events, names);
    report.estimatedUsd = Number(estimateUsd(req, opts.batch).toFixed(4));
    if (opts.dryRun) { report.status = "dry run"; continue; }

    const [res] = await llm.run([req], { jobName: opts.jobName, batch: opts.batch, subBudget: "roundups", pool });
    report.usd = Number((res?.usd ?? 0).toFixed(5));
    const o = res?.ok && res.data ? {
      title_en: res.data.title_en.replace(/\s+/g, " ").trim(),
      intro_en: dropMissingFactSentences(res.data.intro_en.replace(/\s+/g, " ").trim()),
      title_hi: res.data.title_hi.replace(/\s+/g, " ").trim(),
      intro_hi: res.data.intro_hi.replace(/\s+/g, " ").trim(),
    } : null;
    const problem = o ? overviewProblem(o) : res?.error ?? "the model gave no answer";
    if (!o || problem) { report.error = problem ?? "unknown"; continue; }

    await pool.query(
      `INSERT INTO roundups (city_id, slug, period_start, period_end, title, intro, title_hi, intro_hi, sections, event_ids, model_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (city_id, slug) DO UPDATE SET title = EXCLUDED.title, intro = EXCLUDED.intro, title_hi = EXCLUDED.title_hi,
         intro_hi = EXCLUDED.intro_hi, sections = EXCLUDED.sections, event_ids = EXCLUDED.event_ids, period_start = EXCLUDED.period_start,
         period_end = EXCLUDED.period_end, model_usd = roundups.model_usd + EXCLUDED.model_usd, generated_at = now(), updated_at = now()
       WHERE roundups.status = 'draft'`,
      [city.id, period.slug, period.start, period.end, o.title_en, o.intro_en, o.title_hi, o.intro_hi,
        JSON.stringify(sections), events.map((e) => e.id), res!.usd]);
    report.status = "drafted";
  }
  return out;
}

// ---------------------------------------------------------------- reading

export interface Roundup {
  id: number; city_id: number; city_slug: string; city_name: string; timezone: string; slug: string;
  period_start: string; period_end: string; status: "draft" | "published"; title: string; intro: string;
  sections: Section[]; event_ids: number[]; published_at: Date | null; updated_at: Date; generated_at: Date; model_usd: number;
}

const COLUMNS = (hindi: boolean) => `r.id, r.city_id, c.slug AS city_slug, c.name AS city_name, c.timezone, r.slug,
  r.period_start::text, r.period_end::text, r.status, ${hindi ? "coalesce(r.title_hi, r.title)" : "r.title"} AS title,
  ${hindi ? "coalesce(r.intro_hi, r.intro)" : "r.intro"} AS intro, r.sections, r.event_ids::bigint[] AS event_ids,
  r.published_at, r.updated_at, r.generated_at, r.model_usd::float AS model_usd`;

export async function getRoundup(pool: Pool, citySlug: string, slug: string, locale: string, includeDrafts = false): Promise<Roundup | null> {
  const { rows } = await pool.query<Roundup>(
    `SELECT ${COLUMNS(locale === "hi")} FROM roundups r JOIN cities c ON c.id = r.city_id
     WHERE c.slug = $1 AND r.slug = $2 AND c.is_live AND ($3 OR r.status = 'published')`, [citySlug.toLowerCase(), slug, includeDrafts]);
  return rows[0] ? { ...rows[0], event_ids: rows[0].event_ids.map(Number) } : null;
}

export async function getRoundupById(pool: Pool, id: number, locale: string): Promise<Roundup | null> {
  const { rows } = await pool.query<Roundup>(`SELECT ${COLUMNS(locale === "hi")} FROM roundups r JOIN cities c ON c.id = r.city_id WHERE r.id = $1`, [id]);
  return rows[0] ? { ...rows[0], event_ids: rows[0].event_ids.map(Number) } : null;
}

export async function listRoundups(pool: Pool, cityId: number, locale: string, limit = 60): Promise<Roundup[]> {
  return (await pool.query<Roundup>(
    `SELECT ${COLUMNS(locale === "hi")} FROM roundups r JOIN cities c ON c.id = r.city_id
     WHERE r.city_id = $1 AND r.status = 'published' ORDER BY r.period_start DESC LIMIT $2`, [cityId, limit])).rows;
}

/** Every published guide, for the sitemap. */
export async function publishedRoundupPaths(pool: Pool): Promise<{ city: string; slug: string; updated_at: Date }[]> {
  return (await pool.query<{ city: string; slug: string; updated_at: Date }>(
    `SELECT c.slug AS city, r.slug, r.updated_at FROM roundups r JOIN cities c ON c.id = r.city_id
     WHERE c.is_live AND r.status = 'published' ORDER BY c.slug, r.period_start DESC`)).rows;
}

/** The events a guide lists, in the page's language, keyed by id: past and cancelled ones included, so old guides still link. */
export async function roundupEvents(r: Pick<Roundup, "city_id" | "event_ids">, locale: "en" | "hi"): Promise<Map<number, EventCard>> {
  if (!r.event_ids.length) return new Map();
  const events = await listEvents({ cityId: r.city_id, ids: r.event_ids, when: "any", limit: 1000 }, locale);
  return new Map(events.map((e) => [e.id, e]));
}
