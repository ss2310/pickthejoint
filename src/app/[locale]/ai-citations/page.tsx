import type { Metadata } from "next";
import { Hero, JsonLd, Updated } from "@/components/ui";
import { citations as cfg, displayTimeZone, site } from "@/config";
import { activeQuestions, engineLabel, weeklyFigures } from "@/lib/citations";
import { longDay } from "@/lib/format";
import { alternates, localePath, messages, setLocale } from "@/lib/locale";

// The public proof (Prompt 8): week by week, whether AI assistants cite the site. Rebuilt hourly and whenever a run is imported.
export const revalidate = 3600;

type Props = { params: Promise<{ locale: string }> };
const PATH = "/ai-citations";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  setLocale((await params).locale);
  const m = messages().proof;
  return { title: m.title, description: m.description, alternates: alternates(PATH), openGraph: { title: m.title, description: m.description, url: localePath(PATH) } };
}

export default async function AiCitations({ params }: Props) {
  const locale = setLocale((await params).locale);
  const m = messages().proof;
  const [weeks, questions] = await Promise.all([weeklyFigures(), activeQuestions()]);
  const measured = weeks.filter((w) => w.all.checks > 0);
  const baseline = measured[measured.length - 1]?.weekStart;
  const shown = baseline ? weeks.filter((w) => w.weekStart >= baseline) : [];
  const engines = cfg.engines.filter((e) => measured.some((w) => w.engines.some((x) => x.engine === e.key)));
  const cell = (cited: number, answered: number) => (answered ? m.of(cited, answered) : "–");
  const lastWeek = measured[0];
  const updated = lastWeek ? new Date(`${lastWeek.weekStart}T12:00:00Z`) : null;

  const dataset = {
    "@context": "https://schema.org", "@type": "Dataset", name: m.title, description: m.description, url: `${site.url}${localePath(PATH)}`,
    inLanguage: locale === "hi" ? "hi-IN" : "en-IN", creator: { "@type": "Organization", name: site.name, url: site.url },
    ...(baseline && lastWeek ? { temporalCoverage: `${baseline}/${lastWeek.weekStart}` } : {}),
    variableMeasured: [m.citedHeading, m.crawlerVisits, m.liveEvents, m.venues, m.artists],
  };

  return (
    <main>
      <Hero trail={[{ name: site.name, path: "/" }, { name: m.title, path: PATH }]} title={m.title} long>
        <p className="lead">{m.lead}</p>
      </Hero>
      <div className="wrap page">
        <section aria-labelledby="cited-heading">
          <h2 id="cited-heading">{m.citedHeading}</h2>
          <p>{m.citedNote}</p>
          {shown.length === 0 ? <p className="muted">{m.noData}</p> : (
            <div className="table-scroll">
              <table className="proof-table">
                <thead><tr><th scope="col">{m.weekOf}</th>{engines.map((e) => <th key={e.key} scope="col">{engineLabel(e.key)}</th>)}<th scope="col">{m.allEngines}</th></tr></thead>
                <tbody>
                  {shown.filter((w) => w.all.checks > 0).map((w) => (
                    <tr key={w.weekStart}>
                      <th scope="row"><time dateTime={w.weekStart}>{longDay(w.weekStart)}</time>{w.weekStart === baseline && ` (${m.baseline})`}</th>
                      {engines.map((e) => { const x = w.engines.find((y) => y.engine === e.key); return <td key={e.key}>{x ? cell(x.cited, x.answered) : "–"}</td>; })}
                      <td><strong>{cell(w.all.cited, w.all.answered)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {shown.length > 0 && (
          <section aria-labelledby="site-heading">
            <h2 id="site-heading">{m.siteHeading}</h2>
            <div className="table-scroll">
              <table className="proof-table">
                <thead><tr><th scope="col">{m.weekOf}</th><th scope="col">{m.crawlerVisits}</th><th scope="col">{m.liveEvents}</th><th scope="col">{m.venues}</th><th scope="col">{m.artists}</th></tr></thead>
                <tbody>
                  {shown.map((w) => (
                    <tr key={w.weekStart}>
                      <th scope="row"><time dateTime={w.weekStart}>{longDay(w.weekStart)}</time></th>
                      <td>{w.crawlerVisits}</td><td>{w.liveEvents ?? "–"}</td><td>{w.venues ?? "–"}</td><td>{w.artists ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section aria-labelledby="method-heading" className="prose">
          <h2 id="method-heading">{m.methodHeading}</h2>
          {m.method(questions.length).map((p) => <p key={p}>{p}</p>)}
          <h3>{m.questionsHeading}</h3>
          {(locale === "hi" ? (["hi", "en"] as const) : (["en", "hi"] as const)).map((l) => (
            <ol key={l} lang={l === "hi" ? "hi" : "en"}>
              {questions.filter((q) => q.locale === l).map((q) => <li key={q.id}>{q.query}</li>)}
            </ol>
          ))}
        </section>

        <Updated at={updated} timeZone={displayTimeZone} />
        <JsonLd data={dataset} />
      </div>
    </main>
  );
}
