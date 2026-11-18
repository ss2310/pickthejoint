import { budgets } from "@/config";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-session";
import { coverageReport, storedReports, weekStartIst, type CoverageReport } from "@/lib/coverage";
import { monthSpend } from "@/lib/budget-guard";
import { sourcingData } from "@/lib/pipeline/sourcing-data";
import { addFacebookPage, toggleFacebookPage } from "../sourcing-actions";
import { Msg, ist, usd } from "../components";

export const metadata = { title: "Coverage" };

const NAMES: Record<string, string> = { instagram: "Instagram handles", submissions: "Submissions and posters" };
const sourceName = (s: string) => NAMES[s] ?? s.replace(/^web:/, "web calendar: ").replace(/^news:/, "news: ").replace(/^facebook:/, "Facebook: ").replace(/^google:/, "Google: ");

function Report({ r, title }: { r: CoverageReport; title: string }) {
  return (
    <section>
      <h3>{title}</h3>
      <p className="small">
        {r.eventsPublished} event(s) published · {r.multiSourceShare === null ? "–" : `${Math.round(r.multiSourceShare * 100)}%`} also found by a second source ·
        {" "}{r.newVenues} new venue(s) · {r.newSuggestedHandles} new suggested handle(s) · {r.handlesAdded} handle(s) added ·
        {" "}census places: {Object.entries(r.newCensusPlaces).map(([k, v]) => `${v} ${k}`).join(", ") || "none new"} ·
        {" "}discovery {usd(r.discoveryUsd)} · total {usd(r.totalUsd)}
      </p>
      <table className="admin-table">
        <thead><tr><th>Source</th><th>Published</th><th>Also found elsewhere</th><th>Items fetched</th><th>Merged into a known event</th><th>Scraping</th><th>Model</th><th>Cost per published event</th></tr></thead>
        <tbody>
          {r.bySource.map((l) => (
            <tr key={l.source}>
              <td>{sourceName(l.source)}</td><td>{l.published}</td><td>{l.alsoFoundElsewhere}</td><td>{l.itemsFetched}</td><td>{l.mergedIntoKnown}</td>
              <td>{usd(l.scrapeUsd)}</td><td>{usd(l.modelUsd)}</td><td>{l.costPerPublishedUsd === null ? "–" : usd(l.costPerPublishedUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default async function CoveragePage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  await requireAdmin();
  const { msg } = await searchParams;
  const pool = getPool();
  const cities = (await pool.query<{ slug: string; name: string }>("SELECT slug, name FROM cities WHERE is_live ORDER BY id")).rows;
  const thisWeek = weekStartIst(new Date());
  const live = (await Promise.all(cities.map((c) => coverageReport(pool, c.slug, thisWeek)))).filter((r): r is CoverageReport => !!r);
  const stored = await storedReports(pool);
  const state = (await pool.query<{ source_key: string; last_fetched_at: Date | null }>(
    "SELECT source_key, last_fetched_at FROM source_state WHERE source_key LIKE 'web:%' OR source_key LIKE 'facebook:%' OR source_key LIKE 'discovery:%' ORDER BY source_key")).rows;
  const lastRead = new Map(state.map((s) => [s.source_key, s.last_fetched_at]));
  const pages = (await pool.query<{ id: number; city: string; page: string; name: string | null; added_via: string; active: boolean; last_checked_at: Date | null; events_seen: number }>(
    `SELECT f.id, c.slug AS city, f.page, f.name, f.added_via, f.active, f.last_checked_at, f.events_seen
     FROM facebook_pages f JOIN cities c ON c.id = f.city_id ORDER BY f.active DESC, f.events_seen DESC, f.page`)).rows;
  const spend = {
    discovery: await monthSpend("discovery", { pool }), facebookEvents: await monthSpend("facebookEvents", { pool }), webCalendars: await monthSpend("webCalendars", { pool }),
  };
  const data = sourcingData();
  return (
    <>
      <h1>Coverage</h1>
      <Msg msg={msg} />
      <p className="muted small">
        Which sources find events, and what each published event costs by source. Weeks run Monday to Sunday (IST); last week&apos;s report is stored every Monday.
        An event counts under the source that found it first. Cost = scraping spend in the week plus model spend on that source&apos;s items.
      </p>
      <p className="small">
        This month: discovery {usd(spend.discovery)} of {usd(budgets.discovery)} · Facebook events {usd(spend.facebookEvents)} of {usd(budgets.facebookEvents)} ·
        {" "}web calendars and Facebook reading (model) {usd(spend.webCalendars)} of {usd(budgets.webCalendars)}
      </p>

      <h2>This week so far</h2>
      {live.map((r) => <Report key={r.city} r={r} title={`${r.city}, week of ${r.weekStart}`} />)}

      <h2>Weekly reports</h2>
      {stored.length === 0 ? <p className="muted">The first one is stored next Monday.</p> : stored.map((r) => <Report key={`${r.city}-${r.weekStart}`} r={r} title={`${r.city}, ${r.weekStart} to ${r.weekEnd}`} />)}

      <h2>Web calendars</h2>
      <p className="muted small">From data/sourcing.json. Each was checked for terms and robots.txt before being switched on (see docs/sources.md); robots.txt is read again on every run.</p>
      <table className="admin-table">
        <thead><tr><th>City</th><th>Source</th><th>On</th><th>Every</th><th>Last read</th><th>Checked</th></tr></thead>
        <tbody>
          {Object.entries(data).flatMap(([city, d]) => d.calendars.map((c) => (
            <tr key={`${city}-${c.key}`}>
              <td>{city}</td><td><a href={c.url} rel="noopener nofollow" target="_blank">{c.name}</a></td><td>{c.enabled ? "yes" : "no"}</td>
              <td>{c.everyDays} days</td><td className="small">{ist(lastRead.get(`web:${city}:${c.key}`))}</td><td className="small">{c.checked}</td>
            </tr>
          )))}
        </tbody>
      </table>
      <p className="small">Hashtag discovery last ran: {cities.map((c) => `${c.name} ${ist(lastRead.get(`discovery:${c.slug}`))}`).join(" · ")}</p>

      <h2>Facebook pages ({pages.filter((p) => p.active).length} on)</h2>
      <p className="muted small">
        Public pages whose upcoming events are read once a week, logged out, through Apify. Pages linked from venue and organiser pages are added
        automatically. Last weekly run: {cities.map((c) => `${c.name} ${ist(lastRead.get(`facebook:${c.slug}`))}`).join(" · ")}
      </p>
      <form action={addFacebookPage} className="form-grid">
        <input type="hidden" name="city" value="indore" />
        <label className="field">Facebook page link<input name="url" placeholder="https://www.facebook.com/somevenue" required /></label>
        <label className="field">Name (optional)<input name="name" /></label>
        <p><button className="button">Add page</button></p>
      </form>
      <table className="admin-table">
        <thead><tr><th>Page</th><th>City</th><th>Added</th><th>Events seen</th><th>Last checked</th><th></th></tr></thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.id} className={p.active ? undefined : "muted"}>
              <td><a href={`https://www.facebook.com/${p.page}/upcoming_hosted_events`} rel="noopener nofollow" target="_blank">{p.name ?? p.page}</a></td>
              <td>{p.city}</td><td>{p.added_via === "manual" ? "by hand" : "from a page link"}</td><td>{p.events_seen}</td><td className="small">{ist(p.last_checked_at)}</td>
              <td><form action={toggleFacebookPage}><input type="hidden" name="id" value={p.id} /><button className="button ghost small-button">{p.active ? "Switch off" : "Switch on"}</button></form></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
