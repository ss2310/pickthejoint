import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-session";
import { eventFields, loadEvent } from "@/lib/event-edit";
import { saveEventEdit } from "../../actions";
import { Msg, ist } from "../../components";

export const metadata = { title: "Edit event" };

export default async function EditEvent({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  const pool = getPool();
  const e = await loadEvent(pool, Number((await params).id));
  if (!e) notFound();
  const { msg } = await searchParams;
  const f = eventFields(e);
  const categories = (await pool.query<{ slug: string; name: string }>("SELECT slug, name FROM categories ORDER BY sort_order")).rows;
  const actions = (await pool.query<{ action: string; reason: string; created_at: Date }>(
    "SELECT action, reason, created_at FROM event_actions WHERE event_id = $1 ORDER BY created_at DESC LIMIT 8", [e.id])).rows;
  const path = `/${e.city_slug}/events/${e.slug}`;

  return (
    <>
      <p><Link href="/admin/events">← Events</Link></p>
      <h1>Edit: {e.title}</h1>
      <Msg msg={msg} />
      <p className="small">
        <a href={path} target="_blank">{path}</a> · {e.is_published ? "published" : "not published"} · {e.status} · {e.city_name}
      </p>
      <section className="form-card">
        <form action={saveEventEdit} className="form-grid">
          <input type="hidden" name="id" value={e.id} />
          <label className="field wide">Title<input type="text" name="title" defaultValue={f.title} required /></label>
          <label className="field">Date<input type="date" name="date" defaultValue={f.date} required /></label>
          <label className="field">Start time (leave empty if not announced)<input type="time" name="start_time" defaultValue={f.start_time} /></label>
          <label className="field">Last day (only if it runs for more than one day)<input type="date" name="end_date" defaultValue={f.end_date} /></label>
          <label className="field">End time<input type="time" name="end_time" defaultValue={f.end_time} /></label>
          <label className="field wide">Venue<input type="text" name="venue" defaultValue={f.venue} required /></label>
          <label className="field">Category
            <select name="category" defaultValue={f.category}>
              <option value="">(none)</option>
              {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
          </label>
          <label className="field">Price<input type="text" name="price" defaultValue={f.price} /></label>
          <label className="field check"><input type="checkbox" name="is_free" defaultChecked={f.is_free} /> Free entry</label>
          <label className="field wide">Booking link<input type="url" name="booking_url" defaultValue={f.booking_url} /></label>
          <label className="field wide">Description (our own words, from the facts only)
            <textarea name="description" defaultValue={e.description ?? ""} rows={6} />
          </label>
          <label className="field check wide">
            <input type="checkbox" name="rewrite" defaultChecked /> Write the description again from the corrected facts (costs about half a cent). If you change the text above yourself, your text is used instead.
          </label>
          <label className="field wide">Reason for the change (required, kept with the event)
            <input type="text" name="reason" required placeholder="e.g. wrong date entered: the show is on the 21st" />
          </label>
          <p className="wide"><button className="button">Save the correction</button></p>
          <p className="wide muted small">
            The description states the date, time, place and price in words, so leave the box ticked when you correct any of them.
            If the title or the date changes, the page gets a new address and the old address redirects to it.
            Performers, organisers and sources are not changed here.
          </p>
        </form>
      </section>
      {actions.length > 0 && (
        <section>
          <h2 className="item-title">Earlier changes</h2>
          <ul className="small notes">
            {actions.map((a, i) => <li key={i}>{a.action} {ist(a.created_at)}: {a.reason}</li>)}
          </ul>
        </section>
      )}
    </>
  );
}
