import Link from "next/link";
import { submissions as cfg } from "@/config";
import { getPool } from "@/lib/db";
import { posters } from "@/lib/admin-data";
import { requireAdmin } from "@/lib/admin-session";
import { allowedSenders } from "@/lib/inbound-email";
import { Msg, Raw, Thumb, ist } from "../components";

export const metadata = { title: "Poster inbox" };

type Fact = { value: unknown; confidence: number } | undefined;
const show = (f: Fact) => (f && f.value !== null && f.value !== "" ? `${String(f.value)} (${f.confidence.toFixed(2)})` : "–");

export default async function PostersPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  const { msg } = await searchParams;
  const rows = await posters();
  const cities = (await getPool().query<{ slug: string; name: string }>("SELECT slug, name FROM cities WHERE is_live ORDER BY name")).rows;
  const senders = allowedSenders();
  return (
    <>
      <h1>Poster inbox</h1>
      <Msg msg={msg} />
      <section className="form-card">
        <h2>Drop posters</h2>
        <p>Photos of posters from WhatsApp or Telegram groups, up to {cfg.maxInboxFiles} at once (JPEG, PNG or WebP, 8 MB each). Each is read with the same vision extraction as Instagram posters, and every event found becomes a draft in the <Link href="/admin/queue?type=submission">review queue</Link>. Photos are kept privately and deleted after the event.</p>
        <form action="/admin/posters/upload" method="post" encType="multipart/form-data" className="form-grid">
          <label className="field wide">Photos <input type="file" name="posters" accept="image/jpeg,image/png,image/webp" multiple required /></label>
          <label className="field">City
            <select name="city">{cities.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select>
          </label>
          <label className="field wide">Note for all of them (optional) <input type="text" name="note" placeholder="e.g. from the Indore gigs WhatsApp group" /></label>
          <p className="wide"><button className="button">Upload and read</button></p>
        </form>
        <p className="small muted">By email: forward posters to the address set up in Resend. Only mail from {senders.length ? senders.join(", ") : "(no sender allowed yet: set POSTER_EMAIL_SENDERS)"} with SPF or DKIM passing is read.</p>
      </section>

      <h2>Recent posters</h2>
      {rows.length === 0 && <p className="empty">No posters stored.</p>}
      <ol className="queue">
        {rows.map((p) => (
          <li key={p.id} className="form-card poster-row">
            <Thumb posterId={p.id} alt={`Poster ${p.id}`} />
            <div>
              <p className="small muted">#{p.id} · {p.channel} · {p.city ?? "no city"} · {ist(p.created_at)} · {p.width}×{p.height} · deleted after {ist(p.delete_after)}</p>
              {p.original_name && <p className="small">File: {p.original_name}</p>}
              {p.note && <p className="small">Note: {p.note}</p>}
              <p><strong>Reading:</strong> {p.extraction_state}{p.extraction_error ? `: ${p.extraction_error}` : ""}</p>
              {p.extraction && (
                <>
                  <p className="small">{p.extraction.is_event_post ? `${p.extraction.events.length} event(s) found` : "Not an event poster"}{p.extraction.notes ? `. Model's note: ${p.extraction.notes}` : ""}</p>
                  {p.extraction.events.map((e, i) => {
                    const ev = e as Record<string, Fact>;
                    return (
                      <ul key={i} className="facts-list small">
                        <li>Title: {show(ev.title)}</li><li>Date: {show(ev.start_date)} · time {show(ev.start_time)}</li>
                        <li>Venue: {show(ev.venue_name)} · area {show(ev.area)} · city {show(ev.city)}</li>
                        <li>Price: {show(ev.price_text)} · free {show(ev.is_free)} · category {show(ev.category)}</li>
                      </ul>
                    );
                  })}
                  <Raw label="Full extraction" value={p.extraction} />
                </>
              )}
              {p.submissions.length > 0 && (
                <p className="small">Drafts: {p.submissions.map((s, i) => <span key={s.id}>{i > 0 && "; "}#{s.id} “{s.title}” ({s.status})</span>)}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
