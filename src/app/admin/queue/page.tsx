import Link from "next/link";
import { getPool } from "@/lib/db";
import { queueCounts, queueItems, type QueueItem } from "@/lib/admin-data";
import { requireAdmin } from "@/lib/admin-session";
import { lookupOf } from "@/lib/pipeline/second-look";
import type { SubmissionRow } from "@/lib/submissions";
import { approveItem, rejectItem } from "../actions";
import { Msg, Raw, SecondLook, Thumb, ist } from "../components";

export const metadata = { title: "Review queue" };

type Fact = { value: unknown; confidence: number };

function FactLine({ label, f }: { label: string; f?: Fact | null }) {
  if (!f || f.value === null || f.value === "") return <li className="muted">{label}: –</li>;
  return <li>{label}: <strong>{String(f.value)}</strong> <span className={f.confidence < 0.8 ? "tag tag-warn" : "muted small"}>{f.confidence.toFixed(2)}</span></li>;
}

function Buttons({ item, from, approveLabel = "Approve", editable }: { item: QueueItem; from: string; approveLabel?: string; editable?: boolean }) {
  return (
    <div className="item-actions">
      <form action={approveItem}><input type="hidden" name="id" value={item.id} /><input type="hidden" name="from" value={from} /><button className="button small-button">{approveLabel}</button></form>
      {editable && <Link className="button ghost small-button" href={`/admin/queue/${item.id}`}>Edit</Link>}
      <form action={rejectItem} className="reject">
        <input type="hidden" name="id" value={item.id} /><input type="hidden" name="from" value={from} />
        <input type="text" name="note" placeholder="Reason (optional)" aria-label="Reason for rejecting" />
        <button className="button ghost small-button">Reject</button>
      </form>
    </div>
  );
}

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ type?: string; status?: string; msg?: string }> }) {
  await requireAdmin();
  const q = await searchParams;
  const status = ["open", "approved", "rejected", "resolved"].includes(q.status ?? "") ? q.status! : "open";
  const [items, counts] = await Promise.all([queueItems({ type: q.type, status }), queueCounts()]);
  const pool = getPool();
  const subIds = items.filter((i) => i.item_type === "submission").map((i) => i.item_id);
  const subs = new Map((await pool.query<SubmissionRow & { city: string | null }>(
    "SELECT s.*, c.slug AS city FROM submissions s LEFT JOIN cities c ON c.id = s.city_id WHERE s.id = ANY($1::bigint[])", [subIds])).rows.map((s) => [s.id, s]));
  const evIds = items.filter((i) => i.item_type === "event").map((i) => i.item_id);
  const events = new Map((await pool.query<{ id: number; title: string; path: string; is_published: boolean; status: string }>(
    "SELECT e.id, e.title, '/' || c.slug || '/events/' || e.slug AS path, e.is_published, e.status FROM events e JOIN cities c ON c.id = e.city_id WHERE e.id = ANY($1::bigint[])",
    [evIds])).rows.map((e) => [e.id, e]));
  const from = `/admin/queue${q.type ? `?type=${q.type}` : ""}`;

  return (
    <>
      <h1>Review queue</h1>
      <Msg msg={q.msg} />
      <nav className="chips" aria-label="Filter">
        <Link href="/admin/queue">All open</Link>
        {counts.map((c) => <Link key={c.item_type} href={`/admin/queue?type=${c.item_type}`}>{c.item_type} ({c.n})</Link>)}
        <Link href={`/admin/queue?status=approved${q.type ? `&type=${q.type}` : ""}`}>Approved</Link>
        <Link href={`/admin/queue?status=rejected${q.type ? `&type=${q.type}` : ""}`}>Rejected</Link>
      </nav>
      {items.length === 0 && <p className="empty">Nothing here.</p>}
      <ol className="queue">
        {items.map((item) => {
          const p = item.payload as Record<string, unknown>;
          const open = item.status === "open";
          return (
            <li key={item.id} className="form-card">
              <p className="small muted">#{item.id} · {item.item_type} · {ist(item.created_at)}{!open && ` · ${item.status}: ${item.resolution_note ?? ""}`}</p>
              <h2 className="item-title">{item.reason}</h2>

              {item.item_type === "submission" && (() => {
                const s = subs.get(item.item_id!);
                if (!s) return <p>Submission {item.item_id} not found.</p>;
                const f = s.fields;
                return (
                  <>
                    <ul className="facts-list">
                      <li>Title: <strong>{f.title || "–"}</strong></li>
                      <li>When: <strong>{f.date || "–"}{f.start_time && ` ${f.start_time}`}{f.end_date && ` to ${f.end_date}`}{f.end_time && ` ${f.end_time}`}</strong></li>
                      <li>Venue: <strong>{f.venue || "–"}</strong>{f.venue_address && `, ${f.venue_address}`}{f.area && ` (${f.area})`} · {s.city ?? "no city"}</li>
                      <li>Category: {f.category || "–"} · Price: {f.is_free ? "free" : f.price || "–"}</li>
                      {f.booking_url && <li>Booking: <a href={f.booking_url} rel="noopener nofollow">{f.booking_url}</a></li>}
                      {f.instagram_url && <li>Instagram: <a href={f.instagram_url} rel="noopener nofollow">{f.instagram_url}</a></li>}
                      {f.performers && <li>Performers: {f.performers}</li>}
                      {f.organiser && <li>Organiser: {f.organiser}</li>}
                      {f.note && <li>Note: {f.note}</li>}
                      <li>From: {s.submitter.name || "–"} · {s.submitter.contact || "–"} · via {s.channel}</li>
                    </ul>
                    {s.poster_id && <p><Thumb posterId={s.poster_id} alt="Poster photo sent with this submission" /></p>}
                    {s.screening && <ul className="small notes">{s.screening.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                    {open && <Buttons item={item} from={from} approveLabel="Approve and publish" editable />}
                  </>
                );
              })()}

              {item.item_type === "raw_post" && (() => {
                const e = p.event as Record<string, Fact> | null;
                const lookup = lookupOf(p);
                const approve = !e ? "Fill in" : lookup && lookup.found.length > 0 ? "Approve with the found facts" : "Approve as shown";
                return (
                  <>
                    <p className="small">{String(p.source ?? "")} {p.handle ? `@${p.handle}` : ""} · {p.url ? <a href={String(p.url)} rel="noopener nofollow">source post</a> : null}</p>
                    {e ? (
                      <ul className="facts-list">
                        <FactLine label="Title" f={e.title} /><FactLine label="Date" f={e.start_date} /><FactLine label="Time" f={e.start_time} />
                        <FactLine label="Venue" f={e.venue_name} /><FactLine label="City" f={e.city} /><FactLine label="Price" f={e.price_text} /><FactLine label="Category" f={e.category} />
                      </ul>
                    ) : <Raw label="Payload" value={p} />}
                    <SecondLook lookup={lookup} />
                    {open && <Buttons item={item} from={from} approveLabel={approve} editable />}
                  </>
                );
              })()}

              {item.item_type === "event" && (() => {
                const e = events.get(item.item_id!);
                return (
                  <>
                    {e ? <p><a href={e.path} target="_blank">{e.title}</a> · {e.is_published ? "published" : "not published"} · {e.status}</p> : <p>Event {item.item_id} not found.</p>}
                    <Raw label="Details" value={p} />
                    {open && <Buttons item={item} from={from} approveLabel="Publish" editable />}
                  </>
                );
              })()}

              {item.item_type === "venue_geocode" && (
                <>
                  <p className="small">Venue: {String(p.venue ?? "")} · looked up as “{String(p.query ?? "")}”</p>
                  <ol className="small">
                    {((p.candidates ?? []) as { name: string; lat: number; lng: number; confidence: number }[]).map((c, i) => (
                      <li key={i}>
                        {c.name} ({c.confidence}) · <a href={`https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}#map=17/${c.lat}/${c.lng}`} rel="noopener">map</a>
                        {open && <form action={approveItem} className="inline"><input type="hidden" name="id" value={item.id} /><input type="hidden" name="from" value={from} /><input type="hidden" name="candidate" value={i} /><button className="linkish">Use this</button></form>}
                      </li>
                    ))}
                  </ol>
                  {open && <form action={rejectItem}><input type="hidden" name="id" value={item.id} /><input type="hidden" name="from" value={from} /><button className="button ghost small-button">None of these</button></form>}
                </>
              )}

              {item.item_type === "poster" && (
                <>
                  <p><Thumb posterId={item.item_id!} alt="Poster photo" /></p>
                  <p className="small">{String(p.notes ?? p.error ?? "")}</p>
                  {open && <Buttons item={item} from={from} approveLabel="Type in the facts" />}
                </>
              )}

              {!["submission", "raw_post", "event", "venue_geocode", "poster"].includes(item.item_type) && (
                <>
                  {typeof p.path === "string" && <p><a href={p.path} target="_blank">{String(p.name ?? p.path)}</a></p>}
                  <Raw label="Details" value={p} />
                  {open && <Buttons item={item} from={from} approveLabel="Mark reviewed" />}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
