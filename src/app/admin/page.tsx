import Link from "next/link";
import { lastRuns, overviewCounts, queueCounts, spend } from "@/lib/admin-data";
import { requireAdmin } from "@/lib/admin-session";
import { Msg, Raw, ist, usd } from "./components";

export const metadata = { title: "Overview" };

const BUDGET_NAMES: Record<string, string> = {
  scrape: "Scrape and other cash spend (SCRAPE_BUDGET_USD)", model: "Claude API (MODEL_BUDGET_USD)",
  reelTranscript: "inside scrape: reel transcripts", googleEvents: "inside scrape: Google event results",
  newsCalendars: "inside model: news roundups", enrichment: "inside model: enrichment", translation: "inside model: Hindi translation",
  submissions: "inside model: public submissions", search: "inside model: search parsing (also capped per day)",
  citations: "inside scrape: AI citation checks (GeoGrid)",
};

export default async function Overview({ searchParams }: { searchParams: Promise<{ msg?: string; setup?: string }> }) {
  await requireAdmin();
  const q = await searchParams;
  const [counts, byType, money, runs] = await Promise.all([overviewCounts(), queueCounts(), spend(), lastRuns()]);
  return (
    <>
      <h1>Overview</h1>
      {q.setup === "done" && <p className="banner" role="status">Password set and signed in. Now remove ADMIN_SETUP_TOKEN from the web service.</p>}
      <Msg msg={q.msg} />
      <ul className="stat-row">
        <li><Link href="/admin/queue"><strong>{counts.openReview}</strong> open review items</Link></li>
        <li><Link href="/admin/queue?type=submission"><strong>{counts.pendingSubmissions}</strong> submissions waiting</Link></li>
        <li><Link href="/admin/handles"><strong>{counts.suggestedHandles}</strong> suggested handles</Link></li>
        <li><strong>{counts.publishedUpcoming}</strong> upcoming published events</li>
        <li><Link href="/admin/posters"><strong>{counts.postersStored}</strong> poster photos stored</Link></li>
      </ul>
      {byType.length > 0 && (
        <p className="small">Open by type: {byType.map((t, i) => <span key={t.item_type}>{i > 0 && ", "}<Link href={`/admin/queue?type=${t.item_type}`}>{t.item_type} ({t.n})</Link></span>)}</p>
      )}

      <h2>Spend this month</h2>
      <p className="muted small">Calendar month in UTC, as the budget guard counts it. Paid jobs stop at a cap; a warning is logged at 80%.</p>
      <table className="admin-table">
        <thead><tr><th>Budget</th><th>Spent</th><th>Cap</th><th>Used</th></tr></thead>
        <tbody>
          {Object.entries(money.caps).map(([name, v]) => {
            const pct = v.capUsd > 0 ? (v.spentUsd / v.capUsd) * 100 : 0;
            return (
              <tr key={name} className={pct >= 80 ? "warn" : undefined}>
                <td>{BUDGET_NAMES[name] ?? name}</td><td>{usd(v.spentUsd)}</td><td>{usd(v.capUsd)}</td>
                <td><meter min={0} max={100} value={Math.min(pct, 100)} low={60} high={80} optimum={0} /> {pct.toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="two-col">
        <section>
          <h3>By service and model</h3>
          <table className="admin-table">
            <thead><tr><th>Service</th><th>Model or actor</th><th>Calls</th><th>Spent</th></tr></thead>
            <tbody>{money.byService.map((r, i) => <tr key={i}><td>{r.service}</td><td>{r.model ?? "–"}</td><td>{r.calls}</td><td>{usd(r.usd)}</td></tr>)}</tbody>
          </table>
        </section>
        <section>
          <h3>By job</h3>
          <table className="admin-table">
            <thead><tr><th>Job</th><th>Calls</th><th>Spent</th></tr></thead>
            <tbody>{money.byJob.map((r) => <tr key={r.job_name}><td>{r.job_name}</td><td>{r.calls}</td><td>{usd(r.usd)}</td></tr>)}</tbody>
          </table>
        </section>
      </div>

      <h2>Last run of each job</h2>
      <table className="admin-table">
        <thead><tr><th>Job</th><th>Started (IST)</th><th>Finished</th><th>Status</th><th>Report</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className={r.status === "failed" ? "warn" : undefined}>
              <td>{r.job_name}</td><td>{ist(r.started_at)}</td><td>{ist(r.finished_at)}</td>
              <td>{r.status}{r.report.stoppedByBudget ? " (stopped by budget)" : ""}</td>
              <td><Raw label="Report" value={r.report} />{r.error && <Raw label="Error" value={r.error.split("\n").slice(0, 8).join("\n")} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
