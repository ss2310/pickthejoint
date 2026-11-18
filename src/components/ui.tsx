/** Shared server components. No client JavaScript anywhere: every page is complete in its HTML. */
import Link from "next/link";
import { clock, shortDate, stamp } from "@/lib/format";
import type { Faq } from "@/lib/hubs";
import type { City, EventCard, Named } from "@/lib/queries";
import { breadcrumbLd, eventPath, faqLd, type Ld } from "@/lib/schema";

/** Structured data. "<" is escaped so no string can close the script element. */
export function JsonLd({ data }: { data: Ld | Ld[] }) {
  return (
    <>
      {(Array.isArray(data) ? data : [data]).map((d, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(d).replace(/</g, "\\u003c") }} />
      ))}
    </>
  );
}

export interface Crumb { name: string; path: string }

export function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <ol>
        {trail.map((t, i) => (
          <li key={t.path}>{i < trail.length - 1 ? <Link href={t.path}>{t.name}</Link> : <span aria-current="page">{t.name}</span>}</li>
        ))}
      </ol>
      <JsonLd data={breadcrumbLd(trail)} />
    </nav>
  );
}

const STATUS_LABEL: Record<string, string> = { cancelled: "Cancelled", postponed: "Postponed" };

export function priceLabel(e: Pick<EventCard, "is_free" | "price_text">): string | null {
  return e.is_free ? "Free entry" : e.price_text;
}

export function EventList({ events, empty }: { events: EventCard[]; empty: string }) {
  if (events.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ol className="events">
      {events.map((e) => {
        const price = priceLabel(e);
        return (
          <li key={e.id} className={e.status === "cancelled" ? "event is-off" : "event"}>
            <time className="event-date" dateTime={e.starts_at.toISOString()}>
              <span>{shortDate(e.starts_at, e.timezone)}</span>
              {e.start_time_known && <span className="event-time">{clock(e.starts_at, e.timezone)}</span>}
            </time>
            <div className="event-body">
              <h3><Link href={eventPath(e)}>{e.title}</Link></h3>
              <p className="event-meta">
                {STATUS_LABEL[e.status] && <strong className="tag tag-warn">{STATUS_LABEL[e.status]}</strong>}
                {e.venue_name && <span>{e.venue_name}{e.area_name ? `, ${e.area_name}` : ""}</span>}
                {e.category_name && <span>{e.category_name}</span>}
                {price && <span>{price}</span>}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function FaqBlock({ faqs }: { faqs: Faq[] }) {
  if (faqs.length === 0) return null;
  return (
    <section className="faq" aria-labelledby="faq-heading">
      <h2 id="faq-heading">Questions people ask</h2>
      <dl>
        {faqs.map((f) => (
          <div key={f.question}>
            <dt>{f.question}</dt>
            <dd>{f.answer}</dd>
          </div>
        ))}
      </dl>
      <JsonLd data={faqLd(faqs)} />
    </section>
  );
}

/** Links between a city's hubs, shown on every hub page. */
export function HubNav({ city, categories, current }: { city: City; categories: Named[]; current: string }) {
  const base = `/${city.slug}`;
  const links = [
    { path: base, name: "This week" }, { path: `${base}/today`, name: "Today" }, { path: `${base}/this-weekend`, name: "This weekend" },
    ...categories.map((c) => ({ path: `${base}/${c.slug}`, name: c.name })),
    { path: `${base}/past`, name: "Past events" }, { path: `${base}/search`, name: "Search" },
  ];
  return (
    <nav aria-label={`${city.name} listings`} className="hubnav">
      <ul>
        {links.map((l) => (
          <li key={l.path}>{l.path === current ? <span aria-current="page">{l.name}</span> : <Link href={l.path}>{l.name}</Link>}</li>
        ))}
      </ul>
    </nav>
  );
}

export function Updated({ at, timeZone }: { at: Date | null; timeZone: string }) {
  if (!at) return null;
  return <p className="muted small updated">Updated <time dateTime={at.toISOString()}>{stamp(at, timeZone)}</time>.</p>;
}

export function ExternalLinks({ links }: { links: string[] }) {
  if (links.length === 0) return null;
  const label = (u: string) => {
    try {
      const host = new URL(u).hostname.replace(/^www\./, "");
      return host === "instagram.com" ? `Instagram: ${new URL(u).pathname.replace(/\//g, "")}` : host;
    } catch { return u; }
  };
  return (
    <ul className="links">
      {links.map((u) => <li key={u}><a href={u} rel="noopener">{label(u)}</a></li>)}
    </ul>
  );
}
