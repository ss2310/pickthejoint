/**
 * Poster photos (Prompt 6): "snap a poster" on the public site, the admin's
 * poster inbox and the poster email address.
 *
 * Every photo is checked from its bytes (JPEG, PNG or WebP only, size capped),
 * turned upright, shrunk and re-encoded as JPEG. Re-encoding keeps none of the
 * original metadata, so camera location and device details are gone before
 * anything is stored. The stored copy is private: it is read by the vision
 * model and shown to the admin, never on a public page, and housekeeping
 * deletes it after the event (hard rule 4 covers Instagram; these photos are
 * held to the same standard).
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { Pool } from "pg";
import { submissions as cfg, type SubBudget } from "../config";
import { getPool } from "./db";
import { extractionRequest, type Extraction } from "./pipeline/extract";
import type { LlmClient } from "./pipeline/llm";
import { createDraft, fieldsFromExtraction, queueSubmission, type SubmissionRow } from "./submissions";

export type UploadProblem = "empty" | "tooBig" | "badType" | "unreadable";

export class UploadError extends Error {
  constructor(public readonly problem: UploadProblem) {
    super(`upload rejected: ${problem}`);
    this.name = "UploadError";
  }
}

export interface CleanImage { bytes: Buffer; width: number; height: number; mediaType: "image/jpeg"; sha256: string }

/** Validates an uploaded photo and returns a clean, upright, metadata-free JPEG copy. */
export async function cleanImage(input: Buffer): Promise<CleanImage> {
  if (input.length === 0) throw new UploadError("empty");
  if (input.length > cfg.maxUploadBytes) throw new UploadError("tooBig");
  let format: string | undefined;
  try {
    format = (await sharp(input, { limitInputPixels: 80_000_000 }).metadata()).format;
  } catch {
    throw new UploadError("unreadable");
  }
  if (!format || !cfg.imageFormats.includes(format)) throw new UploadError("badType");
  try {
    const edge = cfg.storedLongEdge;
    const { data, info } = await sharp(input, { limitInputPixels: 80_000_000, animated: false })
      .rotate() // apply the camera's orientation before the metadata is dropped
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer({ resolveWithObject: true }); // no keepMetadata(): nothing from the original file is copied
    return { bytes: data, width: info.width, height: info.height, mediaType: "image/jpeg", sha256: createHash("sha256").update(data).digest("hex") };
  } catch {
    throw new UploadError("unreadable");
  }
}

export type Channel = "public" | "admin" | "email";

export async function storePoster(
  input: { channel: Channel; cityId: number | null; image: CleanImage; originalName?: string | null; note?: string | null; keepDays: number },
  pool: Pool = getPool(),
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO poster_images (channel, city_id, bytes, media_type, width, height, sha256, original_name, note, delete_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(days => $10)) RETURNING id`,
    [input.channel, input.cityId, input.image.bytes, input.image.mediaType, input.image.width, input.image.height, input.image.sha256,
      input.originalName?.slice(0, 200) ?? null, input.note?.slice(0, 1500) ?? null, input.keepDays]);
  return rows[0].id;
}

export interface PosterReading { posterId: number; ok: boolean; extraction: Extraction | null; error: string | null; usd: number }

const CHANNEL_NAME: Record<Channel, string> = {
  public: "a member of the public", admin: "the site's editor, collected from WhatsApp or Telegram groups", email: "the site's editor, by email",
};

/** Reads posters with the vision model (the same extraction as Instagram posters) and stores what it found. */
export async function readPosters(
  pool: Pool, llm: LlmClient, ids: number[], opts: { jobName: string; subBudget?: SubBudget },
): Promise<PosterReading[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<{ id: number; channel: Channel; bytes: Buffer; note: string | null; created_at: Date; city_id: number | null; city_name: string; timezone: string }>(
    `SELECT p.id, p.channel, p.bytes, p.note, p.created_at, c.id AS city_id, c.name AS city_name, c.timezone
     FROM poster_images p JOIN cities c ON c.id = coalesce(p.city_id, (SELECT id FROM cities WHERE is_live ORDER BY id LIMIT 1))
     WHERE p.id = ANY($1::bigint[]) ORDER BY p.id`, [ids]);
  const cats = (await pool.query<{ slug: string }>("SELECT slug FROM categories ORDER BY sort_order")).rows.map((c) => c.slug);
  const areas = await pool.query<{ city_id: number; name: string }>("SELECT city_id, name FROM areas ORDER BY name");
  const requests = rows.map((r) => extractionRequest({
    id: String(r.id), sourceKind: "poster", sourceName: CHANNEL_NAME[r.channel], cityName: r.city_name, timeZone: r.timezone,
    postedAt: r.created_at, text: r.note ?? "", images: [{ mediaType: "image/jpeg", base64: r.bytes.toString("base64") }],
    areas: areas.rows.filter((a) => a.city_id === r.city_id).map((a) => a.name), categorySlugs: cats,
  }));
  const results = await llm.run(requests, { jobName: opts.jobName, subBudget: opts.subBudget });
  const out: PosterReading[] = [];
  for (const r of rows) {
    const res = results.find((x) => x.id === String(r.id));
    const ok = !!res?.ok && !!res.data;
    await pool.query(
      "UPDATE poster_images SET extraction = $2, extraction_state = $3, extraction_error = $4 WHERE id = $1",
      [r.id, ok ? JSON.stringify(res!.data) : null, ok ? "done" : "failed", ok ? null : res?.error ?? "no answer"]);
    out.push({ posterId: r.id, ok, extraction: ok ? res!.data! : null, error: ok ? null : res?.error ?? "no answer", usd: res?.usd ?? 0 });
  }
  return out;
}

/** What one inbox poster turned into. */
export interface InboxResult { posterId: number; outcome: "drafts" | "not_event" | "failed"; submissionIds: number[]; titles: string[]; note: string }

/**
 * The admin's poster inbox and the poster email: each poster is read, and
 * every event on it becomes a draft in review_queue. A photo that is not an
 * event, or could not be read, gets a review item of its own so nothing
 * disappears silently.
 */
export async function inboxPosters(
  pool: Pool, llm: LlmClient, ids: number[], channel: Extract<SubmissionRow["channel"], "admin" | "email">, opts: { jobName: string },
): Promise<InboxResult[]> {
  const readings = await readPosters(pool, llm, ids, opts);
  const cats = (await pool.query<{ slug: string }>("SELECT slug FROM categories ORDER BY sort_order")).rows.map((c) => c.slug);
  const out: InboxResult[] = [];
  for (const r of readings) {
    const cityId = (await pool.query<{ city_id: number | null }>("SELECT city_id FROM poster_images WHERE id = $1", [r.posterId])).rows[0]?.city_id ?? null;
    if (!r.ok || !r.extraction) {
      await pool.query("INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('poster', $1, $2, $3)",
        [r.posterId, "poster could not be read", { error: r.error }]);
      out.push({ posterId: r.posterId, outcome: "failed", submissionIds: [], titles: [], note: r.error ?? "" });
      continue;
    }
    const events = r.extraction.events.filter((e) => e.announcement === "new_event");
    if (!r.extraction.is_event_post || events.length === 0) {
      await pool.query("INSERT INTO review_queue (item_type, item_id, reason, payload) VALUES ('poster', $1, $2, $3)",
        [r.posterId, "photo does not look like an event poster", { notes: r.extraction.notes }]);
      out.push({ posterId: r.posterId, outcome: "not_event", submissionIds: [], titles: [], note: r.extraction.notes });
      continue;
    }
    const subIds: number[] = [];
    for (const ev of events) {
      const fields = fieldsFromExtraction(ev, cats);
      const { id } = await createDraft({ channel, cityId, fields, posterId: r.posterId }, pool);
      await queueSubmission(pool, llm, id, opts);
      subIds.push(id);
    }
    out.push({ posterId: r.posterId, outcome: "drafts", submissionIds: subIds, titles: events.map((e) => e.title.value ?? "(no title)"), note: r.extraction.notes });
  }
  return out;
}
