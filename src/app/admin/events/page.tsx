import { findEvents } from "@/lib/admin-data";
import { requireAdmin } from "@/lib/admin-session";
import { eventAction } from "../actions";
import { Msg, ist } from "../components";

export const metadata = { title: "Events" };

export default async function EventsPage({ searchParams }: { searchParams: Promise<{ q?: string; msg?: string }> }) {
  await requireAdmin();
  const { q = "", msg } = await searchParams;
  const rows = await findEvents(q);
  return (
    <>
      <h1>Events</h1>
      <Msg msg={msg} />
      <p className="muted small">Mark an event cancelled (the page stays up with a notice), take a page down after a takedown request (it stops being served), or restore it. Every change keeps the reason.</p>
      <form method="get" className="filters">
        <label>Find by title or slug <input type="search" name="q" defaultValue={q} /></label>
        <button className="button">Search</button>
      </form>
      {!q && <p className="small muted">Showing upcoming events.</p>}
      <table className="admin-table">
        <thead><tr><th>Event</th><th>Date</th><th>State</th><th>Change</th></tr></thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className={!e.is_published || e.status === "cancelled" ? "warn" : undefined}>
              <td>
                <a href={`/${e.city}/events/${e.slug}`} target="_blank">{e.title}</a>
                <span className="block muted small">{e.origin}</span>
                {e.actions.slice(0, 3).map((a, i) => <span key={i} className="block small">{a.action} {ist(a.created_at)}: {a.reason}</span>)}
              </td>
              <td>{e.local_date}</td>
              <td>{e.is_published ? "published" : "not published"} · {e.status}</td>
              <td>
                <form action={eventAction} className="inline">
                  <input type="hidden" name="id" value={e.id} /><input type="hidden" name="q" value={q} />
                  <select name="action" aria-label="Change">
                    <option value="cancelled">Mark cancelled</option>
                    <option value="removed">Take the page down</option>
                    <option value="restored">Restore</option>
                  </select>
                  <input type="text" name="reason" placeholder="Reason (required)" required aria-label="Reason" />
                  <button className="button ghost small-button">Apply</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
