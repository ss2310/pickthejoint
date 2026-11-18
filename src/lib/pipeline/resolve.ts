/**
 * Turns one post's extraction into database changes:
 *   - confident new events are matched to a venue, performers and organiser
 *     (rows are created when there is no match, flagged for enrichment),
 *     de-duplicated against existing events, and stored unpublished until
 *     their description is written (write.ts);
 *   - a second post about the same event is merged in as another source;
 *   - cancellation / postponement / change posts update the existing event;
 *   - anything uncertain goes to review_queue with the reason (hard rule 3).
 */
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { ingestion } from "../../config";
import type { ExtractedEvent, Extraction } from "./extract";
import type { LlmClient, LlmRequest } from "./llm";
import {
  daysBetween, diceSimilarity, handleKey, isClockTime, isIsoDate, localDate, nameKey, sameVenueKey, slugify, titleSimilarity, zonedToUtc,
} from "./text";

export interface PostContext {
  rawPostId: number;
  sourceKind: "instagram" | "google" | "news";
  /** Instagram handle or source key. */
  handle: string;
  handleType?: string;
  postUrl: string;
  postedAt: Date;
  shortcode: string;
  cityId: number;
  cityName: string;
  timeZone: string;
  taggedHandles: string[];
}

export interface ResolveCounts {
  created: number;
  merged: number;
  statusUpdates: number;
  queued: number;
  suggestedHandles: number;
  dedupModelUsd: number;
}

export type FinalState = "published" | "merged" | "queued_review" | "filtered_out";

type Db = Pool | PoolClient;
const HANDLE_RE = /^[a-z0-9._]{1,30}$/;
const cleanHandle = (h: string | null | undefined) => {
  const v = (h ?? "").trim().toLowerCase().replace(/^@/, "");
  return HANDLE_RE.test(v) ? v : null;
};
const ok = (f: { value: unknown; confidence: number }) => f.value !== null && f.value !== "" && f.confidence >= ingestion.publishConfidence;

/** Reasons this event cannot be published as extracted; empty means it can. */
export function gate(e: ExtractedEvent, ctx: Pick<PostContext, "postedAt" | "timeZone">): string[] {
  const reasons: string[] = [];
  if (!ok(e.title)) reasons.push("title missing or not confident");
  if (!ok(e.venue_name)) reasons.push("venue missing or not confident");
  if (!ok(e.start_date)) reasons.push("date missing or not confident");
  else if (!isIsoDate(e.start_date.value!)) reasons.push(`date "${e.start_date.value}" is not a valid date`);
  else {
    const gap = daysBetween(localDate(ctx.postedAt, ctx.timeZone), e.start_date.value!);
    if (gap < -1) reasons.push("event date is before the post date");
    if (gap > 365) reasons.push("event date is more than a year after the post");
  }
  return reasons;
}

async function queueReview(db: Db, ctx: PostContext, reason: string, e: ExtractedEvent | null, extra: Record<string, unknown> = {}) {
  await db.query(
    "INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('raw_post', $1, $2, $3)",
    [ctx.rawPostId, reason, { source: ctx.sourceKind, handle: ctx.handle, url: ctx.postUrl, event: e, ...extra }],
  );
}

async function uniqueSlug(db: Db, table: "venues" | "artists" | "organisers" | "events", base: string, cityId?: number): Promise<string> {
  const root = base || "untitled";
  const scoped = table === "venues" || table === "events";
  const { rows } = await db.query<{ slug: string }>(
    `SELECT slug FROM ${table} WHERE (slug = $1 OR slug LIKE $1 || '-%')${scoped ? " AND city_id = $2" : ""}`,
    scoped ? [root, cityId] : [root],
  );
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`;
}

interface Named { id: number; name: string; instagram: string | null }

/** Best existing row for a name: by Instagram handle, then exact key, then close spelling. */
function bestMatch(rows: Named[], name: string, handle: string | null, cityName: string | undefined, fuzzy: number, venue = false): Named | undefined {
  if (handle) {
    const byHandle = rows.find((r) => r.instagram === handle);
    if (byHandle) return byHandle;
  }
  const key = nameKey(name, cityName);
  if (!key) return undefined;
  const exact = rows.find((r) => nameKey(r.name, cityName) === key);
  if (exact) return exact;
  if (venue) {
    // "Ohlio" and "Ohlio Gourmet Cafebar" are one place.
    const contained = rows.find((r) => sameVenueKey(nameKey(r.name, cityName), key));
    if (contained) return contained;
  }
  let best: Named | undefined;
  let bestScore = fuzzy;
  for (const r of rows) {
    const score = diceSimilarity(nameKey(r.name, cityName), key);
    if (score >= bestScore) { best = r; bestScore = score; }
  }
  return best;
}

async function matchVenue(db: Db, ctx: PostContext, e: ExtractedEvent, create: boolean): Promise<number | null> {
  const name = e.venue_name.value!.trim();
  let handle = cleanHandle(e.venue_instagram_handle);
  // A venue account posting about its own place: the handle is the venue's.
  if (!handle && ctx.sourceKind === "instagram" && handleKey(ctx.handle, ctx.cityName) === nameKey(name, ctx.cityName).replace(/ /g, "")) {
    handle = ctx.handle;
  }
  const { rows } = await db.query<Named>(
    "SELECT id, name, official_links->>'instagram' AS instagram FROM venues WHERE city_id = $1", [ctx.cityId]);
  const hit = bestMatch(rows, name, handle, ctx.cityName, 0.85, true);
  if (hit) {
    if (handle && !hit.instagram) {
      await db.query("UPDATE venues SET official_links = official_links || $2::jsonb, updated_at = now() WHERE id = $1",
        [hit.id, JSON.stringify({ instagram: handle })]);
    }
    return hit.id;
  }
  if (!create) return null;
  let areaId: number | null = null;
  if (e.area.value && e.area.confidence >= 0.6) {
    const areas = await db.query<{ id: number; name: string }>("SELECT id, name FROM areas WHERE city_id = $1", [ctx.cityId]);
    areaId = areas.rows.find((a) => nameKey(a.name) === nameKey(e.area.value!))?.id ?? null;
  }
  const slug = await uniqueSlug(db, "venues", slugify(name), ctx.cityId);
  const ins = await db.query<{ id: number }>(
    `INSERT INTO venues (city_id, area_id, slug, name, venue_type, official_links, needs_enrichment)
     VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
    [ctx.cityId, areaId, slug, name, handle === ctx.handle ? ctx.handleType ?? null : null,
      JSON.stringify(handle ? { instagram: handle } : {})],
  );
  return ins.rows[0].id;
}

async function matchPerson(db: Db, table: "artists" | "organisers", name: string, handle: string | null, kind?: string): Promise<number> {
  const { rows } = await db.query<Named>(`SELECT id, name, official_links->>'instagram' AS instagram FROM ${table}`);
  const hit = bestMatch(rows, name, handle, undefined, 0.9);
  if (hit) return hit.id;
  const slug = await uniqueSlug(db, table, slugify(name));
  const links = JSON.stringify(handle ? { instagram: handle } : {});
  const ins = table === "artists"
    ? await db.query<{ id: number }>(
        "INSERT INTO artists (slug, name, kind, official_links, needs_enrichment) VALUES ($1,$2,$3,$4,true) RETURNING id",
        [slug, name, kind === "group" ? "group" : "person", links])
    : await db.query<{ id: number }>(
        "INSERT INTO organisers (slug, name, official_links, needs_enrichment) VALUES ($1,$2,$3,true) RETURNING id",
        [slug, name, links]);
  return ins.rows[0].id;
}

const SameEventSchema = z.object({ same_event: z.boolean(), confidence: z.number() });
type SameEvent = z.infer<typeof SameEventSchema>;

function sameEventRequest(tier: "fast" | "mid", a: string, b: string, venue: string, date: string): LlmRequest<SameEvent> {
  const text = `Two listings at the same venue on the same date.\nVenue: ${venue}\nDate: ${date}\nListing A title: ${a}\nListing B title: ${b}\n\nAre these the same event (the same show or night, described differently), or two different events at that venue that day?`;
  return {
    id: "same-event", tier, schema: SameEventSchema, maxTokens: tier === "fast" ? 200 : 1500, effort: "low",
    system: "You compare two event listings and decide whether they describe the same event. Give your confidence from 0 to 1.",
    content: [{ type: "text", text }], estInputTokens: 180, estOutputTokens: tier === "fast" ? 30 : 250,
  };
}

interface Candidate { id: number; title: string; confidence: number | null }
type Dup = { kind: "none" } | { kind: "same"; id: number } | { kind: "unsure"; id: number };

/** Same venue and date: same event if the titles are similar; ask the model when it is borderline. */
async function findDuplicate(
  db: Db, llm: LlmClient, ctx: PostContext, venueId: number, venueName: string, date: string, title: string,
  jobName: string, counts: ResolveCounts,
): Promise<Dup> {
  const { rows } = await db.query<Candidate>(
    "SELECT id, title, confidence FROM events WHERE city_id = $1 AND venue_id = $2 AND local_date = $3 AND status <> 'cancelled' ORDER BY id",
    [ctx.cityId, venueId, date],
  );
  let best: Candidate | undefined;
  let bestScore = -1;
  for (const r of rows) {
    const s = titleSimilarity(r.title, title);
    if (s > bestScore) { best = r; bestScore = s; }
  }
  if (!best || bestScore < ingestion.titleSimilarity.different) return { kind: "none" };
  if (bestScore >= ingestion.titleSimilarity.same) return { kind: "same", id: best.id };
  // Borderline: fast tier first, one retry on the mid tier if it is unsure.
  for (const tier of ["fast", "mid"] as const) {
    const [res] = await llm.run([sameEventRequest(tier, best.title, title, venueName, date)], { jobName });
    counts.dedupModelUsd += res?.usd ?? 0;
    if (res?.ok && res.data && res.data.confidence >= ingestion.fastTierMinConfidence) {
      return res.data.same_event ? { kind: "same", id: best.id } : { kind: "none" };
    }
  }
  return { kind: "unsure", id: best.id };
}

function timing(e: ExtractedEvent, timeZone: string) {
  const date = e.start_date.value!;
  const timeKnown = e.start_time.value !== null && e.start_time.confidence >= 0.6 && isClockTime(e.start_time.value);
  const startsAt = zonedToUtc(date, timeKnown ? e.start_time.value! : "00:00", timeZone);
  let endsAt: Date | null = null;
  const endTime = e.end_time.value !== null && e.end_time.confidence >= 0.6 && isClockTime(e.end_time.value) ? e.end_time.value : null;
  const endDate = e.end_date.value !== null && e.end_date.confidence >= 0.6 && isIsoDate(e.end_date.value) ? e.end_date.value : null;
  if (endDate || (endTime && timeKnown)) {
    let d = endDate ?? date;
    // "9 PM to 1 AM": an end time earlier than the start means the next day.
    if (!endDate && endTime && endTime <= e.start_time.value!) {
      d = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    }
    endsAt = zonedToUtc(d, endTime ?? "23:59", timeZone);
    if (endsAt <= startsAt) endsAt = null;
  }
  return { date, timeKnown, startsAt, endsAt };
}

const optional = <T>(f: { value: T | null; confidence: number }) => (f.value !== null && f.value !== "" && f.confidence >= 0.6 ? f.value : null);
const httpUrl = (u: string | null) => (u && /^https?:\/\/\S+\.\S+/i.test(u) ? u : null);

async function attachPeople(db: Db, eventId: number, e: ExtractedEvent) {
  let order = 0;
  for (const p of e.performers) {
    if (!p.name.trim() || p.confidence < 0.7) continue;
    const artistId = await matchPerson(db, "artists", p.name.trim(), null, p.kind);
    await db.query(
      "INSERT INTO event_artists (event_id, artist_id, billing_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [eventId, artistId, order++]);
  }
  const organiser = optional(e.organiser);
  if (organiser && e.organiser.confidence >= 0.7) {
    const organiserId = await matchPerson(db, "organisers", organiser.trim(), cleanHandle(e.organiser_instagram_handle));
    await db.query("INSERT INTO event_organisers (event_id, organiser_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [eventId, organiserId]);
  }
}

async function addSource(db: Db, eventId: number, ctx: PostContext) {
  await db.query(
    `INSERT INTO sources (event_id, source_type, raw_post_id, url) VALUES ($1,$2,$3,$4)
     ON CONFLICT (event_id, raw_post_id) WHERE raw_post_id IS NOT NULL DO NOTHING`,
    [eventId, ctx.sourceKind === "instagram" ? "instagram" : "web", ctx.rawPostId, ctx.postUrl],
  );
}

async function categoryId(db: Db, e: ExtractedEvent): Promise<number | null> {
  const slug = optional(e.category);
  if (!slug) return null;
  return (await db.query<{ id: number }>("SELECT id FROM categories WHERE slug = $1", [slug])).rows[0]?.id ?? null;
}

async function createEvent(db: Db, ctx: PostContext, e: ExtractedEvent, venueId: number): Promise<number> {
  const t = timing(e, ctx.timeZone);
  const title = e.title.value!.trim();
  const slug = await uniqueSlug(db, "events", `${slugify(title)}-${t.date}`, ctx.cityId);
  const confidence = Math.min(e.title.confidence, e.start_date.confidence, e.venue_name.confidence, 1);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO events (city_id, venue_id, category_id, slug, title, starts_at, ends_at, local_date, start_time_known,
       price_text, is_free, booking_url, confidence, is_published, last_verified_at, origin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,now(),'scraped') RETURNING id`,
    [ctx.cityId, venueId, await categoryId(db, e), slug, title, t.startsAt, t.endsAt, t.date, t.timeKnown,
      optional(e.price_text), optional(e.is_free), httpUrl(optional(e.booking_url)), confidence],
  );
  await addSource(db, rows[0].id, ctx);
  await attachPeople(db, rows[0].id, e);
  return rows[0].id;
}

/** A further post about an existing event: add it as a source and fill in facts the event lacks. */
async function mergeInto(db: Db, eventId: number, ctx: PostContext, e: ExtractedEvent) {
  const t = timing(e, ctx.timeZone);
  const others = await db.query<{ handle: string | null; kind: string | null }>(
    `SELECT rp.handle, rp.source_kind AS kind FROM sources s LEFT JOIN raw_posts rp ON rp.id = s.raw_post_id WHERE s.event_id = $1`, [eventId]);
  const independent = !others.rows.some((o) => o.handle === ctx.handle && o.kind === ctx.sourceKind);
  await db.query(
    `UPDATE events SET
       price_text = coalesce(price_text, $2), is_free = coalesce(is_free, $3), booking_url = coalesce(booking_url, $4),
       ends_at = coalesce(ends_at, $5), category_id = coalesce(category_id, $6),
       starts_at = CASE WHEN NOT start_time_known AND $7 THEN $8 ELSE starts_at END,
       start_time_known = start_time_known OR $7,
       confidence = CASE WHEN $9 THEN least(1, coalesce(confidence, 0) + $10) ELSE confidence END,
       last_verified_at = now(), updated_at = now()
     WHERE id = $1`,
    [eventId, optional(e.price_text), optional(e.is_free), httpUrl(optional(e.booking_url)), t.endsAt, await categoryId(db, e),
      t.timeKnown, t.startsAt, independent, ingestion.secondSourceBoost],
  );
  await addSource(db, eventId, ctx);
  await attachPeople(db, eventId, e);
}

/** Cancellation, postponement or change: update the event it refers to, if we can tell which one. */
async function applyUpdate(db: Db, ctx: PostContext, e: ExtractedEvent): Promise<boolean> {
  if (!ok(e.title)) return false;
  const venueId = ok(e.venue_name) ? await matchVenue(db, ctx, e, false) : null;
  const { rows } = await db.query<{ id: number; title: string; local_date: string | null }>(
    `SELECT id, title, local_date::text FROM events
     WHERE city_id = $1 AND status IN ('scheduled', 'postponed') AND starts_at > now() - interval '2 days'
       AND ($2::bigint IS NULL OR venue_id = $2)`,
    [ctx.cityId, venueId],
  );
  const date = ok(e.start_date) && isIsoDate(e.start_date.value!) ? e.start_date.value! : null;
  let best: (typeof rows)[number] | undefined;
  let bestScore = 0;
  for (const r of rows) {
    let s = titleSimilarity(r.title, e.title.value!);
    // For a cancellation the stated date is the event's own date: a different date is a different event.
    if (e.announcement !== "change" && date && r.local_date && r.local_date !== date) s = 0;
    if (s > bestScore) { best = r; bestScore = s; }
  }
  if (!best || bestScore < ingestion.titleSimilarity.same) return false;
  if (e.announcement === "cancellation" || e.announcement === "postponement") {
    await db.query("UPDATE events SET status = $2, last_verified_at = now(), updated_at = now() WHERE id = $1",
      [best.id, e.announcement === "cancellation" ? "cancelled" : "postponed"]);
  } else {
    if (!date) return false;
    const t = timing(e, ctx.timeZone);
    await db.query(
      `UPDATE events SET starts_at = $2, ends_at = $3, local_date = $4, start_time_known = $5, status = 'scheduled',
         venue_id = coalesce($6, venue_id), last_verified_at = now(), updated_at = now() WHERE id = $1`,
      [best.id, t.startsAt, t.endsAt, t.date, t.timeKnown, venueId]);
  }
  await addSource(db, best.id, ctx);
  return true;
}

/** Accounts tagged or credited in an event post become suggestions for approval; never handles. */
async function suggestHandles(db: Db, ctx: PostContext, ex: Extraction): Promise<number> {
  const found = new Set<string>();
  for (const h of [...ctx.taggedHandles, ...ex.co_host_handles,
    ...ex.events.flatMap((e) => [e.venue_instagram_handle, e.organiser_instagram_handle])]) {
    const c = cleanHandle(h);
    if (c && c !== ctx.handle) found.add(c);
  }
  if (found.size === 0) return 0;
  const known = await db.query<{ handle: string }>("SELECT handle FROM handles WHERE handle = ANY($1)", [[...found]]);
  for (const k of known.rows) found.delete(k.handle);
  let added = 0;
  for (const h of found) {
    const res = await db.query<{ inserted: boolean }>(
      `INSERT INTO suggested_handles (handle, city_id, reason, first_seen_post) VALUES ($1,$2,$3,$4)
       ON CONFLICT (handle) DO UPDATE SET seen_count = suggested_handles.seen_count + 1, updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [h, ctx.cityId, `tagged or credited in an event post by @${ctx.handle}`, ctx.shortcode]);
    if (res.rows[0].inserted) added++;
  }
  return added;
}

export function emptyCounts(): ResolveCounts {
  return { created: 0, merged: 0, statusUpdates: 0, queued: 0, suggestedHandles: 0, dedupModelUsd: 0 };
}

export async function resolvePost(
  pool: Pool, llm: LlmClient, ctx: PostContext, ex: Extraction, jobName: string, counts: ResolveCounts,
): Promise<FinalState> {
  if (!ex.is_event_post || ex.events.length === 0) return "filtered_out";
  if (ctx.sourceKind === "instagram") counts.suggestedHandles += await suggestHandles(pool, ctx, ex);

  let created = 0, merged = 0, queued = 0;
  for (const e of ex.events) {
    if (e.announcement !== "new_event") {
      if (await applyUpdate(pool, ctx, e)) { counts.statusUpdates++; merged++; }
      else { await queueReview(pool, ctx, `${e.announcement} post for an event we could not match`, e); queued++; }
      continue;
    }
    const reasons = gate(e, ctx);
    if (reasons.length) { await queueReview(pool, ctx, reasons.join("; "), e); queued++; continue; }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // One event at a time per city, so two posts about the same night cannot both be created.
      await client.query("SELECT pg_advisory_xact_lock(72001, $1)", [ctx.cityId]);
      const venueId = (await matchVenue(client, ctx, e, true))!;
      const dup = await findDuplicate(client, llm, ctx, venueId, e.venue_name.value!, e.start_date.value!, e.title.value!, jobName, counts);
      if (dup.kind === "same") { await mergeInto(client, dup.id, ctx, e); merged++; }
      else if (dup.kind === "unsure") { await queueReview(client, ctx, "possible duplicate of an existing event", e, { existingEventId: dup.id }); queued++; }
      else { await createEvent(client, ctx, e, venueId); created++; }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  counts.created += created;
  counts.merged += merged;
  counts.queued += queued;
  return created > 0 ? "published" : merged > 0 ? "merged" : "queued_review";
}
