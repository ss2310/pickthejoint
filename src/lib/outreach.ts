/**
 * Organiser outreach list (Prompt 9): organisers and venues that have events
 * on the site, with their page and their public contact (the official links
 * on record: Instagram, website, Facebook, and any public email or phone), so
 * the owner can invite them to claim their free listing and submit events.
 * Admin only; exported as CSV.
 */
import type { Pool } from "pg";
import { site } from "../config";

export interface OutreachRow {
  kind: "venue" | "organiser";
  name: string;
  city: string;
  url: string;
  events_listed: number;
  upcoming: number;
  last_event: Date | null;
  instagram: string | null;
  website: string | null;
  facebook: string | null;
  email: string | null;
  phone: string | null;
  tracked_handle: boolean;
}

export async function outreachList(pool: Pool): Promise<OutreachRow[]> {
  const { rows } = await pool.query<OutreachRow>(
    `WITH ev AS (SELECT * FROM events WHERE is_published)
     SELECT 'venue' AS kind, v.name, c.name AS city, '/' || c.slug || '/venues/' || v.slug AS url,
            count(ev.id)::int AS events_listed, count(ev.id) FILTER (WHERE ev.starts_at >= now())::int AS upcoming, max(ev.starts_at) AS last_event,
            v.official_links->>'instagram' AS instagram, v.official_links->>'website' AS website, v.official_links->>'facebook' AS facebook,
            v.official_links->>'email' AS email, v.official_links->>'phone' AS phone,
            EXISTS (SELECT 1 FROM handles h WHERE h.active AND h.handle = lower(v.official_links->>'instagram')) AS tracked_handle
     FROM venues v JOIN cities c ON c.id = v.city_id JOIN ev ON ev.venue_id = v.id
     GROUP BY v.id, c.id
     UNION ALL
     SELECT 'organiser', o.name, string_agg(DISTINCT c.name, ', '), '/organisers/' || o.slug,
            count(DISTINCT ev.id)::int, count(DISTINCT ev.id) FILTER (WHERE ev.starts_at >= now())::int, max(ev.starts_at),
            o.official_links->>'instagram', o.official_links->>'website', o.official_links->>'facebook',
            o.official_links->>'email', o.official_links->>'phone',
            EXISTS (SELECT 1 FROM handles h WHERE h.active AND h.handle = lower(o.official_links->>'instagram'))
     FROM organisers o JOIN event_organisers eo ON eo.organiser_id = o.id JOIN ev ON ev.id = eo.event_id JOIN cities c ON c.id = ev.city_id
     GROUP BY o.id
     ORDER BY 6 DESC, 5 DESC, 2`);
  return rows.map((r) => ({ ...r, url: `${site.url}${r.url}` }));
}

/** The link a venue or organiser can put on their own site or profile. Plain HTML, no script. */
export function listedSnippet(url: string, name: string): string {
  const safe = name.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<a href="${url}" title="${safe} on Pick the Joint">Listed on Pick the Joint</a>`;
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function outreachCsv(rows: OutreachRow[]): string {
  const head = ["type", "name", "city", "page", "events_listed", "upcoming", "last_event", "instagram", "website", "facebook", "email", "phone", "instagram_tracked", "listed_snippet"];
  const lines = rows.map((r) => [r.kind, r.name, r.city, r.url, r.events_listed, r.upcoming, r.last_event, r.instagram, r.website, r.facebook, r.email, r.phone,
    r.tracked_handle ? "yes" : "no", listedSnippet(r.url, r.name)].map(cell).join(","));
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}
