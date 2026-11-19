"use server";
/** Admin actions for artist tracking and official video (Prompt 10). Same pattern as sourcing-actions.ts. */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-session";
import { instagramHandle } from "@/lib/pipeline/artist-tracking";
import { parseChannelLink } from "@/lib/pipeline/youtube";

const back = (msg: string): never => redirect(`/admin/artists?msg=${encodeURIComponent(msg)}`);
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
/** Public pages are cached: a change that shows on them clears the cache. */
const refresh = () => revalidatePath("/", "layout");

/** Pins an artist (by page address or slug) so they are tracked between events, or unpins them. */
export async function pinArtist(form: FormData): Promise<void> {
  await requireAdmin();
  const slug = text(form, "slug").replace(/^.*\/artists\//, "").replace(/[/?#].*$/, "").toLowerCase();
  const pinned = text(form, "pinned") !== "false";
  const { rows } = await getPool().query<{ name: string }>("UPDATE artists SET tracking_pinned = $2 WHERE slug = $1 RETURNING name", [slug, pinned]);
  back(rows[0] ? `${rows[0].name} is ${pinned ? "pinned: tracked until you unpin them" : "no longer pinned"}.` : `No artist page "${slug}".`);
}

/** Sets an artist's Instagram account or YouTube channel link, the two things tracking needs. */
export async function setArtistLink(form: FormData): Promise<void> {
  await requireAdmin();
  const id = Number(form.get("id"));
  const kind = text(form, "kind") === "youtube" ? "youtube" : "instagram";
  const raw = text(form, "value");
  const value = kind === "instagram" ? instagramHandle(raw) : parseChannelLink(raw) ? raw : null;
  if (!value) back(kind === "instagram" ? "That is not an Instagram handle." : "Give the channel's address, for example https://www.youtube.com/@name or https://www.youtube.com/channel/UC…");
  // A new YouTube link means the videos are looked up again from that channel.
  await getPool().query(
    `UPDATE artists SET official_links = official_links || jsonb_build_object($2::text, $3::text), updated_at = now(),
       videos_checked_at = CASE WHEN $2 = 'youtube' THEN NULL ELSE videos_checked_at END WHERE id = $1`, [id, kind, value]);
  if (kind === "youtube") await getPool().query("DELETE FROM artist_videos WHERE artist_id = $1 AND status = 'pending'", [id]);
  refresh();
  back(kind === "instagram" ? `Instagram set to @${value}.` : "YouTube channel saved; its videos will be looked up on the next run.");
}

/** Approves or rejects one suggested video, or every pending one of an artist. Only approved videos show on pages. */
export async function decideVideo(form: FormData): Promise<void> {
  await requireAdmin();
  const status = text(form, "decision") === "approve" ? "approved" : "rejected";
  const artistId = Number(form.get("artist_id") ?? 0);
  const res = artistId
    ? await getPool().query("UPDATE artist_videos SET status = $2, decided_at = now() WHERE artist_id = $1 AND status = 'pending'", [artistId, status])
    : await getPool().query("UPDATE artist_videos SET status = $2, decided_at = now() WHERE id = $1", [Number(form.get("id")), status]);
  await getPool().query(
    "UPDATE artists SET updated_at = now() WHERE id IN (SELECT artist_id FROM artist_videos WHERE id = $1) OR id = $2", [Number(form.get("id") ?? 0), artistId]);
  refresh();
  back(`${res.rowCount ?? 0} video(s) ${status}.`);
}

/** Looks the artist's videos up again on the next run (for example after a wrong channel was picked). */
export async function recheckVideos(form: FormData): Promise<void> {
  await requireAdmin();
  const id = Number(form.get("id"));
  await getPool().query("DELETE FROM artist_videos WHERE artist_id = $1 AND status <> 'approved'", [id]);
  await getPool().query("UPDATE artists SET videos_checked_at = NULL, videos_note = NULL WHERE id = $1", [id]);
  back("Videos will be looked up again on the next run.");
}

/** Hides a release note from the artist page, or shows it again. */
export async function toggleUpdate(form: FormData): Promise<void> {
  await requireAdmin();
  const { rows } = await getPool().query<{ hidden: boolean }>("UPDATE artist_posts SET hidden = NOT hidden WHERE id = $1 RETURNING hidden", [Number(form.get("id"))]);
  refresh();
  back(rows[0] ? (rows[0].hidden ? "Hidden from the artist page." : "Showing on the artist page again.") : "Not found.");
}
