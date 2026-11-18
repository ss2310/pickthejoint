"use server";
/**
 * Everything the admin can change. Each action checks the session first,
 * does one thing, and redirects back with a short message. Server actions
 * also check the request's Origin against the host (Next.js), and the session
 * cookie is SameSite=Strict, so another site cannot post these forms.
 */
import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { getPool } from "@/lib/db";
import { queueItem } from "@/lib/admin-data";
import { requireAdmin } from "@/lib/admin-session";
import type { ExtractedEvent } from "@/lib/pipeline/extract";
import { AnthropicLlm } from "@/lib/pipeline/llm";
import {
  approveSubmission, createCheckedEvent, createDraft, fieldsFromExtraction, readFields, rejectSubmission, type SubmissionFields,
} from "@/lib/submissions";

const JOB = "admin";

const back = (path: string, msg: string): never => redirect(`${path}${path.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`);
const num = (form: FormData, name: string) => Number(form.get(name));

/** Pages are rebuilt from the database on their next request. */
function refreshPublicPages() {
  revalidatePath("/", "layout");
}

async function resolveItem(id: number, status: "approved" | "rejected" | "resolved", note: string) {
  await getPool().query("UPDATE review_queue SET status = $2, resolved_at = now(), resolution_note = $3 WHERE id = $1", [id, status, note.slice(0, 500)]);
}

async function categories() {
  return (await getPool().query<{ slug: string }>("SELECT slug FROM categories ORDER BY sort_order")).rows.map((c) => c.slug);
}

async function rawPost(id: number) {
  return (await getPool().query<{ id: number; source_kind: string; post_url: string; city_id: number | null }>(
    `SELECT rp.id, rp.source_kind, rp.post_url, coalesce(rp.city_id, h.city_id) AS city_id
     FROM raw_posts rp LEFT JOIN handles h ON h.handle = rp.handle WHERE rp.id = $1`, [id])).rows[0] ?? null;
}

/** Publishes facts from a queued post that the admin has checked (and maybe corrected). */
async function publishRawPost(itemId: number, rawPostId: number, fields: SubmissionFields, cityId: number | null): Promise<string> {
  const pool = getPool();
  const rp = await rawPost(rawPostId);
  if (!rp) throw new Error("the post is no longer stored");
  const city = cityId ?? rp.city_id;
  if (!city) throw new Error("choose a city");
  const out = await createCheckedEvent(pool, new AnthropicLlm(), city, fields, {
    type: rp.source_kind === "instagram" ? "instagram" : "web", url: rp.post_url, rawPostId: rp.id, origin: "scraped",
  }, { jobName: JOB });
  await pool.query("UPDATE raw_posts SET processing_state = 'published', processed_at = now() WHERE id = $1", [rp.id]);
  await resolveItem(itemId, "approved", `published as ${out.path}${out.published ? "" : " (description pending review)"}`);
  return out.path;
}

/** One click: approve the item as it stands. */
export async function approveItem(form: FormData): Promise<void> {
  await requireAdmin();
  const pool = getPool();
  const item = await queueItem(num(form, "id"));
  const from = String(form.get("from") ?? "/admin/queue");
  if (!item || item.status !== "open") back(from, "That item was already handled.");
  const it = item!;
  let msg = "Done.";
  try {
    switch (it.item_type) {
      case "submission": {
        const out = await approveSubmission(pool, new AnthropicLlm(), it.item_id!, { jobName: JOB });
        msg = out.published ? `Published: ${out.path}` : `Created ${out.path}; its description could not be written and is in the queue.`;
        break;
      }
      case "raw_post": {
        const ev = (it.payload.event ?? null) as ExtractedEvent | null;
        if (!ev) back(`/admin/queue/${it.id}`, "Nothing was extracted from this post: fill in the facts and publish.");
        msg = `Published: ${await publishRawPost(it.id, it.item_id!, fieldsFromExtraction(ev!, await categories(), 0), null)}`;
        break;
      }
      case "event": {
        await pool.query("UPDATE events SET is_published = true, updated_at = now() WHERE id = $1", [it.item_id]);
        await pool.query("INSERT INTO event_actions (event_id, action, reason) VALUES ($1, 'published', $2)", [it.item_id, `approved in review: ${it.reason}`]);
        await resolveItem(it.id, "approved", "published");
        msg = "The event is published.";
        break;
      }
      case "venue_geocode": {
        const pick = num(form, "candidate") || 0;
        const c = ((it.payload.candidates ?? []) as { lat: number; lng: number; confidence: number; name: string }[])[pick];
        if (!c) back(from, "No such map match.");
        await pool.query("UPDATE venues SET lat = $2, lng = $3, geocode_confidence = $4, updated_at = now() WHERE id = $1", [it.item_id, c!.lat, c!.lng, c!.confidence]);
        await resolveItem(it.id, "approved", `location set from: ${c!.name}`);
        msg = "Venue location saved.";
        break;
      }
      case "poster":
        // A poster the reader could not use: the admin fills the facts in by hand.
        redirect(`/admin/queue/${it.id}`);
        break;
      default:
        await resolveItem(it.id, "resolved", "reviewed");
        msg = "Marked as reviewed.";
    }
  } catch (err) {
    unstable_rethrow(err);
    back(from, `Could not approve: ${(err as Error).message}`);
  }
  refreshPublicPages();
  back(from, msg);
}

/** One click: reject the item. */
export async function rejectItem(form: FormData): Promise<void> {
  await requireAdmin();
  const pool = getPool();
  const item = await queueItem(num(form, "id"));
  const from = String(form.get("from") ?? "/admin/queue");
  if (!item || item.status !== "open") back(from, "That item was already handled.");
  const note = String(form.get("note") ?? "").trim() || "rejected";
  switch (item!.item_type) {
    case "submission":
      await rejectSubmission(pool, item!.item_id!, note);
      break;
    case "event":
      await pool.query("UPDATE events SET is_published = false, updated_at = now() WHERE id = $1", [item!.item_id]);
      await resolveItem(item!.id, "rejected", note);
      refreshPublicPages();
      break;
    case "raw_post":
      await pool.query("UPDATE raw_posts SET processing_state = 'filtered_out', processed_at = now() WHERE id = $1 AND processing_state = 'queued_review'", [item!.item_id]);
      await resolveItem(item!.id, "rejected", note);
      break;
    case "poster":
      await pool.query("UPDATE poster_images SET delete_after = least(delete_after, now() + interval '1 day') WHERE id = $1", [item!.item_id]);
      await resolveItem(item!.id, "rejected", note);
      break;
    default:
      await resolveItem(item!.id, "rejected", note);
  }
  back(from, "Rejected.");
}

/** The edit form: save corrected facts, and publish unless the admin only saved. */
export async function saveItem(form: FormData): Promise<void> {
  await requireAdmin();
  const pool = getPool();
  const id = num(form, "id");
  const item = await queueItem(id);
  if (!item || item.status !== "open") back("/admin/queue", "That item was already handled.");
  const fields = readFields(form);
  const citySlug = String(form.get("city") ?? "");
  const cityId = (await pool.query<{ id: number }>("SELECT id FROM cities WHERE slug = $1", [citySlug])).rows[0]?.id ?? null;
  const publish = form.get("intent") !== "save";
  let msg = "Saved.";
  try {
    if (item!.item_type === "submission") {
      if (!publish) {
        await pool.query("UPDATE submissions SET fields = $2, city_id = coalesce($3, city_id), updated_at = now() WHERE id = $1", [item!.item_id, fields, cityId]);
      } else {
        const out = await approveSubmission(pool, new AnthropicLlm(), item!.item_id!, { jobName: JOB, fields, cityId: cityId ?? undefined });
        msg = `Published: ${out.path}`;
      }
    } else if (item!.item_type === "raw_post") {
      if (!publish) back(`/admin/queue/${id}`, "Posts are not stored as drafts: publish or reject.");
      msg = `Published: ${await publishRawPost(id, item!.item_id!, fields, cityId)}`;
    } else if (item!.item_type === "poster") {
      // Facts typed in from a poster the reader could not use: a submission from the inbox, approved.
      const { id: subId } = await createDraft({ channel: "admin", cityId, fields, posterId: item!.item_id }, pool);
      await pool.query("UPDATE submissions SET status = 'pending', submitted_at = now() WHERE id = $1", [subId]);
      if (publish) {
        const out = await approveSubmission(pool, new AnthropicLlm(), subId, { jobName: JOB });
        msg = `Published: ${out.path}`;
      }
      await resolveItem(id, "approved", `typed in as submission ${subId}`);
    } else if (item!.item_type === "event") {
      const description = String(form.get("description") ?? "").replace(/\s+/g, " ").trim();
      await pool.query("UPDATE events SET description = $2, is_published = $3, updated_at = now() WHERE id = $1", [item!.item_id, description, publish]);
      if (publish) {
        await pool.query("INSERT INTO event_actions (event_id, action, reason) VALUES ($1, 'published', $2)", [item!.item_id, `approved in review after editing: ${item!.reason}`]);
        await resolveItem(id, "approved", "edited and published");
        msg = "The event is published.";
      }
    }
  } catch (err) {
    unstable_rethrow(err);
    back(`/admin/queue/${id}`, `Could not save: ${(err as Error).message}`);
  }
  refreshPublicPages();
  back(publish ? "/admin/queue" : `/admin/queue/${id}`, msg);
}

// ---------------------------------------------------------------- handles

const HANDLE_TYPES = ["venue", "organiser", "artist", "promoter", "college", "cultural_body", "cafe", "comedy_club", "community"];

export async function approveHandle(form: FormData): Promise<void> {
  await requireAdmin();
  const pool = getPool();
  const s = (await pool.query<{ handle: string; city_id: number | null }>("SELECT handle, city_id FROM suggested_handles WHERE id = $1 AND status = 'pending'", [num(form, "id")])).rows[0];
  if (!s) back("/admin/handles", "Already handled.");
  const type = HANDLE_TYPES.includes(String(form.get("type"))) ? String(form.get("type")) : "venue";
  const tier = form.get("tier") === "A" ? "A" : "B";
  const cityId = s!.city_id ?? (await pool.query<{ id: number }>("SELECT id FROM cities WHERE is_live ORDER BY id LIMIT 1")).rows[0].id;
  await pool.query(
    `INSERT INTO handles (handle, handle_type, city_id, tier) VALUES ($1,$2,$3,$4)
     ON CONFLICT (handle) DO UPDATE SET active = true, tier = EXCLUDED.tier, handle_type = EXCLUDED.handle_type, updated_at = now()`,
    [s!.handle, type, cityId, tier]);
  await pool.query("UPDATE suggested_handles SET status = 'approved', updated_at = now() WHERE id = $1", [num(form, "id")]);
  back("/admin/handles", `@${s!.handle} added as tier ${tier}.`);
}

export async function dismissHandle(form: FormData): Promise<void> {
  await requireAdmin();
  await getPool().query("UPDATE suggested_handles SET status = 'dismissed', updated_at = now() WHERE id = $1", [num(form, "id")]);
  back("/admin/handles", "Dismissed.");
}

export async function updateHandle(form: FormData): Promise<void> {
  await requireAdmin();
  const tier = form.get("tier") === "A" ? "A" : "B";
  const active = form.get("active") === "on";
  const { rows } = await getPool().query<{ handle: string }>(
    "UPDATE handles SET tier = $2, active = $3, updated_at = now() WHERE id = $1 RETURNING handle", [num(form, "id"), tier, active]);
  back("/admin/handles", rows[0] ? `@${rows[0].handle}: tier ${tier}, ${active ? "active" : "paused"}.` : "Not found.");
}

// ---------------------------------------------------------------- events

/** Cancel, take down or restore a public page. The reason is required and kept. */
export async function eventAction(form: FormData): Promise<void> {
  await requireAdmin();
  const pool = getPool();
  const id = num(form, "id");
  const action = String(form.get("action"));
  const reason = String(form.get("reason") ?? "").trim().slice(0, 1000);
  const q = String(form.get("q") ?? "");
  const here = `/admin/events${q ? `?q=${encodeURIComponent(q)}` : ""}`;
  if (!reason) back(here, "Give a reason: it is kept with the event.");
  if (action === "cancelled") {
    await pool.query("UPDATE events SET status = 'cancelled', last_verified_at = now(), updated_at = now() WHERE id = $1", [id]);
  } else if (action === "removed") {
    await pool.query("UPDATE events SET is_published = false, updated_at = now() WHERE id = $1", [id]);
  } else if (action === "restored") {
    await pool.query(
      "UPDATE events SET is_published = true, status = CASE WHEN status = 'cancelled' THEN 'scheduled' ELSE status END, updated_at = now() WHERE id = $1", [id]);
  } else {
    back(here, "Unknown action.");
  }
  await pool.query("INSERT INTO event_actions (event_id, action, reason) VALUES ($1,$2,$3)", [id, action, reason]);
  refreshPublicPages();
  back(here, `Event ${action}.`);
}
