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

const pageTier = (form: FormData) => (["A", "B", "C"].includes(text(form, "tier")) ? text(form, "tier") : "B");

/**
 * Adds public Facebook pages, one link per line (a name may follow the link after a comma).
 * Their posts and upcoming events are then read on the pace of the chosen tier.
 */
export async function addFacebookPage(form: FormData): Promise<void> {
  await requireAdmin();
  const pool = getPool();
  const city = (await pool.query<{ id: number }>("SELECT id FROM cities WHERE slug = $1", [text(form, "city") || "indore"])).rows[0];
  if (!city) back("/admin/coverage", "Unknown city.");
  const tier = pageTier(form);
  const lines = text(form, "url").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 300);
  if (lines.length === 0) back("/admin/coverage", "Paste at least one Facebook page link.");
  let added = 0, known = 0;
  const bad: string[] = [];
  for (const line of lines) {
    const [link, ...rest] = line.split(",");
    const page = facebookPage(link);
    if (!page) { bad.push(link.trim().slice(0, 60)); continue; }
    const name = rest.join(",").trim() || null;
    // Facebook addresses ignore case: a page already on record under another spelling is switched back on, not added twice.
    const existing = await pool.query("UPDATE facebook_pages SET active = true, name = coalesce(name, $3) WHERE city_id = $1 AND lower(page) = lower($2)", [city!.id, page, name]);
    if (existing.rowCount) { known++; continue; }
    await pool.query("INSERT INTO facebook_pages (city_id, page, name, tier, added_via) VALUES ($1,$2,$3,$4,'manual')", [city!.id, page, name, tier]);
    added++;
  }
  back("/admin/coverage", [
    `${added} page(s) added as tier ${tier}`, known ? `${known} already on the list` : "",
    bad.length ? `${bad.length} not a Facebook page link (for example https://www.facebook.com/somevenue): ${bad.slice(0, 5).join(", ")}` : "",
  ].filter(Boolean).join("; ") + ".");
}

/** How often a page's posts are read: A every two days, B weekly, C every two weeks. */
export async function setFacebookPageTier(form: FormData): Promise<void> {
  await requireAdmin();
  const { rows } = await getPool().query<{ page: string; tier: string }>(
    "UPDATE facebook_pages SET tier = $2 WHERE id = $1 RETURNING page, tier", [Number(form.get("id")), pageTier(form)]);
  back("/admin/coverage", rows[0] ? `facebook.com/${rows[0].page} is now tier ${rows[0].tier}.` : "Not found.");
}

export async function toggleFacebookPage(form: FormData): Promise<void> {
  await requireAdmin();
  const { rows } = await getPool().query<{ page: string; active: boolean }>(
    "UPDATE facebook_pages SET active = NOT active WHERE id = $1 RETURNING page, active", [Number(form.get("id"))]);
  back("/admin/coverage", rows[0] ? `facebook.com/${rows[0].page} ${rows[0].active ? "switched on" : "switched off"}.` : "Not found.");
}
