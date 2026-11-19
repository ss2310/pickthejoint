/**
 * "Before you go" on an event page (Prompt 11): the practical questions a source
 * answers, each with where the answer came from, as plain HTML with FAQPage
 * structured data. A question nobody has answered is not shown.
 */
import { clock, isoDay, longDate } from "@/lib/format";
import { localePath, messages } from "@/lib/locale";
import { isVenueFact, type FactAnswer } from "@/lib/practical";
import { zonedToUtc } from "@/lib/pipeline/text";
import type { EventDetail } from "@/lib/queries";
import { faqLd } from "@/lib/schema";
import { JsonLd } from "./ui";

interface Row { id: string; question: string; answer: string; source: React.ReactNode }

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

/** 11:59 PM is how a last day with no end time is stored: it is not a time anyone announced. */
const realEnd = (e: EventDetail) => !!e.ends_at && clock(e.ends_at, e.timezone, "en") !== "11:59 PM";

export function factRows(e: EventDetail, facts: FactAnswer[]): Row[] {
  const m = messages().practical;
  const listing = <>{m.sourceLabel}: <a href="#source-heading">{m.fromListing}</a></>;
  const rows: Row[] = [];
  if (e.start_time_known) {
    rows.push({ id: "start", question: m.q.start(e.title), answer: m.startAnswer(clock(e.starts_at, e.timezone), longDate(e.starts_at, e.timezone)), source: listing });
  }
  for (const f of facts) {
    const source = f.source.type === "organiser" ? <>{m.sourceLabel}: {m.fromOrganiser}</>
      : f.source.type === "admin" ? <>{m.sourceLabel}: {m.fromAdmin}</>
        : f.source.url ? <>{m.sourceLabel}: <a href={f.source.url} rel="noopener nofollow">{f.source.type === "post" ? m.fromPost(host(f.source.url)) : host(f.source.url)}</a></>
          : listing;
    if (f.key === "doors_time") {
      const at = zonedToUtc(isoDay(e.starts_at, e.timezone), f.answer, e.timezone);
      rows.push({ id: f.key, question: m.q.doors_time(e.title), answer: m.doorsAnswer(clock(at, e.timezone)), source });
      continue;
    }
    const subject = isVenueFact(f.key) ? e.venue_name ?? e.title : e.title;
    rows.push({ id: f.key, question: m.q[f.key](subject), answer: f.answer, source });
  }
  if (realEnd(e)) {
    const sameDay = isoDay(e.ends_at!, e.timezone) === isoDay(e.starts_at, e.timezone);
    const time = sameDay ? clock(e.ends_at!, e.timezone) : `${clock(e.ends_at!, e.timezone)}, ${longDate(e.ends_at!, e.timezone)}`;
    // After the start and the doors, before the rest.
    const at = rows.findIndex((r) => r.id !== "start" && r.id !== "doors_time");
    rows.splice(at < 0 ? rows.length : at, 0, { id: "end", question: m.q.end(e.title), answer: m.endAnswer(time), source: listing });
  }
  return rows;
}

export function PracticalFacts({ e, facts }: { e: EventDetail; facts: FactAnswer[] }) {
  const m = messages().practical;
  const rows = factRows(e, facts);
  const over = e.status === "happened" || e.status === "cancelled";
  return (
    <section aria-labelledby="practical-heading" className="faq practical">
      <h2 id="practical-heading">{m.heading}</h2>
      {rows.length > 0 && (
        <>
          <p className="muted small">{m.note}</p>
          <dl>
            {rows.map((r) => (
              <div key={r.id} id={`q-${r.id}`}>
                <dt>{r.question}</dt>
                <dd>{r.answer} <span className="block muted small">{r.source}</span></dd>
              </div>
            ))}
          </dl>
          <JsonLd data={faqLd(rows.map((r) => ({ question: r.question, answer: r.answer })))} />
        </>
      )}
      {!over && <p className="small"><a href={localePath(`/submit?event=${e.id}`)} rel="nofollow">{m.addOrCorrect}</a></p>}
    </section>
  );
}
