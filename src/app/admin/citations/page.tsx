import Link from "next/link";
import { citations as cfg } from "@/config";
import { requireAdmin } from "@/lib/admin-session";
import {
  activeQuestions, citationBudget, engineLabel, firstPartyRows, lastRuns, weekResults, weekStart, weeklyFigures, type ResultRow,
} from "@/lib/citations";
import { Msg, ist, usd } from "../components";
import { addFirstParty, addManualResult, uploadFirstPartyCsv, uploadRun } from "./actions";

export const metadata = { title: "AI citations" };

const pct = (n: number, d: number) => (d ? `${n} of ${d} (${Math.round((n / d) * 100)}%)` : "–");

function Cell({ r }: { r: ResultRow | undefined }) {
  if (!r) return <td className="muted">–</td>;
  if (!r.answered) return <td className="muted small" title={r.note ?? ""}>no answer</td>;
  return (
    <td className={r.cited ? "good" : undefined}>
      {r.cited ? <strong>Cited</strong> : r.mentioned_by_name ? "Named" : "Not cited"}
      {r.method === "manual" && <span className="block muted small">by hand{r.screenshot_url && <> · <a href={r.screenshot_url} rel="noopener nofollow" target="_blank">screenshot</a></>}</span>}
    </td>
  );
}

export default async function CitationsAdmin({ searchParams }: { searchParams: Promise<{ msg?: string; week?: string }> }) {
  await requireAdmin();
  const q = await searchParams;
  const [weeks, budget, runs, questions, fp] = await Promise.all([weeklyFigures(), citationBudget(), lastRuns(), activeQuestions(), firstPartyRows()]);
  const thisWeek = weekStart(new Date());
  const week = q.week && /^\d{4}-\d{2}-\d{2}$/.test(q.week) ? q.week : weeks.find((w) => w.all.checks > 0)?.weekStart ?? thisWeek;
  const results = await weekResults(week);
  const engines = cfg.engines.filter((e) => results.some((r) => r.engine === e.key) || e.automated);
  const byQuestion = new Map<number, ResultRow[]>();
  for (const r of results) byQuestion.set(r.query_id, [...(byQuestion.get(r.query_id) ?? []), r]);
  const tally = (key: "competitors_cited" | "cited_urls") => {
    const counts = new Map<string, number>();
    for (const r of results.filter((x) => x.answered)) {
      const items = key === "cited_urls" ? [...new Set(r.cited_urls.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }).filter(Boolean))] : r.competitors_cited;
      for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15);
  };
  const geogrid = "C:\\Users\\Utsav Goyal\\Documents\\Joe Roofer Enrichment";
  const cmd = (extra: string) => `"${geogrid}\\.venv\\Scripts\\python" scripts\\citations\\geogrid_run.py --geogrid "${geogrid}" ${extra}`;

  return (
    <>
      <h1>AI citations</h1>
      <Msg msg={q.msg} />
      <p className="muted small">
        Each week the same {questions.length} questions are asked to ChatGPT, Gemini, Perplexity and Google AI Overviews through GeoGrid on your
        computer, and the results file is uploaded here. A check counts as cited when a pickthejoint.com page is among the answer&rsquo;s sources;
        a check the engine did not answer is left out of the share. The public page is <Link href="/ai-citations">/ai-citations</Link>.
      </p>

      <h2>This week&rsquo;s run</h2>
      <p className="small">
        Citations budget this month: {usd(budget.spent)} of {usd(budget.cap)} spent, {usd(budget.left)} left (CITATIONS_BUDGET_USD, inside the scrape budget).
        One run costs at most about $1.80; answers GeoGrid asked in the last 7 days are reused free.
      </p>
      {budget.runCeiling <= 0.05 ? (
        <p className="banner banner-warn">The citations budget for this month is used up. Do not run until next month, or raise CITATIONS_BUDGET_USD.</p>
      ) : (
        <ol className="small">
          <li>In a terminal in the Pick the Joint folder, check what it will ask and cost: <pre>{cmd("--dry-run")}</pre></li>
          <li>Run it (stops at {usd(budget.runCeiling)}): <pre>{cmd(`--max-cost ${budget.runCeiling}`)}</pre></li>
          <li>Upload the file it names (in <code>citation-runs\</code>):</li>
        </ol>
      )}
      <form action={uploadRun} className="form-grid">
        <label className="field">Results file (.json)<input type="file" name="file" accept=".json,application/json" required /></label>
        <p><button className="button">Import</button></p>
      </form>

      <h2>Week by week</h2>
      <table className="admin-table">
        <thead>
          <tr><th>Week of</th>{cfg.engines.map((e) => <th key={e.key}>{e.label}</th>)}<th>All engines</th><th>Named</th><th>AI crawler visits</th><th>Live events · venues · artists</th><th>Bing AI citations</th><th>Search Console clicks / impressions</th></tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.weekStart}>
              <td><Link href={`/admin/citations?week=${w.weekStart}`}>{w.weekStart}</Link>{w.weekStart === thisWeek && <span className="block muted small">this week</span>}</td>
              {cfg.engines.map((e) => { const x = w.engines.find((y) => y.engine === e.key); return <td key={e.key} className="small">{x ? pct(x.cited, x.answered) : "–"}</td>; })}
              <td className="small"><strong>{pct(w.all.cited, w.all.answered)}</strong></td>
              <td className="small">{w.all.answered ? w.all.mentioned : "–"}</td>
              <td>{w.crawlerVisits}</td>
              <td className="small">{w.liveEvents ?? "–"} · {w.venues ?? "–"} · {w.artists ?? "–"}</td>
              <td className="small">{w.bing?.citations ?? "–"}</td>
              <td className="small">{w.searchConsole ? `${w.searchConsole.clicks ?? "–"} / ${w.searchConsole.impressions ?? "–"}` : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Week of {week}</h2>
      {results.length === 0 ? <p className="muted">No checks recorded for this week yet.</p> : (
        <>
          <table className="admin-table">
            <thead><tr><th>Question</th>{engines.map((e) => <th key={e.key}>{e.label}</th>)}</tr></thead>
            <tbody>
              {questions.map((qq) => {
                const rows = byQuestion.get(qq.id) ?? [];
                return (
                  <tr key={qq.id}>
                    <td lang={qq.locale === "hi" ? "hi" : undefined}>{qq.query}</td>
                    {engines.map((e) => <Cell key={e.key} r={rows.find((r) => r.engine === e.key)} />)}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="two-col">
            <section>
              <h3>Listing sites cited this week</h3>
              <table className="admin-table"><tbody>{tally("competitors_cited").map(([d, n]) => <tr key={d}><td>{d}</td><td>{n}</td></tr>)}</tbody></table>
            </section>
            <section>
              <h3>All sources cited this week</h3>
              <table className="admin-table"><tbody>{tally("cited_urls").map(([d, n]) => <tr key={d}><td>{d}</td><td>{n}</td></tr>)}</tbody></table>
            </section>
          </div>
          <details className="raw">
            <summary>Every answer this week ({results.length})</summary>
            {results.map((r) => (
              <div key={`${r.query_id}-${r.engine}`} className="answer">
                <p><strong>{engineLabel(r.engine)}</strong> · <span lang={r.locale === "hi" ? "hi" : undefined}>{r.query}</span> · {r.answered ? (r.cited ? "cited" : r.mentioned_by_name ? "named, not cited" : "not cited") : `no answer${r.note ? `: ${r.note}` : ""}`}{r.cost_usd > 0 && ` · ${usd(r.cost_usd)}`}</p>
                {r.our_urls.length > 0 && <p className="small">Our pages: {r.our_urls.join(", ")}</p>}
                {r.cited_urls.length > 0 && <p className="small muted">Sources: {r.cited_urls.slice(0, 12).join(" · ")}</p>}
                {r.answer_excerpt && <pre>{r.answer_excerpt}</pre>}
              </div>
            ))}
          </details>
        </>
      )}

      <h2>Add a check by hand</h2>
      <p className="muted small">For engines with no automated route (Copilot, Claude) or to correct one. Ask the question in a private window, take a screenshot, put it somewhere with an https link, and record what you saw.</p>
      <form action={addManualResult} className="form-grid">
        <label className="field wide">Question
          <select name="query_id" required>{questions.map((qq) => <option key={qq.id} value={qq.id}>{qq.locale.toUpperCase()} · {qq.query}</option>)}</select>
        </label>
        <label className="field">Engine<select name="engine">{cfg.engines.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}</select></label>
        <label className="field">Week (any day in it)<input type="date" name="week" defaultValue={thisWeek} required /></label>
        <label className="field">Answer<select name="answered"><option value="yes">The engine answered</option><option value="no">No answer</option></select></label>
        <label className="field check"><input type="checkbox" name="cited" /> pickthejoint.com cited</label>
        <label className="field check"><input type="checkbox" name="mentioned" /> Named in the text</label>
        <label className="field wide">Listing sites it cited (comma-separated)<input type="text" name="competitors" placeholder="district.in, bookmyshow.com" /></label>
        <label className="field wide">Screenshot link<input type="url" name="screenshot" placeholder="https://..." /></label>
        <label className="field wide">Note<input type="text" name="note" /></label>
        <p><button className="button">Save check</button></p>
      </form>

      <h2>First-party sources</h2>
      <p className="muted small">
        Once a week: Bing Webmaster Tools &rarr; AI Performance (citations in Copilot and Bing AI answers), and Search Console &rarr; Performance.
        Type the week&rsquo;s figures, or export the daily table as CSV and upload it (it is summed into weeks).
      </p>
      <div className="two-col">
        <form action={addFirstParty} className="form-grid">
          <label className="field">Source<select name="source"><option value="bing_ai">Bing AI Performance</option><option value="search_console">Search Console</option></select></label>
          <label className="field">Week (any day in it)<input type="date" name="week" defaultValue={thisWeek} required /></label>
          <label className="field">Citations<input type="number" name="citations" min={0} /></label>
          <label className="field">Cited pages<input type="number" name="cited_pages" min={0} /></label>
          <label className="field">Impressions<input type="number" name="impressions" min={0} /></label>
          <label className="field">Clicks<input type="number" name="clicks" min={0} /></label>
          <label className="field">Average position<input type="number" name="avg_position" min={0} step="0.01" /></label>
          <label className="field wide">Note<input type="text" name="note" /></label>
          <p><button className="button">Save</button></p>
        </form>
        <form action={uploadFirstPartyCsv} className="form-grid">
          <label className="field">Source<select name="source"><option value="bing_ai">Bing AI Performance</option><option value="search_console">Search Console</option></select></label>
          <label className="field wide">CSV export (needs a Date column)<input type="file" name="file" accept=".csv,text/csv,.tsv,text/plain" required /></label>
          <p><button className="button ghost">Import CSV</button></p>
        </form>
      </div>
      {fp.length > 0 && (
        <table className="admin-table">
          <thead><tr><th>Week of</th><th>Source</th><th>Citations</th><th>Cited pages</th><th>Impressions</th><th>Clicks</th><th>Avg position</th><th>Note</th></tr></thead>
          <tbody>{fp.map((r) => <tr key={`${r.source}-${r.week_start}`}><td>{r.week_start}</td><td>{r.source === "bing_ai" ? "Bing AI" : "Search Console"}</td><td>{r.citations ?? "–"}</td><td>{r.cited_pages ?? "–"}</td><td>{r.impressions ?? "–"}</td><td>{r.clicks ?? "–"}</td><td>{r.avg_position ?? "–"}</td><td className="small">{r.note}</td></tr>)}</tbody>
        </table>
      )}

      <h2>Imported runs</h2>
      {runs.length === 0 ? <p className="muted">None yet.</p> : (
        <table className="admin-table">
          <thead><tr><th>Run</th><th>Week of</th><th>Asked</th><th>Checks</th><th>Answered</th><th>Cost</th></tr></thead>
          <tbody>{runs.map((r) => <tr key={r.run_id}><td className="small">{r.run_id}</td><td>{r.week_start}</td><td className="small">{ist(r.asked_at)}</td><td>{r.checks}</td><td>{r.answered}</td><td>{usd(r.cost_usd)}</td></tr>)}</tbody>
        </table>
      )}
    </>
  );
}
