/**
 * Writes the event description and publishes the event. The writer is given
 * the extracted facts only, never the caption or article, so the text cannot
 * copy the source (hard rule 4). Events wait unpublished until this succeeds,
 * so a run that stops early is simply picked up by the next one.
 */
import { z } from "zod";
import type { Pool } from "pg";
import { ingestion, type SubBudget } from "../../config";
import type { LlmClient, LlmRequest } from "./llm";
import { wordCount } from "./text";

const DescriptionSchema = z.object({ description: z.string() });
type Description = z.infer<typeof DescriptionSchema>;

const SYSTEM = `You write short event descriptions for a city events guide in India.

Write ${ingestion.description.minWords} to ${ingestion.description.maxWords} words of plain, factual English prose in one paragraph, from the facts given and nothing else.
- State what the event is, who is performing or hosting, when and where it is, and what it costs, in that rough order.
- Use only the facts provided. Do not add background about the artists or venue, do not describe the atmosphere, and do not predict what the evening will be like. If a fact is not given (price, time, end time, performers), leave it out without comment: never write that something is unknown, not provided, not given or not announced.
- Write dates in full ("Saturday, 22 November 2026") and times as "8:00 PM". Mention the city.
- Neutral tone: no hype, no exclamation marks, no second-person address, no calls to action.
- If there are too few facts to reach the length honestly, write fewer words rather than padding.`;

export interface PendingEvent {
  id: number; title: string; starts_at: Date; ends_at: Date | null; start_time_known: boolean;
  price_text: string | null; is_free: boolean | null; has_booking: boolean;
  venue: string | null; area: string | null; city: string; timezone: string; category: string | null;
  performers: string[] | null; organisers: string[] | null;
}

/**
 * The end, as the source gave it. 11:59 PM is how a stated end date with no end time is stored:
 * it is not a time anyone announced, so only the date is passed on (nothing, when it is the start day).
 */
function endLine(e: PendingEvent, day: (d: Date) => string, time: (d: Date) => string): string | null {
  if (!e.ends_at) return null;
  const sameDay = day(e.ends_at) === day(e.starts_at);
  if (time(e.ends_at) === "11:59 PM") return sameDay ? null : `Ends: ${day(e.ends_at)}`;
  return `Ends: ${sameDay ? time(e.ends_at) : `${day(e.ends_at)}, ${time(e.ends_at)}`}`;
}

/** Sentences that only say a fact is missing ("No ticket price has been provided."). */
const MISSING = /\b(not (been )?(provided|given|announced|specified|stated|mentioned|listed|disclosed|shared)|(is|are) (unknown|unspecified|yet to be (announced|confirmed))|no (details|information) (on|about|regarding))\b|^\s*no\b[^.!?]*\b(has|have) been (provided|given|announced|specified|stated|mentioned|listed|shared)\b/i;

/** Drops sentences that only report a missing fact; the writer is told not to write them, but sometimes does. */
export function dropMissingFactSentences(text: string): string {
  return (text.match(/[^.!?]+[.!?]*/g) ?? [text]).filter((s) => !MISSING.test(s)).join("").replace(/\s+/g, " ").trim();
}

export function facts(e: PendingEvent): string {
  const day = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: e.timezone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
  const time = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: e.timezone, hour: "numeric", minute: "2-digit" }).format(d);
  const lines = [
    `Event name: ${e.title}`,
    `Date: ${day(e.starts_at)}`,
    e.start_time_known ? `Start time: ${time(e.starts_at)}` : null,
    endLine(e, day, time),
    `Venue: ${e.venue}`,
    e.area ? `Area: ${e.area}` : null,
    `City: ${e.city}`,
    e.category ? `Type of event: ${e.category}` : null,
    e.performers?.length ? `Performers: ${e.performers.join(", ")}` : null,
    e.organisers?.length ? `Organised by: ${e.organisers.join(", ")}` : null,
    e.is_free ? "Entry: free" : e.price_text ? `Price: ${e.price_text}` : null,
    e.has_booking ? "Booking: through the official booking page linked on the listing" : null,
  ];
  return lines.filter(Boolean).join("\n");
}

function request(e: PendingEvent): LlmRequest<Description> {
  const text = facts(e);
  return {
    id: String(e.id), tier: "mid", system: SYSTEM, content: [{ type: "text", text }], schema: DescriptionSchema,
    maxTokens: 2000, effort: "low", estInputTokens: 330 + Math.ceil(text.length / 3), estOutputTokens: 350,
  };
}

/** Rough per-description request for dry-run estimates. */
export function descriptionEstimate(id: string): LlmRequest<Description> {
  return {
    id, tier: "mid", system: SYSTEM, content: [], schema: DescriptionSchema,
    maxTokens: 2000, effort: "low", estInputTokens: 450, estOutputTokens: 350,
  };
}

/** The facts a description is written from, for the events a WHERE clause picks. */
const EVENT_FACTS = `SELECT e.id, e.title, e.starts_at, e.ends_at, e.start_time_known, e.price_text, e.is_free,
            e.booking_url IS NOT NULL AS has_booking, v.name AS venue, a.name AS area, c.name AS city, c.timezone,
            cat.name AS category,
            (SELECT array_agg(ar.name ORDER BY ea.billing_order) FROM event_artists ea JOIN artists ar ON ar.id = ea.artist_id WHERE ea.event_id = e.id) AS performers,
            (SELECT array_agg(o.name) FROM event_organisers eo JOIN organisers o ON o.id = eo.organiser_id WHERE eo.event_id = e.id) AS organisers
     FROM events e JOIN cities c ON c.id = e.city_id
     LEFT JOIN venues v ON v.id = e.venue_id LEFT JOIN areas a ON a.id = v.area_id LEFT JOIN categories cat ON cat.id = e.category_id`;

export interface WriteReport { written: number; failed: number; modelUsd: number }

/**
 * Without `eventIds`: every scraped event waiting for its text (the ingest job).
 * With `eventIds`: just those events, whatever their origin (an approved submission).
 */
export async function writeDescriptions(
  pool: Pool, llm: LlmClient, opts: { jobName: string; batch?: boolean; eventIds?: number[]; subBudget?: SubBudget },
): Promise<WriteReport> {
  const which = opts.eventIds ? "e.id = ANY($1::bigint[])" : "e.origin = 'scraped' AND e.confidence >= $1";
  const { rows } = await pool.query<PendingEvent>(
    `${EVENT_FACTS}
     WHERE ${which} AND NOT e.is_published AND e.description IS NULL AND e.status = 'scheduled'
     ORDER BY e.id`,
    [opts.eventIds ?? ingestion.publishConfidence],
  );
  const report: WriteReport = { written: 0, failed: 0, modelUsd: 0 };
  if (rows.length === 0) return report;
  const results = await llm.run(rows.map(request), { jobName: opts.jobName, batch: opts.batch, subBudget: opts.subBudget });
  for (const r of results) {
    report.modelUsd += r.usd;
    // Charged to the event's first source, so cost per published event can be reported by source.
    if (r.usd > 0) {
      await pool.query(
        `UPDATE raw_posts SET model_usd = model_usd + $2
         WHERE id = (SELECT raw_post_id FROM sources WHERE event_id = $1 AND raw_post_id IS NOT NULL ORDER BY id LIMIT 1)`,
        [Number(r.id), r.usd]);
    }
    const text = r.data ? dropMissingFactSentences(r.data.description.trim().replace(/\s+/g, " ")) : undefined;
    // Tolerate a little drift either side of the target; anything further off is not published.
    const words = text ? wordCount(text) : 0;
    if (!r.ok || !text || words < 35 || words > ingestion.description.maxWords + 30) {
      report.failed++;
      await pool.query(
        "INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('event', $1, $2, $3)",
        [Number(r.id), "description could not be written", { error: r.error ?? `description was ${words} words`, text: text ?? null }]);
      // Park it so later runs do not pay to retry; approving the review item publishes it.
      await pool.query("UPDATE events SET description = '', updated_at = now() WHERE id = $1", [Number(r.id)]);
      continue;
    }
    await pool.query(
      "UPDATE events SET description = $2, is_published = true, last_verified_at = now(), updated_at = now() WHERE id = $1",
      [Number(r.id), text]);
    report.written++;
  }
  return report;
}

/**
 * Writes the text again for one event whose facts were corrected after it was published.
 * Nothing about the event is changed here: the caller stores the text. When no usable text
 * comes back, `text` is null and `error` says why, and the old text stays where it is.
 */
export async function rewriteDescription(
  pool: Pool, llm: LlmClient, eventId: number, opts: { jobName: string; subBudget?: SubBudget },
): Promise<{ text: string | null; usd: number; error?: string }> {
  const { rows } = await pool.query<PendingEvent>(`${EVENT_FACTS}
     WHERE e.id = $1`, [eventId]);
  if (rows.length === 0) return { text: null, usd: 0, error: "the event was not found" };
  const [r] = await llm.run([request(rows[0])], { jobName: opts.jobName, subBudget: opts.subBudget });
  if (!r) return { text: null, usd: 0, error: "the model gave no answer" };
  const text = r.data ? dropMissingFactSentences(r.data.description.trim().replace(/\s+/g, " ")) : "";
  const words = text ? wordCount(text) : 0;
  if (!r.ok || !text || words < 35 || words > ingestion.description.maxWords + 30) {
    return { text: null, usd: r.usd, error: r.error ?? `the new description was ${words} words` };
  }
  return { text, usd: r.usd };
}
