"use server";
/** Admin actions for wider sourcing (Prompt 9): the venue census and Facebook pages. Same pattern as actions.ts. */
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-session";
import { addCensusRows, CENSUS_TYPES } from "@/lib/pipeline/census-import";
import { facebookPage } from "@/lib/pipeline/facebook";

const back = (path: string, msg: string): never => redirect(`${path}${path.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`);
const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const returnTo = (form: FormData) => (text(form, "back").startsWith("/admin/") ? text(form, "back") : "/admin/venues");
const HANDLE_TYPES = ["venue", "organiser", "artist", "promoter", "college", "cultural_body", "cafe", "comedy_club", "community"];

/** Starts tracking a census place's Instagram account. */
export async function addVenueHandle(form: FormData): Promise<void> {
  await requireAdmin();
  const pool = getPool();
  const to = returnTo(form);
  const handle = text(form, "handle").toLowerCase().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9._]{1,30}$/.test(handle)) back(to, "That is not an Instagram handle.");
  const place = (await pool.query<{ id: number; city_id: number; venue_id: number | null }>(
    "SELECT id, city_id, venue_id FROM venue_census WHERE id = $1", [Number(form.get("id"))])).rows[0];
  if (!place) back(to, "Place not found.");
  const tier = form.get("tier") === "A" ? "A" : "B";
  const type = HANDLE_TYPES.includes(text(form, "type")) ? text(form, "type") : "venue";
  await pool.query(
    `INSERT INTO handles (handle, handle_type, city_id, tier, tier_set_by, tier_set_at) VALUES ($1,$2,$3,$4,'manual',now())
     ON CONFLICT (handle) DO UPDATE SET active = true, tier = EXCLUDED.tier, tier_set_by = 'manual', tier_set_at = now(), paused_reason = NULL, updated_at = now()`,
    [handle, type, place!.city_id, tier]);
  await pool.query("UPDATE venue_census SET instagram_handle = $2, last_seen_at = now() WHERE id = $1", [place!.id, handle]);
  if (place!.venue_id) {
    await pool.query(
      "UPDATE venues SET official_links = official_links || jsonb_build_object('instagram', $2::text), updated_at = now() WHERE id = $1 AND NOT official_links ? 'instagram'",
      [place!.venue_id, handle]);
  }
  await pool.query("UPDATE suggested_handles SET status = 'approved', updated_at = now() WHERE handle = $1 AND status = 'pending'", [handle]);
  back(to, `@${handle} added as tier ${tier}.`);
}

export async function ignoreCensusPlace(form: FormData): Promise<void> {
  await requireAdmin();
  await getPool().query("UPDATE venue_census SET ignored = true WHERE id = $1", [Number(form.get("id"))]);
  back(returnTo(form), "Hidden from the census lists.");
}

export async function addCensusPlace(form: FormData): Promise<void> {
  await requireAdmin();
  const name = text(form, "name");
  if (!name) back("/admin/venues", "A name is needed.");
  const type = (CENSUS_TYPES as readonly string[]).includes(text(form, "type")) ? text(form, "type") : "other";
  const r = await addCensusRows(getPool(), text(form, "city") || "indore", [{
    name, type, address: text(form, "address") || null, instagram: text(form, "instagram").replace(/^@/, "").toLowerCase() || null, facebook: text(form, "facebook") || null,
  }]);
  back("/admin/venues", r.written ? `${name} added to the census.` : `${name} is already in the census.`);
}

/** Adds a public Facebook page whose upcoming events are read weekly. */
export async function addFacebookPage(form: FormData): Promise<void> {
  await requireAdmin();
  const pool = getPool();
  const page = facebookPage(text(form, "url"));
  if (!page) back("/admin/coverage", "That is not a link to a Facebook page (for example https://www.facebook.com/somevenue).");
  const city = (await pool.query<{ id: number }>("SELECT id FROM cities WHERE slug = $1", [text(form, "city") || "indore"])).rows[0];
  if (!city) back("/admin/coverage", "Unknown city.");
  const r = await pool.query(
    `INSERT INTO facebook_pages (city_id, page, name, added_via) VALUES ($1,$2,$3,'manual')
     ON CONFLICT (city_id, page) DO UPDATE SET active = true`, [city!.id, page, text(form, "name") || null]);
  back("/admin/coverage", r.rowCount ? `facebook.com/${page} will be read with the next weekly run.` : "Already on the list.");
}

export async function toggleFacebookPage(form: FormData): Promise<void> {
  await requireAdmin();
  const { rows } = await getPool().query<{ page: string; active: boolean }>(
    "UPDATE facebook_pages SET active = NOT active WHERE id = $1 RETURNING page, active", [Number(form.get("id"))]);
  back("/admin/coverage", rows[0] ? `facebook.com/${rows[0].page} ${rows[0].active ? "switched on" : "switched off"}.` : "Not found.");
}
