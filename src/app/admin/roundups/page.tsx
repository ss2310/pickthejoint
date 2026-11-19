import Link from "next/link";
import { roundups as cfg } from "@/config";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-session";
import { deleteRoundup, generateRoundup, setRoundupStatus } from "../roundup-actions";
import { Msg, ist, usd } from "../components";

export const metadata = { title: "Weekly guides" };

export default async function RoundupsAdmin({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  const { msg } = await searchParams;
  const pool = getPool();
  const cities = (await pool.query<{ slug: string; name: string }>("SELECT slug, name FROM cities WHERE is_live ORDER BY name")).rows;
  const rows = (await pool.query<{
    id: number; city: string; slug: string; status: string; title: string; period_start: string; period_end: string;
    events: number; generated_at: Date; published_at: Date | null; model_usd: number;
  }>(
    `SELECT r.id, c.slug AS city, r.slug, r.status, r.title, r.period_start::text, r.period_end::text, cardinality(r.event_ids) AS events,
            r.generated_at, r.published_at, r.model_usd::float AS model_usd
     FROM roundups r JOIN cities c ON c.id = r.city_id ORDER BY r.period_start DESC, c.slug LIMIT 60`)).rows;

  return (
    <>
      <h1>Weekly guides</h1>
      <Msg msg={msg} />
      <p className="small">
        Every Thursday the morning ingest run drafts a guide per city for the Friday to Thursday ahead
        {cfg.enabled ? "" : " (switched off: ROUNDUPS=off is set)"}. The model writes only the headline and the overview, in English and Hindi
        (about a cent per city); the event lists come from the listings. Nothing is public until you publish it.
      </p>
      <section className="form-card">
        <h2>Draft now</h2>
        <form action={generateRoundup} className="form-grid">
          <label className="field">City
            <select name="city">{cities.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select>
          </label>
          <label className="field check"><input type="checkbox" name="again" /> Draft again (replaces the current draft)</label>
          <p className="wide"><button className="button">Draft this week&apos;s guide</button></p>
        </form>
      </section>
      <table className="table">
        <thead><tr><th>Guide</th><th>Covers</th><th>Events</th><th>Status</th><th>Cost</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><Link href={`/admin/roundups/${r.id}`}>{r.title}</Link><br /><span className="muted small">/{r.city}/guide/{r.slug}</span></td>
              <td className="small">{r.period_start} to {r.period_end}</td>
              <td>{r.events}</td>
              <td className="small">{r.status === "published" ? <>published {ist(r.published_at)}<br /><a href={`/${r.city}/guide/${r.slug}`} target="_blank">open</a></> : <>draft, {ist(r.generated_at)}</>}</td>
              <td className="small">{usd(r.model_usd)}</td>
              <td>
                <form action={setRoundupStatus}>
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="status" value={r.status === "published" ? "draft" : "published"} />
                  <button className={r.status === "published" ? "button ghost" : "button"}>{r.status === "published" ? "Unpublish" : "Publish"}</button>
                </form>
                {r.status === "draft" && (
                  <form action={deleteRoundup}><input type="hidden" name="id" value={r.id} /><button className="linkish small">Delete draft</button></form>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="muted">No guides yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
