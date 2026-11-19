/**
 * Correcting an event after it has been published (owner's request, 19 Nov 2026):
 * a wrong date, time, title, venue, price, booking link or category, from the admin area.
 *
 *   - The reason is required and kept in `event_actions` with what changed, like a
 *     cancellation or a takedown.
 *   - The event's address carries its title and date. When either is corrected the
 *     address changes with it and the old address becomes a permanent redirect
 *     (`event_redirects`), so a link or a citation of the old page still arrives.
 *   - The description states the date and place in words, so it is written again from
 *     the corrected facts by the same writer that wrote it (one small model call), unless
 *     the admin rewrote the text by hand. If it cannot be written, the facts are saved
 *     anyway and the caller is told the text still needs correcting.
 *   - Sources, performers and organisers are left as they are.
 */
import type { Pool } from "pg";
import type { LlmClient } from "./pipeline/llm";
import { categoryId, matchVenue, timing, uniqueSlug, type PostContext } from "./pipeline/resolve";
import { isClockTime, isIsoDate, localDate, slugify } from "./pipeline/text";
import { rewriteDescription } from "./pipeline/write";
import { asExtracted, emptyFields, type SubmissionFields } from "./submissions";

export interface EditableEvent {
  id: number; city_id: number; city_slug: string; city_name: string; timezone: string; slug: string; title: string;
  starts_at: Date; ends_at: Date | null; local_date: string | null; start_time_known: boolean;
  price_text: string | null; is_free: boolean | null; booking_url: string | null; category: string | null;
  venue_id: number | null; venue: string | null; description: string | null; status: string; is_published: boolean;
}

const SELECT = `SELECT e.id, e.city_id, c.slug AS city_slug, c.name AS city_name, c.timezone, e.slug, e.title, e.starts_at, e.ends_at,
    e.local_date::text, e.start_time_known, e.price_text, e.is_free, e.booking_url, cat.slug AS category, e.venue_id, v.name AS venue,
    e.description, e.status, e.is_published
  FROM events e JOIN cities c ON c.id = e.city_id LEFT JOIN venues v ON v.id = e.venue_id LEFT JOIN categories cat ON cat.id = e.category_id
  WHERE e.id = $1`;

type Queryable = Pick<Pool, "query">;

export async function loadEvent(db: Queryable, id: number): Promise<EditableEvent | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  return (await db.query<EditableEvent>(SELECT, [id])).rows[0] ?? null;
}

const clock = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const dateOf = (e: EditableEvent) => e.local_date ?? localDate(e.starts_at, e.timezone);
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The event's facts as the edit form shows them: the reverse of how they are stored. */
export function eventFields(e: EditableEvent): SubmissionFields {
  const f = emptyFields();
  f.title = e.title;
  f.date = dateOf(e);
  f.start_time = e.start_time_known ? clock(e.starts_at, e.timezone) : "";
  if (e.ends_at) {
    const endDate = localDate(e.ends_at, e.timezone);
    const endTime = clock(e.ends_at, e.timezone);
    // 11:59 PM is how a stated last day with no end time is stored: not a time anyone announced.
    const timeGiven = endTime !== "23:59";
    // "9 PM to 1 AM" is stored as ending the next day; it was entered as an end time only.
    const overnight = timeGiven && !!f.start_time && endDate === nextDay(f.date) && endTime <= f.start_time;
    f.end_date = endDate === f.date || overnight ? "" : endDate;
    f.end_time = timeGiven ? endTime : "";
  }
  f.venue = e.venue ?? "";
  f.category = e.category ?? "";
  f.price = e.is_free ? "" : e.price_text ?? "";
  f.is_free = e.is_free === true;
  f.booking_url = e.booking_url ?? "";
  return f;
}

/** A problem with what was typed in: shown to the admin as it is. */
export class EditError extends Error {}

export interface EditInput {
  fields: SubmissionFields;
  /** The description as it stands in the form. Used only when the admin changed it. */
  description: string;
  /** Write the description again from the corrected facts (one small model call) when they changed. */
  rewrite: boolean;
  reason: string;
}

export interface EditResult {
  path: string;
  /** The event's address before the edit, when the edit changed it. It now redirects to `path`. */
  movedFrom: string | null;
  changes: string[];
  description: "unchanged" | "edited by hand" | "rewritten" | "not rewritten";
  /** Why the description could not be rewritten. */
  descriptionError?: string;
}

const LABELS: [keyof SubmissionFields, string][] = [
  ["title", "title"], ["date", "date"], ["start_time", "start time"], ["end_date", "last day"], ["end_time", "end time"],
  ["venue", "venue"], ["category", "category"], ["price", "price"], ["is_free", "free entry"], ["booking_url", "booking link"],
];
const shown = (v: string | boolean | string[] | undefined) => (typeof v === "boolean" ? (v ? "yes" : "no") : v ? `"${v}"` : "none");
const oneLine = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function check(f: SubmissionFields, reason: string): void {
  if (!reason) throw new EditError("Give a reason: it is kept with the event.");
  if (!f.title) throw new EditError("The event needs a title.");
  if (!isIsoDate(f.date)) throw new EditError("The event needs a valid date.");
  if (!f.venue) throw new EditError("The event needs a venue.");
  if (f.start_time && !isClockTime(f.start_time)) throw new EditError("The start time is not a time of day.");
  if (f.end_time && !isClockTime(f.end_time)) throw new EditError("The end time is not a time of day.");
  if (f.end_time && !f.start_time && !f.end_date) throw new EditError("An end time needs a start time.");
  if (f.end_date && (!isIsoDate(f.end_date) || f.end_date < f.date)) throw new EditError("The last day cannot be before the first day.");
  if (f.booking_url && !/^https?:\/\/\S+\.\S+$/i.test(f.booking_url)) throw new EditError("The booking link must be a full web address (https://...).");
}

export async function editEvent(
  pool: Pool, llm: LlmClient, id: number, input: EditInput, opts: { jobName: string; now?: Date },
): Promise<EditResult> {
  const f = input.fields;
  const reason = oneLine(input.reason).slice(0, 600);
  check(f, reason);
  const typed = oneLine(input.description);

  const client = await pool.connect();
  let before: EditableEvent, after: EditableEvent, actionId: number;
  let movedFrom: string | null = null;
  const changes: string[] = [];
  let description: EditResult["description"] = "unchanged";
  try {
    await client.query("BEGIN");
    const found = await loadEvent(client, id);
    if (!found) throw new EditError("That event no longer exists.");
    before = found;
    await client.query("SELECT pg_advisory_xact_lock(72001, $1)", [before.city_id]);
    await client.query("SELECT 1 FROM events WHERE id = $1 FOR UPDATE", [id]);

    const e = asExtracted(f, before.city_name);
    const t = timing(e, before.timezone);

    // The same name keeps the same venue; another name is matched against the city's venues, or a new venue is made.
    let venueId = before.venue_id;
    if (!venueId || oneLine(before.venue).toLowerCase() !== f.venue.toLowerCase()) {
      const ctx: PostContext = {
        rawPostId: 0, sourceKind: "submission", handle: "", postUrl: "", postedAt: opts.now ?? new Date(), shortcode: "",
        cityId: before.city_id, cityName: before.city_name, timeZone: before.timezone, taggedHandles: [],
      };
      venueId = (await matchVenue(client, ctx, e, true))!;
    }

    // The address follows the title and the date. The old one is kept as a redirect.
    let slug = before.slug;
    const base = `${slugify(f.title)}-${t.date}`;
    if (base !== `${slugify(before.title)}-${dateOf(before)}`) {
      slug = await uniqueSlug(client, "events", base, before.city_id);
      // An event that returns to an address it had before takes it back.
      await client.query("DELETE FROM event_redirects WHERE city_id = $1 AND old_slug = $2", [before.city_id, slug]);
      await client.query(
        `INSERT INTO event_redirects (city_id, old_slug, event_id) VALUES ($1, $2, $3)
         ON CONFLICT (city_id, old_slug) DO UPDATE SET event_id = EXCLUDED.event_id, created_at = now()`,
        [before.city_id, before.slug, id]);
      movedFrom = `/${before.city_slug}/events/${before.slug}`;
    }

    // An event marked as over that is moved to today or later is on again.
    const today = localDate(opts.now ?? new Date(), before.timezone);
    const lastDay = t.endsAt ? localDate(t.endsAt, before.timezone) : t.date;
    const status = before.status === "happened" && lastDay >= today ? "scheduled" : before.status;

    const isFree = f.is_free ? true : f.price ? false : before.is_free === false ? false : null;
    await client.query(
      `UPDATE events SET title = $2, slug = $3, venue_id = $4, category_id = $5, starts_at = $6, ends_at = $7, local_date = $8,
         start_time_known = $9, price_text = $10, is_free = $11, booking_url = $12, status = $13,
         last_verified_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, f.title, slug, venueId, await categoryId(client, e), t.startsAt, t.endsAt, t.date, t.timeKnown,
        f.is_free ? null : f.price || null, isFree, f.booking_url || null, status]);

    after = (await loadEvent(client, id))!;
    const was = eventFields(before);
    const now = eventFields(after);
    for (const [key, label] of LABELS) {
      if (was[key] !== now[key]) changes.push(`${label}: ${shown(was[key])} to ${shown(now[key])}`);
    }

    // The admin's own words are used as they are; no model call is made for them.
    if (typed && typed !== oneLine(before.description)) {
      await client.query("UPDATE events SET description = $2 WHERE id = $1", [id, typed]);
      changes.push("description edited by hand");
      description = "edited by hand";
    }
    if (changes.length === 0) throw new EditError("Nothing was changed.");

    actionId = Number((await client.query<{ id: number }>(
      "INSERT INTO event_actions (event_id, action, reason) VALUES ($1, 'edited', $2) RETURNING id",
      [id, `${reason} (${changes.join("; ")})`.slice(0, 1000)])).rows[0].id);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const result: EditResult = { path: `/${after.city_slug}/events/${after.slug}`, movedFrom, changes, description };
  // The text states the date, time, place and price in words: after a correction it has to say the same as the facts.
  if (description === "unchanged" && input.rewrite && oneLine(before.description)) {
    try {
      const written = await rewriteDescription(pool, llm, id, { jobName: opts.jobName });
      if (written.text) {
        await pool.query("UPDATE events SET description = $2, updated_at = now() WHERE id = $1", [id, written.text]);
        await pool.query("UPDATE event_actions SET reason = left(reason || '; description rewritten', 1000) WHERE id = $1", [actionId]);
        result.description = "rewritten";
      } else {
        result.description = "not rewritten";
        result.descriptionError = written.error;
      }
    } catch (err) {
      result.description = "not rewritten";
      result.descriptionError = (err as Error).message.slice(0, 200);
    }
  }
  return result;
}
