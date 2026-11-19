/**
 * Practical facts (Prompt 11): the answers people look for before going to an
 * event (age limit, entry rules, doors, seating, parking...). Only facts a
 * source states are stored, each with that source; an unknown fact is simply
 * left out, never guessed (hard rule 3).
 *
 * Venue-level facts (parking, accessibility, how to reach) are stored on the
 * venue and shown on every event there.
 *
 * Who wins when two sources answer the same question:
 *   - a scraped post or page only fills a question nobody has answered yet;
 *   - the organiser (a reviewed submission) replaces a post's answer;
 *   - the admin replaces anything.
 */
import type { Pool, PoolClient } from "pg";
import { ingestion, type Locale } from "../config";
import { isClockTime } from "./pipeline/text";

export const EVENT_FACT_KEYS = [
  "doors_time", "age_limit", "entry_rules", "seating", "indoor_outdoor", "language", "food_drink", "dress_code", "refund_policy",
] as const;
export const VENUE_FACT_KEYS = ["accessibility", "parking", "how_to_reach"] as const;
export const FACT_KEYS = [...EVENT_FACT_KEYS, ...VENUE_FACT_KEYS] as const;
export type FactKey = (typeof FACT_KEYS)[number];

export const isFactKey = (k: string): k is FactKey => (FACT_KEYS as readonly string[]).includes(k);
export const isVenueFact = (k: FactKey) => (VENUE_FACT_KEYS as readonly string[]).includes(k);

/** One stated fact, as the extraction or a form gives it. */
export interface StatedFact { key: string; answer: string; confidence: number }

export type FactSourceType = "post" | "organiser" | "admin";
export interface FactSource { type: FactSourceType; url?: string | null; rawPostId?: number | null; submissionId?: number | null }

/** Answers that only say the fact is unknown are not facts. */
const NOT_A_FACT = /^(n\/?a|none|null|unknown|not (stated|mentioned|given|specified|provided|known|announced)|tba|tbd|-+)\.?$/i;

/** A stored answer: tidied, of a sensible length, and in the right shape for its question. Null when it is not usable. */
export function cleanAnswer(key: FactKey, raw: string | null | undefined): string | null {
  const text = (raw ?? "").replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "");
  if (!text || NOT_A_FACT.test(text)) return null;
  if (key === "doors_time") {
    // "7:30 PM" is accepted from a form as well as "19:30".
    const m = text.match(/^(\d{1,2})[:.](\d{2})\s*([ap])\.?m\.?$/i);
    if (m) {
      const h = (Number(m[1]) % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
      const t = `${String(h).padStart(2, "0")}:${m[2]}`;
      return isClockTime(t) ? t : null;
    }
    const t = text.length === 4 ? `0${text}` : text;
    return isClockTime(t) ? t : null;
  }
  return text.length > 240 ? `${text.slice(0, 237).replace(/\s+\S*$/, "")}…` : text;
}

type Db = Pool | PoolClient;

export interface StoreReport { stored: number; skipped: number }

/**
 * Stores the stated facts for an event (and its venue, for venue-level facts).
 * A post's answer below the publishing confidence is not stored.
 */
export async function storeFacts(db: Db, eventId: number, facts: StatedFact[] | null | undefined, source: FactSource): Promise<StoreReport> {
  const report: StoreReport = { stored: 0, skipped: 0 };
  if (!facts?.length) return report;
  const venueId = (await db.query<{ venue_id: number | null }>("SELECT venue_id FROM events WHERE id = $1", [eventId])).rows[0]?.venue_id ?? null;
  const seen = new Set<string>();
  for (const f of facts) {
    if (!isFactKey(f.key) || seen.has(f.key)) { report.skipped++; continue; }
    seen.add(f.key);
    if (source.type === "post" && !(f.confidence >= ingestion.publishConfidence)) { report.skipped++; continue; }
    const answer = cleanAnswer(f.key, f.answer);
    const onVenue = isVenueFact(f.key);
    if (!answer || (onVenue && !venueId)) { report.skipped++; continue; }
    const res = await db.query(
      `INSERT INTO practical_facts (entity_type, entity_id, fact_key, answer, source_type, source_url, raw_post_id, submission_id, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (entity_type, entity_id, fact_key) DO UPDATE SET
         answer = EXCLUDED.answer, source_type = EXCLUDED.source_type, source_url = EXCLUDED.source_url,
         raw_post_id = EXCLUDED.raw_post_id, submission_id = EXCLUDED.submission_id, confidence = EXCLUDED.confidence, updated_at = now()
       WHERE EXCLUDED.source_type <> 'post'
         AND NOT (practical_facts.source_type = 'admin' AND EXCLUDED.source_type = 'organiser')
         AND practical_facts.answer IS DISTINCT FROM EXCLUDED.answer`,
      [onVenue ? "venue" : "event", onVenue ? venueId : eventId, f.key, answer, source.type, source.url || null,
        source.rawPostId || null, source.submissionId || null, Math.min(1, Math.max(0, Number(f.confidence) || 0))]);
    if (res.rowCount) report.stored++; else report.skipped++;
  }
  // The page, its "Updated" line and the IndexNow ping all follow the event's updated_at.
  if (report.stored) {
    await db.query(
      "UPDATE events SET updated_at = now() WHERE id = $1 OR ($2::bigint IS NOT NULL AND venue_id = $2 AND is_published)", [eventId, venueId]);
  }
  return report;
}

/** Facts from a form, keyed by question, as a list the store understands. Form facts are stated by a person: full confidence. */
export function formFacts(practical: Partial<Record<string, string>> | null | undefined): StatedFact[] {
  return Object.entries(practical ?? {}).filter(([k, v]) => isFactKey(k) && v && v.trim()).map(([key, answer]) => ({ key, answer: answer!, confidence: 1 }));
}

/** Moves one event's or venue's answers to another (when duplicates are merged); the kept row's own answers win. */
export async function moveFacts(db: Db, type: "event" | "venue", fromId: number, toId: number): Promise<void> {
  await db.query(
    `UPDATE practical_facts SET entity_id = $3, updated_at = now() WHERE entity_type = $1 AND entity_id = $2
       AND fact_key NOT IN (SELECT fact_key FROM practical_facts WHERE entity_type = $1 AND entity_id = $3)`, [type, fromId, toId]);
  await db.query("DELETE FROM practical_facts WHERE entity_type = $1 AND entity_id = $2", [type, fromId]);
}

/** One answer as a page shows it: in the page's language where translated, with where it came from. */
export interface FactAnswer {
  key: FactKey;
  answer: string;
  source: { type: FactSourceType | "listing"; url: string | null };
}

/**
 * The answers for an event page: the event's own, then its venue's. A venue's parking and
 * directions found by enrichment are used when no post or organiser has answered, with the
 * page they came from as the source.
 */
export async function eventFacts(pool: Pool, eventId: number, venueId: number | null, locale: Locale): Promise<FactAnswer[]> {
  const answer = locale === "en" ? "pf.answer"
    : `coalesce((SELECT tx.text FROM translations tx WHERE tx.entity_type = 'practical_fact' AND tx.entity_id = pf.id
         AND tx.locale = '${locale}' AND tx.field = 'answer' AND tx.source_hash = md5(pf.answer)), pf.answer)`;
  const { rows } = await pool.query<{ key: FactKey; answer: string; type: FactSourceType; url: string | null }>(
    `SELECT pf.fact_key AS key, ${answer} AS answer, pf.source_type AS type, pf.source_url AS url FROM practical_facts pf
     WHERE (pf.entity_type = 'event' AND pf.entity_id = $1) OR (pf.entity_type = 'venue' AND pf.entity_id = $2)`, [eventId, venueId]);
  const out: FactAnswer[] = rows.filter((r) => isFactKey(r.key)).map((r) => ({ key: r.key, answer: r.answer, source: { type: r.type, url: r.url } }));
  if (venueId) {
    const venueText = (field: string) => locale === "en" ? `v.${field}`
      : `coalesce((SELECT tx.text FROM translations tx WHERE tx.entity_type = 'venue' AND tx.entity_id = v.id AND tx.locale = '${locale}'
           AND tx.field = '${field}' AND tx.source_hash = md5(v.${field})), v.${field})`;
    const v = (await pool.query<{ parking: string | null; how_to_reach: string | null; parking_url: string | null; reach_url: string | null }>(
      `SELECT ${venueText("parking")} AS parking, ${venueText("how_to_reach")} AS how_to_reach,
              (SELECT es.url FROM entity_sources es WHERE es.entity_type = 'venue' AND es.entity_id = v.id AND es.field = 'parking' ORDER BY es.id LIMIT 1) AS parking_url,
              (SELECT es.url FROM entity_sources es WHERE es.entity_type = 'venue' AND es.entity_id = v.id AND es.field = 'how_to_reach' ORDER BY es.id LIMIT 1) AS reach_url
       FROM venues v WHERE v.id = $1`, [venueId])).rows[0];
    // Only with a recorded source: a fact we cannot trace is not shown as an answer.
    if (v?.parking && v.parking_url && !out.some((f) => f.key === "parking")) out.push({ key: "parking", answer: v.parking, source: { type: "listing", url: v.parking_url } });
    if (v?.how_to_reach && v.reach_url && !out.some((f) => f.key === "how_to_reach")) out.push({ key: "how_to_reach", answer: v.how_to_reach, source: { type: "listing", url: v.reach_url } });
  }
  const order = FACT_KEYS as readonly string[];
  return out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/**
 * The admin's own answers for one event (and its venue): a changed box replaces the answer, an emptied box
 * removes it, an unchanged box is left with its original source. Returns what changed, in words.
 */
export async function setFactsByAdmin(pool: Pool, eventId: number, practical: Partial<Record<string, string>>): Promise<string[]> {
  const ev = (await pool.query<{ venue_id: number | null }>("SELECT venue_id FROM events WHERE id = $1", [eventId])).rows[0];
  if (!ev) throw new Error("event not found");
  const before = await storedFacts(pool, eventId);
  const changes: string[] = [];
  for (const key of FACT_KEYS) {
    const raw = (practical[key] ?? "").trim();
    const was = before[key];
    const onVenue = isVenueFact(key);
    if (!raw) {
      if (was) {
        await pool.query("DELETE FROM practical_facts WHERE entity_type = $1 AND entity_id = $2 AND fact_key = $3",
          [onVenue ? "venue" : "event", onVenue ? ev.venue_id : eventId, key]);
        changes.push(`${key} removed`);
      }
      continue;
    }
    const answer = cleanAnswer(key, raw);
    if (!answer) throw new Error(key === "doors_time" ? "Doors open must be a time such as 19:30." : `The ${key.replace(/_/g, " ")} answer is not usable.`);
    if (answer === was) continue;
    if (onVenue && !ev.venue_id) throw new Error("This event has no venue, so venue details cannot be stored.");
    await pool.query(
      `INSERT INTO practical_facts (entity_type, entity_id, fact_key, answer, source_type, confidence) VALUES ($1,$2,$3,$4,'admin',1)
       ON CONFLICT (entity_type, entity_id, fact_key) DO UPDATE SET answer = EXCLUDED.answer, source_type = 'admin', source_url = NULL,
         raw_post_id = NULL, submission_id = NULL, confidence = 1, updated_at = now()`,
      [onVenue ? "venue" : "event", onVenue ? ev.venue_id : eventId, key, answer]);
    changes.push(`${key} ${was ? "changed" : "added"}`);
  }
  if (changes.length) {
    await pool.query("UPDATE events SET updated_at = now() WHERE id = $1 OR ($2::bigint IS NOT NULL AND venue_id = $2 AND is_published)", [eventId, ev.venue_id]);
    await pool.query("INSERT INTO event_actions (event_id, action, reason) VALUES ($1, 'edited', $2)", [eventId, `practical details: ${changes.join(", ")}`]);
  }
  return changes;
}

/** The answers stored for one event and its venue, in English, for the admin and the submission form. */
export async function storedFacts(pool: Pool, eventId: number): Promise<Partial<Record<FactKey, string>>> {
  const { rows } = await pool.query<{ key: string; answer: string }>(
    `SELECT pf.fact_key AS key, pf.answer FROM practical_facts pf JOIN events e ON e.id = $1
     WHERE (pf.entity_type = 'event' AND pf.entity_id = e.id) OR (pf.entity_type = 'venue' AND pf.entity_id = e.venue_id)`, [eventId]);
  const out: Partial<Record<FactKey, string>> = {};
  for (const r of rows) if (isFactKey(r.key)) out[r.key] = r.answer;
  return out;
}
