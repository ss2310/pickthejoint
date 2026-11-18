import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-session";
import { listedSnippet, outreachList } from "@/lib/outreach";
import { site } from "@/config";
import { ist } from "../components";

export const metadata = { title: "Outreach" };

export default async function OutreachPage() {
  await requireAdmin();
  const rows = await outreachList(getPool());
  const example = rows[0] ? listedSnippet(rows[0].url, rows[0].name) : listedSnippet(`${site.url}/indore/venues/example`, "Example venue");
  return (
    <>
      <h1>Outreach list</h1>
      <p className="muted small">
        Organisers and venues with events on the site, with their page and the public contact on record, to invite them to claim their free listing
        and send future events through the submission form. Contact details are only the official links already on their pages.
      </p>
      {/* A plain GET form: a file download, not a page to prefetch. */}
      <form action="/admin/outreach/export" method="get"><button className="button">Download CSV</button></form>
      <h2>&quot;Listed on Pick the Joint&quot; link</h2>
      <p className="small">A plain link they can paste into their website or profile (the CSV has one per row, with their own page address):</p>
      <pre className="raw">{example}</pre>
      <h2>{rows.length} organisers and venues</h2>
      <table className="admin-table">
        <thead><tr><th>Name</th><th>Type</th><th>Events</th><th>Upcoming</th><th>Last event</th><th>Public contact</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.url}>
              <td><a href={r.url} target="_blank">{r.name}</a><span className="block muted small">{r.city}</span></td>
              <td>{r.kind}</td><td>{r.events_listed}</td><td>{r.upcoming}</td><td className="small">{ist(r.last_event)}</td>
              <td className="small">
                {[r.instagram && `@${r.instagram.replace(/^@/, "")}${r.tracked_handle ? "" : " (not tracked)"}`, r.website, r.facebook, r.email, r.phone].filter(Boolean).join(" · ") || "none on record"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
