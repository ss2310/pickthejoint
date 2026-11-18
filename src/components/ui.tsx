/** Shared server components. No client JavaScript anywhere: every page is complete in its HTML. */
import NextLink from "next/link";
import { locales } from "@/config";
import { clock, dateParts, stamp } from "@/lib/format";
import { categoryName, type Faq } from "@/lib/hubs";
import { LANG_TAG, getLocale, localePath, messages } from "@/lib/locale";
import type { City, EventCard, Named } from "@/lib/queries";
import { breadcrumbLd, eventPath, faqLd, type Ld } from "@/lib/schema";

/** A link to a page of this site, in the language of the page being rendered. `href` is the plain path. */
export function Link({ href, ...rest }: Omit<React.ComponentProps<typeof NextLink>, "href"> & { href: string }) {
  return <NextLink href={localePath(href)} {...rest} />;
}

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
    <nav aria-label={messages().site.breadcrumb} className="crumbs">
      <ol>
        {trail.map((t, i) => (
          <li key={t.path}>{i < trail.length - 1 ? <Link href={t.path}>{t.name}</Link> : <span aria-current="page">{t.name}</span>}</li>
        ))}
      </ol>
      <JsonLd data={breadcrumbLd(trail)} />
    </nav>
  );
}

/**
 * The band at the top of every page: breadcrumbs, an optional kicker, the page
 * title and whatever introduces the page. `tone` is a category slug; it tints
 * the band with that category's colour. The last breadcrumb is the page's own
 * path, which is where the link to the other language points; pages that exist
 * in one language only pass `oneLanguage`.
 */
export function Hero({ trail, title, tone, kicker, long, oneLanguage, children }: {
  trail: Crumb[]; title: string; tone?: string | null; kicker?: React.ReactNode; long?: boolean; oneLanguage?: boolean; children?: React.ReactNode;
}) {
  const locale = getLocale();
  const other = locales.find((l) => l !== locale)!;
  return (
    <header className={["hero", tone ? `cat-${tone}` : "", long || title.length > 34 ? "hero-long" : ""].filter(Boolean).join(" ")}>
      <div className="wrap">
        <div className="hero-top">
          <Breadcrumbs trail={trail} />
          {!oneLanguage && (
            <a className="lang-switch" href={localePath(trail[trail.length - 1].path, other)} hrefLang={LANG_TAG[other]} lang={LANG_TAG[other]}>
              {messages().site.switchTo}
            </a>
          )}
        </div>
        {kicker}
        <h1>{title}</h1>
        {children}
      </div>
    </header>
  );
}

/** Up to two initials for a name: "The Yellow Diary" is "YD". Names in other scripts get their first letter. */
export function initials(name: string): string {
  const words = name.replace(/^the\s+/i, "").split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const first = (w: string) => Array.from(w)[0] ?? "";
  if (!/^[\x00-\x7f]*$/.test(name)) return first(words[0] ?? name);
  return (words.length > 1 ? first(words[0]) + first(words[1]) : (words[0] ?? name).slice(0, 2)).toUpperCase();
}

export function priceLabel(e: Pick<EventCard, "is_free" | "price_text">): string | null {
  return e.is_free ? messages().common.freeEntry : e.price_text;
}

export function EventList({ events, empty }: { events: EventCard[]; empty: string }) {
  if (events.length === 0) return empty ? <p className="empty">{empty}</p> : null;
  const m = messages();
  const status: Record<string, string> = { cancelled: m.common.cancelled, postponed: m.common.postponed };
  return (
    <ol className="events">
      {events.map((e) => {
        const price = priceLabel(e);
        const d = dateParts(e.starts_at, e.timezone);
        return (
          <li key={e.id} className={["event", e.category_slug ? `cat-${e.category_slug}` : "", e.status === "cancelled" ? "is-off" : ""].filter(Boolean).join(" ")}>
            {/* The spaces between the parts keep the date readable as plain text: "Sat 21 Nov". */}
            <time className="event-date" dateTime={e.starts_at.toISOString()}>
              <span className="dow">{d.weekday}</span>{" "}<span className="day">{d.day}</span>{" "}<span className="mon">{d.month}</span>
            </time>
            <div className="event-body">
              <h3><Link href={eventPath(e)}>{e.title}</Link></h3>
              <p className="event-venue">
                {e.start_time_known && <><span className="event-time">{clock(e.starts_at, e.timezone)}</span>{e.venue_name ? " · " : ""}</>}
                {e.venue_name && <span>{e.venue_name}{e.area_name ? `, ${e.area_name}` : ""}</span>}
              </p>
              <p className="event-tags">
                {status[e.status] && <strong className="tag tag-warn">{status[e.status]}</strong>}
                {e.category_name && <span className="pill">{categoryName({ slug: e.category_slug, name: e.category_name })}</span>}
                {price && <span className={e.is_free ? "pill pill-free" : "pill pill-plain"}>{price}</span>}
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
      <h2 id="faq-heading">{messages().common.faqHeading}</h2>
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

/** The plain-words search box (Prompt 7): an ordinary GET form to the city's search page, no script. */
export function AskBox({ city, query, id = "q" }: { city: City; query?: string; id?: string }) {
  const m = messages().search;
  return (
    <form method="get" action={localePath(`/${city.slug}/search`)} className="ask" role="search">
      <label htmlFor={id}>{m.askLabel}</label>
      <div className="ask-row">
        <input id={id} type="search" name="q" defaultValue={query} placeholder={m.askPlaceholder} maxLength={200} autoComplete="off" />
        <button type="submit" className="button">{m.askButton}</button>
      </div>
      <p className="small ask-hint">{m.askHint}</p>
    </form>
  );
}

/** Links between a city's hubs, shown on every hub page. */
export function HubNav({ city, categories, current }: { city: City; categories: Named[]; current: string }) {
  const base = `/${city.slug}`;
  const m = messages().nav;
  const links: { path: string; name: string; tone?: string }[] = [
    { path: base, name: m.thisWeek }, { path: `${base}/today`, name: m.today }, { path: `${base}/this-weekend`, name: m.thisWeekend },
    ...categories.map((c) => ({ path: `${base}/${c.slug}`, name: categoryName(c), tone: c.slug })),
    { path: `${base}/past`, name: m.past }, { path: `${base}/search`, name: m.search },
  ];
  return (
    <nav aria-label={m.listings(city.name)} className="hubnav">
      <ul>
        {links.map((l) => (
          <li key={l.path} className={l.tone ? `cat-${l.tone}` : undefined}>{l.path === current ? <span aria-current="page">{l.name}</span> : <Link href={l.path}>{l.name}</Link>}</li>
        ))}
      </ul>
    </nav>
  );
}

export function Updated({ at, timeZone, note }: { at: Date | null; timeZone: string; note?: string }) {
  if (!at) return null;
  return (
    <p className="muted small updated">
      {messages().common.updated} <time dateTime={at.toISOString()}>{stamp(at, timeZone)}</time>.{note ? ` ${note}` : ""}
    </p>
  );
}

/**
 * The pages an entity page draws on, each with the facts taken from it, so a
 * reader (or a crawler) can trace every statement to where it came from.
 */
export function SourceList({ sources }: { sources: { url: string; title: string | null; facts: string[] }[] }) {
  if (sources.length === 0) return null;
  const m = messages().common;
  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
  const label = (fact: string) => { const key = fact.split(":")[0].toLowerCase(); return m.factLabels[key] ?? key; };
  return (
    <section aria-labelledby="sources-heading">
      <h2 id="sources-heading">{m.sourcesHeading}</h2>
      <p className="muted small">{m.sourcesNote}</p>
      <ul className="links">
        {sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} rel="noopener nofollow">{s.title ?? host(s.url)}</a> ({host(s.url)})
            {s.facts.length > 0 && <span className="muted small">. {m.usedFor}: {s.facts.map(label).filter((f, i, all) => all.indexOf(f) === i).join(", ")}.</span>}
          </li>
        ))}
      </ul>
    </section>
  );
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
