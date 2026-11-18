import Link from "next/link";
import { sourcing } from "@/config";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-session";
import { censusGaps, censusSummary } from "@/lib/pipeline/census";
import { CENSUS_TYPES } from "@/lib/pipeline/census-import";
import { addCensusPlace, addVenueHandle, ignoreCensusPlace } from "../sourcing-actions";
import { Msg, ist } from "../components";

export const metadata = { title: "Venues" };

const SOURCE: Record<string, string> = { osm: "OpenStreetMap", instagram_location: "Instagram location", manual: "added by hand", event: "from an event" };

export default async function VenuesPage({ searchParams }: { searchParams: Promise<{ msg?: string; gap?: string; type?: string }> }) {
  await requireAdmin();
  const { msg, gap: g, type } = await searchParams;
  const gap = g === "quiet" ? "quiet" : "no_handle";
  const t = (CENSUS_TYPES as readonly string[]).includes(type ?? "") ? type : undefined;
  const pool = getPool();
  const [summary, rows] = await Promise.all([censusSummary(pool), censusGaps(pool, { gap, type: t })]);
  const here = `/admin/venues?gap=${gap}${t ? `&type=${t}` : ""}`;
  const link = (q: { gap?: string; type?: string | null }) => {
    const p = new URLSearchParams({ gap: q.gap ?? gap });
    const ty = q.type === undefined ? t : q.type;
    if (ty) p.set("type", ty);
    return `/admin/venues?${p}`;
  };
  return (
    <>
      <h1>Venues</h1>
      <Msg msg={msg} />
      <p className="muted small">
        The census of places where events happen: OpenStreetMap places (refreshed on the first of each month), every venue we list, Instagram
        location tags from the weekly hashtag pull, and places added by hand. A place gets a public page only once an event there is published.
        Map data © OpenStreetMap contributors.
      </p>

      <h2>Census by type</h2>
      <table className="admin-table">
        <thead><tr><th>City</th><th>Type</th><th>Places</th><th>With an Instagram handle</th><th>Handle tracked</th><th>Event in {sourcing.census.quietDays} days</th></tr></thead>
        <tbody>
          {summary.map((s) => (
            <tr key={`${s.city}-${s.venue_type}`}>
              <td>{s.city}</td><td><Link href={link({ type: s.venue_type })}>{s.venue_type}</Link></td>
              <td>{s.places}</td><td>{s.with_handle}</td><td>{s.tracked}</td><td>{s.with_recent_event}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{gap === "no_handle" ? "No Instagram handle on record" : `No event in the last ${sourcing.census.quietDays} days`} ({rows.length})</h2>
      <p className="small">
        <Link href={link({ gap: "no_handle" })}>No handle</Link> · <Link href={link({ gap: "quiet" })}>No recent event</Link>
        {t && <> · showing {t} only (<Link href={link({ type: null })}>all types</Link>)</>}
      </p>
      <table className="admin-table">
        <thead><tr><th>Place</th><th>Type</th><th>Handle</th><th>Last event</th><th>Add a handle</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.venue_path ? <a href={r.venue_path} target="_blank">{r.name}</a> : r.name}
                <span className="block muted small">{[r.address, SOURCE[r.source] ?? r.source].filter(Boolean).join(" · ")}</span>
                {r.facebook_url && <span className="block small"><a href={r.facebook_url} rel="noopener nofollow" target="_blank">Facebook</a></span>}
              </td>
              <td>{r.venue_type}</td>
              <td>{r.handle ? <>@{r.handle}{r.handle_tracked ? "" : <span className="block muted small">not tracked</span>}</> : "–"}</td>
              <td className="small">{ist(r.last_event)}</td>
              <td>
                <form action={addVenueHandle} className="inline">
                  <input type="hidden" name="id" value={r.id} /><input type="hidden" name="back" value={here} />
                  <input name="handle" aria-label={`Instagram handle for ${r.name}`} placeholder="handle" defaultValue={r.handle_tracked ? "" : r.handle ?? ""} size={14} />
                  <select name="tier" aria-label="Tier" defaultValue="B"><option>A</option><option>B</option></select>
                  <input type="hidden" name="type" value="venue" />
                  <button className="button small-button">Track</button>
                </form>
              </td>
              <td>
                <form action={ignoreCensusPlace}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="back" value={here} />
                  <button className="button ghost small-button">Hide</button></form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Add a place</h2>
      <form action={addCensusPlace} className="form-grid">
        <input type="hidden" name="city" value="indore" />
        <label className="field">Name<input name="name" required /></label>
        <label className="field">Type<select name="type" defaultValue="other">{CENSUS_TYPES.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field">Address<input name="address" /></label>
        <label className="field">Instagram handle<input name="instagram" /></label>
        <label className="field">Facebook page link<input name="facebook" /></label>
        <p><button className="button">Add to census</button></p>
      </form>
      <p className="muted small">Many at once: <code>npm run census -- --city indore --csv places.csv</code> with columns name,type,address,instagram,facebook.</p>
    </>
  );
}
