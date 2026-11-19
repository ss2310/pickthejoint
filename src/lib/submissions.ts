/**
 * User submissions (Prompt 6). Nothing submitted is published directly:
 *
 *   draft    the form being filled in (from scratch, or prefilled from a
 *            poster photo); reachable only through its random token
 *   pending  sent, pre-screened (complete, plausible date, not a duplicate,
 *            not spam) and waiting in review_queue with the screening notes
 *   approved the admin approved it: it became an event with origin "submitted"
 *   rejected the admin rejected it (or the honeypot caught a bot)
 *
 * The submitter's name and contact live only in `submissions.submitter` and
 * are never shown on a public page.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import { ingestion, submissions as cfg, type SubBudget } from "../config";
import { getPool } from "./db";
import type { ExtractedEvent } from "./pipeline/extract";
import type { LlmClient, LlmRequest } from "./pipeline/llm";
import { attachPeople, categoryId, matchVenue, timing, uniqueSlug, type PostContext } from "./pipeline/resolve";
import { daysBetween, isClockTime, isIsoDate, localDate, slugify, titleSimilarity } from "./pipeline/text";
import { writeDescriptions } from "./pipeline/write";
import { FACT_KEYS, cleanAnswer, formFacts, isFactKey, storeFacts, type FactKey } from "./practical";

// ---------------------------------------------------------------- fields

export interface SubmissionFields {
  title: string;
  date: string;
  start_time: string;
  end_date: string;
  end_time: string;
  venue: string;
  venue_address: string;
  area: string;
  category: string;
  price: string;
  is_free: boolean;
  booking_url: string;
  instagram_url: string;
  performers: string;
  organiser: string;
  /** A note to us; read by the reviewer, never published. */
  note: string;
  /** Fields a poster reading was unsure of, for the submitter to check. */
  uncertain?: string[];
  /** Practical details (Prompt 11), keyed by question; empty ones are left out. */
  practical?: Partial<Record<FactKey, string>>;
  /** Set when the form adds or corrects practical details of an event already listed: that event's id. */
  for_event?: number | null;
}

export interface Submitter { name: string; contact: string }

export const FIELD_NAMES = [
  "title", "date", "start_time", "end_date", "end_time", "venue", "venue_address", "area", "category", "price",
  "booking_url", "instagram_url", "performers", "organiser", "note",
] as const;

export function emptyFields(): SubmissionFields {
  return {
    title: "", date: "", start_time: "", end_date: "", end_time: "", venue: "", venue_address: "", area: "", category: "",
    price: "", is_free: false, booking_url: "", instagram_url: "", performers: "", organiser: "", note: "",
  };
}

const LIMITS: Partial<Record<keyof SubmissionFields | keyof Submitter, number>> = {
  title: 160, venue: 160, practical: 240, venue_address: 300, area: 80, category: 60, price: 120, booking_url: 500, instagram_url: 300,
  performers: 400, organiser: 160, note: 1500, name: 120, contact: 200,
};

type FormLike = { get(name: string): FormDataEntryValue | null };
const text = (form: FormLike, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, LIMITS[name as keyof typeof LIMITS] ?? 200) : "";
};

export function readFields(form: FormLike): SubmissionFields {
  const f = emptyFields();
  for (const name of FIELD_NAMES) (f as unknown as Record<string, string>)[name] = text(form, name);
  f.note = (typeof form.get("note") === "string" ? (form.get("note") as string) : "").trim().slice(0, LIMITS.note!);
  f.is_free = form.get("is_free") === "on" || form.get("is_free") === "true";
  const practical: Partial<Record<FactKey, string>> = {};
  for (const key of FACT_KEYS) {
    const v = form.get(`fact_${key}`);
    if (typeof v === "string" && v.trim()) practical[key] = v.replace(/\s+/g, " ").trim().slice(0, LIMITS.practical!);
  }
  if (Object.keys(practical).length) f.practical = practical;
  const forEvent = Number(form.get("for_event"));
  if (Number.isInteger(forEvent) && forEvent > 0) f.for_event = forEvent;
  return f;
}

export function readSubmitter(form: FormLike): Submitter {
  return { name: text(form, "name"), contact: text(form, "contact") };
}

/** Error codes per field; the page turns each into a sentence in the reader's language. */
export type FieldError =
  | "required" | "noFacts" | "badDate" | "pastDate" | "farDate" | "badTime" | "endBeforeStart" | "badUrl" | "badInstagram" | "badCategory" | "badContact"
  /** Whole-form problems, stored under the key "_form". */
  | "captcha" | "tooMany";

export interface LiveCity { id: number; slug: string; name: string; timezone: string }

export async function liveCities(pool: Pool = getPool()): Promise<LiveCity[]> {
  return (await pool.query<LiveCity>("SELECT id, slug, name, timezone FROM cities WHERE is_live ORDER BY name")).rows;
}

const isHttpUrl = (u: string) => {
  try { const x = new URL(u); return (x.protocol === "https:" || x.protocol === "http:") && x.hostname.includes("."); } catch { return false; }
};
const isInstagramPost = (u: string) => {
  try { const x = new URL(u); return /(^|\.)instagram\.com$/.test(x.hostname) && /^\/(p|reel|tv)\/[\w-]+/.test(x.pathname); } catch { return false; }
};
const looksLikeContact = (c: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) || /^\+?[\d\s()-]{8,20}$/.test(c);

export function validate(f: SubmissionFields, s: Submitter | null, categories: string[], today: string): Partial<Record<string, FieldError>> {
  const e: Partial<Record<string, FieldError>> = {};
  if (f.practical?.doors_time && !cleanAnswer("doors_time", f.practical.doors_time)) e.fact_doors_time = "badTime";
  if (f.for_event) {
    // Practical details for an event already listed: its facts are not asked again, but at least one detail is.
    if (!formFacts(f.practical).length) e._facts = "noFacts";
    if (s) {
      if (!s.name) e.name = "required";
      if (!s.contact) e.contact = "required";
      else if (!looksLikeContact(s.contact)) e.contact = "badContact";
    }
    return e;
  }
  for (const k of ["title", "date", "venue", "category"] as const) if (!f[k]) e[k] = "required";
  if (f.date) {
    if (!isIsoDate(f.date)) e.date = "badDate";
    else if (daysBetween(today, f.date) < 0) e.date = "pastDate";
    else if (daysBetween(today, f.date) > 365) e.date = "farDate";
  }
  if (f.start_time && !isClockTime(f.start_time)) e.start_time = "badTime";
  if (f.end_time && !isClockTime(f.end_time)) e.end_time = "badTime";
  if (f.end_date && !isIsoDate(f.end_date)) e.end_date = "badDate";
  else if (f.end_date && f.date && isIsoDate(f.date) && f.end_date < f.date) e.end_date = "endBeforeStart";
  if (f.category && !categories.includes(f.category)) e.category = "badCategory";
  if (f.booking_url && !isHttpUrl(f.booking_url)) e.booking_url = "badUrl";
  if (f.instagram_url && !isInstagramPost(f.instagram_url)) e.instagram_url = "badInstagram";
  if (s) {
    if (!s.name) e.name = "required";
    if (!s.contact) e.contact = "required";
    else if (!looksLikeContact(s.contact)) e.contact = "badContact";
  }
  return e;
}

/** Prefills the form from what the vision model read on a poster. Unsure facts are listed so the submitter checks them. */
export function fieldsFromExtraction(ev: ExtractedEvent, categories: string[], minConfidence = 0.4): SubmissionFields {
  const f = emptyFields();
  const uncertain: string[] = [];
  const take = <T>(field: { value: T | null; confidence: number }, name: string): T | null => {
    if (field.value === null || field.value === "") return null;
    if (field.confidence < ingestion.publishConfidence) uncertain.push(name);
    return field.confidence >= minConfidence ? field.value : null;
  };
  f.title = take(ev.title, "title") ?? "";
  f.date = take(ev.start_date, "date") ?? "";
  f.start_time = take(ev.start_time, "start_time") ?? "";
  f.end_date = take(ev.end_date, "end_date") ?? "";
  f.end_time = take(ev.end_time, "end_time") ?? "";
  f.venue = take(ev.venue_name, "venue") ?? "";
  f.area = take(ev.area, "area") ?? "";
  const cat = take(ev.category, "category");
  f.category = cat && categories.includes(cat) ? cat : "";
  f.price = take(ev.price_text, "price") ?? "";
  f.is_free = take(ev.is_free, "is_free") === true;
  f.booking_url = take(ev.booking_url, "booking_url") ?? "";
  f.performers = ev.performers.filter((p) => p.confidence >= 0.5).map((p) => p.name.trim()).filter(Boolean).join(", ");
  f.organiser = take(ev.organiser, "organiser") ?? "";
  if (f.start_time && !isClockTime(f.start_time)) f.start_time = "";
  if (f.end_time && !isClockTime(f.end_time)) f.end_time = "";
  // Practical details the source stated, for the reviewer to check like the rest (older readings have none).
  const practical: Partial<Record<FactKey, string>> = {};
  for (const p of ev.practical ?? []) {
    if (!isFactKey(p.key) || practical[p.key] || p.confidence < Math.max(minConfidence, 0.6)) continue;
    const answer = cleanAnswer(p.key, p.answer);
    if (answer) practical[p.key] = answer;
  }
  if (Object.keys(practical).length) f.practical = practical;
  f.uncertain = uncertain;
  return f;
}

// ---------------------------------------------------------------- drafts

export interface SubmissionRow {
  id: number; token: string; channel: "form" | "poster" | "admin" | "email"; status: "draft" | "pending" | "approved" | "rejected";
  city_id: number | null; fields: SubmissionFields; submitter: Submitter; screening: Screening | null;
  form_errors: Partial<Record<string, FieldError>> | null; poster_id: number | null; event_id: number | null;
  created_at: Date; updated_at: Date; submitted_at: Date | null;
}

export async function createDraft(
  input: { channel: SubmissionRow["channel"]; cityId: number | null; fields: SubmissionFields; submitter?: Submitter; posterId?: number | null; ipHash?: string | null },
  pool: Pool = getPool(),
): Promise<{ id: number; token: string }> {
  const token = randomBytes(18).toString("base64url");
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO submissions (token, channel, city_id, fields, submitter, poster_id, ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [token, input.channel, input.cityId, input.fields, input.submitter ?? { name: "", contact: "" }, input.posterId ?? null, input.ipHash ?? null]);
  return { id: rows[0].id, token };
}

export async function getDraft(token: string, pool: Pool = getPool()): Promise<SubmissionRow | null> {
  if (!/^[\w-]{10,40}$/.test(token)) return null;
  const { rows } = await pool.query<SubmissionRow>("SELECT * FROM submissions WHERE token = $1 AND status = 'draft'", [token]);
  return rows[0] ?? null;
}

export async function getSubmission(id: number, pool: Pool = getPool()): Promise<SubmissionRow | null> {
  return (await pool.query<SubmissionRow>("SELECT * FROM submissions WHERE id = $1", [id])).rows[0] ?? null;
}

export async function saveDraft(
  id: number, data: { cityId: number | null; fields: SubmissionFields; submitter: Submitter; errors: Partial<Record<string, FieldError>> | null },
  pool: Pool = getPool(),
): Promise<void> {
  await pool.query(
    "UPDATE submissions SET city_id = $2, fields = $3, submitter = $4, form_errors = $5, updated_at = now() WHERE id = $1",
    [id, data.cityId, data.fields, data.submitter, data.errors]);
}

// ---------------------------------------------------------------- screening

export interface Screening {
  verdict: "looks_fine" | "needs_checking" | "likely_spam";
  notes: string[];
  missing: string[];
  duplicateOf: { id: number; title: string; path: string } | null;
  model: { spam: boolean; plausible: boolean; confidence: number; reason: string; tier: string } | null;
  modelUsd: number;
}

const SPAM_WORDS = /\b(casino|betting|bet365|satta|matka|loan|crypto|bitcoin|forex|viagra|escort|call ?girls?|seo services|backlinks?|earn (?:money|₹|rs)|work from home|whatsapp me|dm for price)\b/i;
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|cutt\.ly|rb\.gy|shorturl\.at|is\.gd|goo\.gl)\b/i;

/** Signs of spam the rules can see without a model. */
export function spamSigns(f: SubmissionFields, s: Submitter | null): string[] {
  const all = [f.title, f.venue, f.organiser, f.performers, f.price, f.note, s?.name ?? ""].join(" \n ");
  const signs: string[] = [];
  if (SPAM_WORDS.test(all)) signs.push(`spam word: "${all.match(SPAM_WORDS)![0]}"`);
  if (SHORTENERS.test([all, f.booking_url].join(" "))) signs.push("link shortener");
  const urls = all.match(/https?:\/\/|www\./gi)?.length ?? 0;
  if (urls >= 2) signs.push(`${urls} links in the text fields`);
  if (/(.)\1{6,}/.test(all)) signs.push("long run of one character");
  const letters = f.title.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 12 && letters === letters.toUpperCase() && /[A-Z]/.test(letters) && f.title.split(" ").length > 4) signs.push("title in capitals");
  if (/[\p{Script=Cyrillic}\p{Script=Han}]/u.test(all)) signs.push("text in an unexpected script");
  return signs;
}

const ScreenSchema = z.object({
  spam: z.boolean(),
  plausible_event: z.boolean(),
  reason: z.string(),
  confidence: z.number(),
});
type ScreenAnswer = z.infer<typeof ScreenSchema>;

const SCREEN_SYSTEM = `You screen event listings that members of the public send to a city events guide in India, before a human reviews them.
Decide two things:
- spam: true if this is advertising, a scam, SEO or link spam, adult content, gibberish, or a test with no real event; false for any genuine public event, however small (a college fest, a puja, a jam session, a workshop in a cafe).
- plausible_event: true if it reads like a real event someone could attend: a named event, a real-sounding venue in the city, a sensible date and time. Unusual but possible events are plausible.
Give a one-sentence reason and your confidence from 0 to 1. Do not judge quality or popularity.`;

function screenRequest(tier: "fast" | "mid", f: SubmissionFields, s: Submitter | null, cityName: string, today: string): LlmRequest<ScreenAnswer> {
  const lines = [
    `City: ${cityName}`, `Today: ${today}`,
    `Event name: ${f.title}`, `Date: ${f.date}${f.start_time ? ` ${f.start_time}` : ""}${f.end_date ? ` to ${f.end_date}` : ""}`,
    `Venue: ${f.venue}${f.venue_address ? `, ${f.venue_address}` : ""}${f.area ? ` (${f.area})` : ""}`,
    `Category: ${f.category}`, f.price && `Price: ${f.price}`, f.is_free && "Entry: free", f.booking_url && `Booking link: ${f.booking_url}`,
    f.instagram_url && `Instagram post: ${f.instagram_url}`, f.performers && `Performers: ${f.performers}`, f.organiser && `Organiser: ${f.organiser}`,
    f.note && `Note from the sender: ${f.note.slice(0, 800)}`, s?.name && `Sender's name: ${s.name}`,
  ].filter(Boolean).join("\n");
  return {
    id: `screen-${tier}`, tier, system: SCREEN_SYSTEM, content: [{ type: "text", text: lines }], schema: ScreenSchema,
    maxTokens: tier === "fast" ? 300 : 1500, effort: "low", estInputTokens: 250 + Math.ceil(lines.length / 3), estOutputTokens: tier === "fast" ? 60 : 300,
  };
}

/** Existing events in the city on the same day that look like the same one. */
export async function findDuplicate(
  pool: Pool, cityId: number, cityName: string, timeZone: string, f: SubmissionFields,
): Promise<{ id: number; title: string; path: string } | null> {
  if (!isIsoDate(f.date) || !f.title) return null;
  const venueId = f.venue ? await matchVenue(pool, manualContext(cityId, cityName, timeZone), asExtracted(f, cityName), false) : null;
  const { rows } = await pool.query<{ id: number; title: string; venue_id: number | null; path: string }>(
    `SELECT e.id, e.title, e.venue_id, '/' || c.slug || '/events/' || e.slug AS path FROM events e JOIN cities c ON c.id = e.city_id
     WHERE e.city_id = $1 AND e.local_date = $2 AND e.status <> 'cancelled'`, [cityId, f.date]);
  let best: (typeof rows)[number] | null = null, bestScore = 0;
  for (const r of rows) {
    const s = titleSimilarity(r.title, f.title);
    // At the same venue a looser match counts; elsewhere the names must be close.
    const needed = venueId && r.venue_id === venueId ? ingestion.titleSimilarity.different : ingestion.titleSimilarity.same;
    if (s >= needed && s > bestScore) { best = r; bestScore = s; }
  }
  return best ? { id: best.id, title: best.title, path: best.path } : null;
}

export async function screen(
  pool: Pool, llm: LlmClient, sub: Pick<SubmissionRow, "fields" | "submitter" | "channel" | "city_id">,
  opts: { jobName: string; subBudget?: SubBudget; now?: Date },
): Promise<Screening> {
  const f = sub.fields;
  const city = (await pool.query<{ id: number; name: string; timezone: string }>("SELECT id, name, timezone FROM cities WHERE id = $1", [sub.city_id])).rows[0];
  const today = localDate(opts.now ?? new Date(), city?.timezone ?? "Asia/Kolkata");
  const out: Screening = { verdict: "looks_fine", notes: [], missing: [], duplicateOf: null, model: null, modelUsd: 0 };
  const isPublic = sub.channel === "form" || sub.channel === "poster";

  if (f.for_event) {
    // Practical details for an event already listed: the event's facts were checked when it was published.
    const ev = (await pool.query<{ title: string; path: string }>(
      "SELECT e.title, '/' || c.slug || '/events/' || e.slug AS path FROM events e JOIN cities c ON c.id = e.city_id WHERE e.id = $1 AND e.is_published",
      [f.for_event])).rows[0];
    out.notes.push(ev ? `practical details for "${ev.title}" (${ev.path})` : `the event (id ${f.for_event}) is not published`);
    const n = formFacts(f.practical).length;
    out.notes.push(n ? `${n} detail${n === 1 ? "" : "s"} sent` : "no details sent");
    if (isPublic && !sub.submitter.contact) out.missing.push("contact");
    const signs = spamSigns({ ...f, note: [f.note, ...Object.values(f.practical ?? {})].join(" ") }, isPublic ? sub.submitter : null);
    if (signs.length) out.notes.push(`spam signs: ${signs.join("; ")}`);
    out.verdict = signs.length >= 2 ? "likely_spam" : !ev || !n || signs.length || out.missing.length ? "needs_checking" : "looks_fine";
    return out;
  }
  for (const k of ["title", "date", "venue", "category"] as const) if (!f[k]) out.missing.push(k);
  if (isPublic && !sub.submitter.contact) out.missing.push("contact");
  if (out.missing.length) out.notes.push(`incomplete: ${out.missing.join(", ")} missing`);
  else out.notes.push("complete");

  if (f.date && isIsoDate(f.date)) {
    const gap = daysBetween(today, f.date);
    if (gap < 0) out.notes.push(`date ${f.date} has passed`);
    else if (gap > 365) out.notes.push(`date ${f.date} is more than a year away`);
    else out.notes.push("date plausible");
  } else if (f.date) out.notes.push(`date "${f.date}" is not a date`);

  if (city) {
    out.duplicateOf = await findDuplicate(pool, city.id, city.name, city.timezone, f);
    out.notes.push(out.duplicateOf ? `possible duplicate of "${out.duplicateOf.title}" (${out.duplicateOf.path})` : "no duplicate found");
  }

  const signs = spamSigns(f, isPublic ? sub.submitter : null);
  if (signs.length) out.notes.push(`spam signs: ${signs.join("; ")}`);

  // The model's view, fast tier first and once more on the mid tier if it is unsure.
  // Posters the admin collected are not checked for spam: the admin chose them.
  if (f.title && isPublic) {
    for (const tier of ["fast", "mid"] as const) {
      try {
        const [res] = await llm.run([screenRequest(tier, f, isPublic ? sub.submitter : null, city?.name ?? "", today)], { jobName: opts.jobName, subBudget: opts.subBudget });
        out.modelUsd += res?.usd ?? 0;
        if (res?.ok && res.data) {
          out.model = { spam: res.data.spam, plausible: res.data.plausible_event, confidence: res.data.confidence, reason: res.data.reason, tier };
          if (res.data.confidence >= ingestion.fastTierMinConfidence) break;
        }
      } catch (err) {
        // The model's view is advice for the reviewer: without it the submission still reaches the queue.
        out.notes.push((err as Error).name === "BudgetExceededError" ? "model check skipped: budget limit reached" : `model check failed: ${(err as Error).message.slice(0, 160)}`);
        break;
      }
    }
    if (out.model) out.notes.push(`model (${out.model.tier}): ${out.model.spam ? "spam" : "not spam"}, ${out.model.plausible ? "plausible" : "not plausible"} (${out.model.confidence.toFixed(2)}): ${out.model.reason}`);
  }

  const modelSpam = !!out.model && out.model.spam && out.model.confidence >= ingestion.fastTierMinConfidence;
  if (modelSpam || signs.length >= 2) out.verdict = "likely_spam";
  else if (out.missing.length || signs.length || out.duplicateOf || !out.notes.includes("date plausible") || (out.model && !out.model.plausible)) out.verdict = "needs_checking";
  out.modelUsd = Number(out.modelUsd.toFixed(5));
  return out;
}

const VERDICT_TEXT: Record<Screening["verdict"], string> = { looks_fine: "looks fine", needs_checking: "needs checking", likely_spam: "likely spam" };
const CHANNEL_TEXT: Record<SubmissionRow["channel"], string> = { form: "form", poster: "snapped poster", admin: "poster inbox", email: "poster email" };

/** Screens a submission and puts it in the review queue with the notes. */
export async function queueSubmission(
  pool: Pool, llm: LlmClient, id: number, opts: { jobName: string; subBudget?: SubBudget },
): Promise<Screening> {
  const sub = await getSubmission(id, pool);
  if (!sub) throw new Error(`submission ${id} not found`);
  const s = await screen(pool, llm, sub, opts);
  await pool.query(
    "UPDATE submissions SET status = 'pending', screening = $2, form_errors = NULL, submitted_at = now(), updated_at = now() WHERE id = $1", [id, s]);
  await pool.query(
    "INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('submission', $1, $2, $3)",
    [id, sub.fields.for_event
      ? `Practical details for "${sub.fields.title}" via ${CHANNEL_TEXT[sub.channel]}: ${VERDICT_TEXT[s.verdict]}`
      : `New event via ${CHANNEL_TEXT[sub.channel]}: ${VERDICT_TEXT[s.verdict]}`,
    { title: sub.fields.title, date: sub.fields.date, screening: s.notes, ...(sub.fields.for_event ? { practical: sub.fields.practical ?? {} } : {}) }]);
  if (sub.poster_id) await keepPosterUntilEvent(pool, sub.poster_id, sub.fields.end_date || sub.fields.date);
  return s;
}

/** A bot that filled the hidden field: recorded and rejected, never queued, so a flood cannot bury the queue. */
export async function rejectAsBot(pool: Pool, id: number): Promise<void> {
  await pool.query(
    `UPDATE submissions SET status = 'rejected', screening = $2, submitted_at = now(), decided_at = now(), updated_at = now() WHERE id = $1`,
    [id, { verdict: "likely_spam", notes: ["hidden honeypot field was filled in: rejected automatically"], missing: [], duplicateOf: null, model: null, modelUsd: 0 }]);
  await pool.query("UPDATE poster_images SET delete_after = now() WHERE id = (SELECT poster_id FROM submissions WHERE id = $1)", [id]);
}

/** Poster photos are kept until the day after the event, then deleted by housekeeping. */
export async function keepPosterUntilEvent(pool: Pool, posterId: number, date: string | null | undefined): Promise<void> {
  if (date && isIsoDate(date)) {
    await pool.query(
      `UPDATE poster_images SET delete_after = greatest(($2::date + $3::int + 1)::timestamp AT TIME ZONE 'Asia/Kolkata', now() + interval '1 day') WHERE id = $1`,
      [posterId, date, cfg.keepDaysAfterEvent]);
  } else {
    await pool.query("UPDATE poster_images SET delete_after = now() + make_interval(days => $2) WHERE id = $1", [posterId, cfg.keepDaysUnused]);
  }
}

// ---------------------------------------------------------------- approval

function manualContext(cityId: number, cityName: string, timeZone: string): PostContext {
  return {
    rawPostId: 0, sourceKind: "submission", handle: "", postUrl: "", postedAt: new Date(), shortcode: "",
    cityId, cityName, timeZone, taggedHandles: [],
  };
}

const sure = <T>(value: T | null) => ({ value, confidence: value === null || value === "" ? 0 : 1 });

/** Checked fields in the shape the ingestion pipeline uses, every stated fact at full confidence. */
export function asExtracted(f: SubmissionFields, cityName: string): ExtractedEvent {
  return {
    announcement: "new_event",
    title: sure(f.title || null), start_date: sure(f.date || null), start_time: sure(f.start_time || null),
    end_date: sure(f.end_date || null), end_time: sure(f.end_time || null), venue_name: sure(f.venue || null),
    venue_instagram_handle: null, city: sure(cityName), area: sure(f.area || null), price_text: sure(f.is_free ? null : f.price || null),
    is_free: sure(f.is_free ? true : null), booking_url: sure(f.booking_url || null),
    performers: f.performers.split(/,|\n/).map((n) => n.trim()).filter(Boolean).slice(0, 12).map((name) => ({ name, kind: "person" as const, confidence: 1 })),
    organiser: sure(f.organiser || null), organiser_instagram_handle: null, category: sure(f.category || null),
    practical: formFacts(f.practical).map((p) => ({ ...p, key: p.key as FactKey })),
  };
}

export interface ApprovedEvent { eventId: number; path: string; published: boolean; descriptionUsd: number }

export interface EventSource {
  type: "submission" | "poster" | "instagram" | "web";
  url: string | null;
  submissionId?: number | null;
  rawPostId?: number | null;
  origin: "submitted" | "scraped";
}

/**
 * Creates an event from checked facts (an approved submission, or a queued
 * post the admin has corrected), writes its description and publishes it.
 * Matching of venues, performers and organisers is the ingestion pipeline's.
 */
export async function createCheckedEvent(
  pool: Pool, llm: LlmClient, cityId: number, f: SubmissionFields, source: EventSource, opts: { jobName: string },
): Promise<ApprovedEvent> {
  const city = (await pool.query<{ name: string; slug: string; timezone: string }>("SELECT name, slug, timezone FROM cities WHERE id = $1", [cityId])).rows[0];
  if (!city) throw new Error("unknown city");
  if (!f.title || !isIsoDate(f.date) || !f.venue) throw new Error("title, a valid date and the venue are needed to publish");
  const e = asExtracted(f, city.name);
  const ctx = manualContext(cityId, city.name, city.timezone);
  const client = await pool.connect();
  let eventId: number, slug: string;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(72001, $1)", [cityId]);
    const venueId = (await matchVenue(client, ctx, e, true))!;
    if (f.venue_address) {
      await client.query("UPDATE venues SET address = $2, updated_at = now() WHERE id = $1 AND address IS NULL", [venueId, f.venue_address]);
    }
    const t = timing(e, city.timezone);
    slug = await uniqueSlug(client, "events", `${slugify(f.title)}-${t.date}`, cityId);
    const ins = await client.query<{ id: number }>(
      `INSERT INTO events (city_id, venue_id, category_id, slug, title, starts_at, ends_at, local_date, start_time_known,
         price_text, is_free, booking_url, confidence, is_published, last_verified_at, origin, city_checked)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,false,now(),$13,true) RETURNING id`,
      [cityId, venueId, await categoryId(client, e), slug, f.title, t.startsAt, t.endsAt, t.date, t.timeKnown,
        f.is_free ? null : f.price || null, f.is_free ? true : f.price ? false : null, f.booking_url || null, source.origin]);
    eventId = ins.rows[0].id;
    await client.query(
      "INSERT INTO sources (event_id, source_type, raw_post_id, url, submission_id) VALUES ($1,$2,$3,$4,$5)",
      [eventId, source.type, source.rawPostId ?? null, source.url, source.submissionId ?? null]);
    await attachPeople(client, eventId, e);
    // Practical details as checked by the reviewer: a post's are credited to the post, a submission's to the organiser.
    await storeFacts(client, eventId, formFacts(f.practical), {
      type: source.type === "instagram" || source.type === "web" ? "post" : "organiser",
      url: source.url, rawPostId: source.rawPostId ?? null, submissionId: source.submissionId ?? null,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  let written = { written: 0, modelUsd: 0 };
  try {
    written = await writeDescriptions(pool, llm, { jobName: opts.jobName, eventIds: [eventId] });
  } catch (err) {
    // The event exists either way, so approving again must not create a second one: park it for review instead.
    await pool.query("INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('event', $1, 'description could not be written', $2)",
      [eventId, { error: (err as Error).message.slice(0, 300) }]);
    await pool.query("UPDATE events SET description = '', updated_at = now() WHERE id = $1", [eventId]);
  }
  return { eventId, path: `/${city.slug}/events/${slug}`, published: written.written === 1, descriptionUsd: written.modelUsd };
}

/** Approves a pending submission: it becomes a published event with origin "submitted". */
export async function approveSubmission(
  pool: Pool, llm: LlmClient, id: number, opts: { jobName: string; fields?: SubmissionFields; cityId?: number },
): Promise<ApprovedEvent> {
  const sub = await getSubmission(id, pool);
  if (!sub) throw new Error(`submission ${id} not found`);
  if (sub.status === "approved") throw new Error("already approved");
  const fields = opts.fields ?? sub.fields;
  const cityId = opts.cityId ?? sub.city_id;
  if (!cityId) throw new Error("the submission has no city");
  if (opts.fields) await pool.query("UPDATE submissions SET fields = $2, city_id = $3, updated_at = now() WHERE id = $1", [id, fields, cityId]);
  if (fields.for_event) return approveFacts(pool, id, fields);
  const fromPoster = sub.channel !== "form";
  const out = await createCheckedEvent(pool, llm, cityId, fields, {
    type: fromPoster ? "poster" : "submission",
    // The organiser's own Instagram post is linked as the source; a poster photo never is (it is not ours to show).
    url: fields.instagram_url || null,
    submissionId: id, origin: "submitted",
  }, opts);
  await pool.query("UPDATE submissions SET status = 'approved', event_id = $2, decided_at = now(), updated_at = now() WHERE id = $1", [id, out.eventId]);
  await pool.query(
    `UPDATE review_queue SET status = 'approved', resolved_at = now(), resolution_note = $2 WHERE item_type = 'submission' AND item_id = $1 AND status = 'open'`,
    [id, `published as ${out.path}`]);
  if (sub.poster_id) await keepPosterUntilEvent(pool, sub.poster_id, fields.end_date || fields.date);
  return out;
}

/** Approves practical details sent for an event already listed: they are stored as the organiser's answers. */
async function approveFacts(pool: Pool, id: number, fields: SubmissionFields): Promise<ApprovedEvent> {
  const ev = (await pool.query<{ id: number; path: string }>(
    "SELECT e.id, '/' || c.slug || '/events/' || e.slug AS path FROM events e JOIN cities c ON c.id = e.city_id WHERE e.id = $1", [fields.for_event])).rows[0];
  if (!ev) throw new Error("the event these details are for no longer exists");
  const stored = await storeFacts(pool, ev.id, formFacts(fields.practical), { type: "organiser", submissionId: id });
  await pool.query("UPDATE submissions SET status = 'approved', event_id = $2, decided_at = now(), updated_at = now() WHERE id = $1", [id, ev.id]);
  await pool.query(
    `UPDATE review_queue SET status = 'approved', resolved_at = now(), resolution_note = $2 WHERE item_type = 'submission' AND item_id = $1 AND status = 'open'`,
    [id, `${stored.stored} practical detail(s) saved on ${ev.path}`]);
  return { eventId: ev.id, path: ev.path, published: true, descriptionUsd: 0 };
}

export async function rejectSubmission(pool: Pool, id: number, note: string): Promise<void> {
  await pool.query("UPDATE submissions SET status = 'rejected', decided_at = now(), updated_at = now() WHERE id = $1 AND status <> 'approved'", [id]);
  await pool.query(
    "UPDATE review_queue SET status = 'rejected', resolved_at = now(), resolution_note = $2 WHERE item_type = 'submission' AND item_id = $1 AND status = 'open'",
    [id, note || "rejected"]);
  // The photo is no longer needed for review.
  await pool.query("UPDATE poster_images SET delete_after = least(delete_after, now() + interval '1 day') WHERE id = (SELECT poster_id FROM submissions WHERE id = $1)", [id]);
}
