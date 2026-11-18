import { budgets, dailyCaps } from "@/config";
import { searchReport, type SearchQueryRow } from "@/lib/admin-data";
import { requireAdmin } from "@/lib/admin-session";
import { monthSpend } from "@/lib/budget-guard";
import { ist, usd } from "../components";

export const metadata = { title: "Search" };

const METHOD: Record<string, string> = {
  rules: "rules", cache: "cached model reading", model: "model (fast tier)", keyword_fallback: "keyword fallback",
};

/** How a query was read, in one line: the filters and words, then why the model was not used, if it was not. */
function reading(p: Record<string, unknown> | null): string {
  if (!p) return "–";
  const dates = p.dates as { from: string; to: string } | null | undefined;
  const words = (p.keywords as string[] | undefined) ?? [];
  const when = p.when === "weekday" || p.when === "next_weekday" ? `${p.when} ${["sun", "mon", "tue", "wed", "thu", "fri", "sat"][p.weekday as number] ?? ""}` : p.when;
  return [
    when && `when ${when}${dates ? ` (${dates.from === dates.to ? dates.from : `${dates.from} to ${dates.to}`})` : ""}`,
    p.category && `category ${p.category}`, p.area && `area ${p.area}`, p.city && `city ${p.city}`, p.price && `price ${p.price}`,
    words.length > 0 && `words ${words.join(p.keywordMode === "any" ? " | " : " + ")}`,
    p.relaxed && "nothing had the words: shown without them",
    p.reason && `model not used: ${p.reason}`,
  ].filter(Boolean).join(" · ") || "nothing recognised: everything upcoming";
}

function Queries({ rows, empty }: { rows: SearchQueryRow[]; empty: string }) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return (
    <table className="admin-table">
      <thead><tr><th>Query</th><th>Searches</th><th>With no results</th><th>Last read by</th><th>Last results</th><th>Last searched</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.normalized}>
            <td>{r.example}</td><td>{r.searches}</td><td>{r.zero}</td><td>{METHOD[r.last_method] ?? r.last_method}</td>
            <td>{r.last_results}</td><td className="small">{ist(r.last_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function SearchAdmin() {
  await requireAdmin();
  const [r, month] = await Promise.all([searchReport(30), monthSpend("search")]);
  const total = r.methods.reduce((s, m) => s + m.searches, 0);
  return (
    <>
      <h1>Search</h1>
      <p className="muted small">
        Searches typed in plain words on the public search page, last 30 days. Rules read the common patterns for free; the fast-tier model
        is asked only when they cannot, and each answer is cached for 30 days. Queries with no results show which hub pages and handles are missing.
      </p>
      <ul className="stat-row">
        <li><strong>{total}</strong> searches</li>
        {r.methods.map((m) => <li key={m.parse_method}><strong>{m.searches}</strong> {METHOD[m.parse_method] ?? m.parse_method}{m.usd > 0 ? `, ${usd(m.usd)}` : ""}</li>)}
        <li><strong>{r.cached}</strong> cached readings</li>
      </ul>
      <p className="small">
        Model spend on search today (UTC): {usd(r.today.usd)} in {r.today.calls} call{r.today.calls === 1 ? "" : "s"}, daily cap {usd(dailyCaps.search ?? 0)}.
        This month: {usd(month)} of {usd(budgets.search)}. Past either cap, or past the per-address limit, searches quietly use keywords instead.
      </p>

      <h2>Most common queries</h2>
      <Queries rows={r.common} empty="No searches yet." />

      <h2>Queries whose last search found nothing</h2>
      <Queries rows={r.zero} empty="Every recent query found something." />

      <h2>Latest searches</h2>
      <table className="admin-table">
        <thead><tr><th>When</th><th>Query</th><th>Read by</th><th>Understood as</th><th>Results</th><th>Cost</th></tr></thead>
        <tbody>
          {r.recent.map((s) => (
            <tr key={s.id}>
              <td className="small">{ist(s.searched_at)}</td>
              <td>{s.query}{s.locale === "hi" && <span className="block muted small">Hindi page</span>}</td>
              <td>{METHOD[s.parse_method ?? ""] ?? s.parse_method}</td>
              <td className="small">{reading(s.parsed)}</td>
              <td>{s.result_count}</td>
              <td>{s.cost_usd > 0 ? usd(s.cost_usd) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
