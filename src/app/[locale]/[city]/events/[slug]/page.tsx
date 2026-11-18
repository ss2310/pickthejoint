import { notFound } from "next/navigation";
import type { Metadata } from "next";
import PlainLink from "next/link";
import { EventList, Hero, JsonLd, Link, Updated, priceLabel } from "@/components/ui";
import { clock, longDate, plainDate, stamp } from "@/lib/format";
import { categoryName } from "@/lib/hubs";
import { alternates, localePath, messages, setLocale } from "@/lib/locale";
import { getEvent, listEvents, type EventDetail } from "@/lib/queries";
import { abs, eventImagePath, eventLd, eventPath, ids, pageLd, venuePath } from "@/lib/schema";

// Rebuilt at most every 10 minutes, so a change to the event (new time, cancellation) reaches the page quickly.
export const revalidate = 600;

type Props = { params: Promise<{ locale: string; city: string; slug: string }> };

function whenText(e: EventDetail): string {
  const to = messages().event.to;
  const day = longDate(e.starts_at, e.timezone);
  if (!e.start_time_known) return day;
  const start = clock(e.starts_at, e.timezone);
  if (!e.ends_at) return `${day}, ${start}`;
  const endDay = longDate(e.ends_at, e.timezone);
  const longRun = e.ends_at.getTime() - e.starts_at.getTime() > 20 * 3_600_000;
  return longRun ? `${day}, ${start} ${to} ${endDay}, ${clock(e.ends_at, e.timezone)}` : `${day}, ${start} ${to} ${clock(e.ends_at, e.timezone)}`;
}

function sourceLabel(s: { source_type: string; url: string | null }): string {
  const m = messages().event;
  if (s.source_type === "instagram") return m.sourceInstagram;
  if (s.source_type === "submission") return m.sourceSubmitted;
  // A poster someone sent us: named as the source, never shown (the image is not ours to publish).
  if (s.source_type === "poster") return m.sourcePoster;
  try { return m.sourceListing(new URL(s.url!).hostname.replace(/^www\./, "")); } catch { return m.sourceWeb; }
}

function metaDescription(e: EventDetail): string {
  const m = messages().event;
  const bits = [m.metaLead(e.title, e.venue_name, e.city_name), whenText(e), priceLabel(e) ?? undefined].filter(Boolean);
  return `${bits.join(". ")}. ${m.metaTail}`.slice(0, 300);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, city, slug } = await params;
  setLocale(locale);
  const e = await getEvent(city, slug);
  if (!e) return {};
  const m = messages().event;
  const title = m.titleLine(e.title, e.venue_name, plainDate(e.starts_at, e.timezone));
  return {
    title,
    description: metaDescription(e),
    alternates: alternates(eventPath(e)),
    openGraph: {
      title, description: metaDescription(e), url: localePath(eventPath(e)), type: "article",
      images: [{ url: eventImagePath(e, "16x9"), width: 1200, height: 675, alt: m.imageAlt(e.title) }],
    },
    twitter: { card: "summary_large_image", images: [eventImagePath(e, "16x9")] },
  };
}

export default async function EventPage({ params }: Props) {
  const { locale, city, slug } = await params;
  setLocale(locale);
  const e = await getEvent(city, slug);
  if (!e) notFound();
  const m = messages().event;

  const [atVenue, alike] = await Promise.all([
    e.venue_id ? listEvents({ venueId: e.venue_id, excludeId: e.id, limit: 5 }) : [],
    e.category_id ? listEvents({ cityId: e.city_id, categoryId: e.category_id, excludeId: e.id, limit: 5 }) : [],
  ]);
  const price = priceLabel(e);
  const over = e.status === "happened";
  const category = e.category_slug ? categoryName({ slug: e.category_slug, name: e.category_name }) : null;
  const mapQuery = e.venue_lat != null && e.venue_lng != null
    ? `${e.venue_lat},${e.venue_lng}`
    : [e.venue_name, e.venue_address, e.city_name].filter(Boolean).join(", ");
  const trail = [
    { name: e.city_name, path: `/${e.city_slug}` },
    ...(category ? [{ name: category, path: `/${e.city_slug}/${e.category_slug}` }] : []),
    { name: e.title, path: eventPath(e) },
  ];
  const shareText = `${e.title}, ${whenText(e)}${e.venue_name ? `, ${e.venue_name}` : ""}. ${abs(localePath(eventPath(e)))}`;

  return (
    <main className={e.category_slug ? `cat-${e.category_slug}` : undefined}>
      <article className="event-page">
        <Hero trail={trail} title={e.title} tone={e.category_slug} long
          kicker={category && <p className="kicker"><Link href={`/${e.city_slug}/${e.category_slug}`}>{category}</Link></p>}>
          <ul className="hero-facts">
            <li><time dateTime={e.starts_at.toISOString()}>{whenText(e)}</time></li>
            {e.venue_name && <li>{e.venue_name}{e.area_name ? `, ${e.area_name}` : ""}</li>}
            {price && <li>{price}</li>}
          </ul>
        </Hero>
        <div className="wrap page">
          {e.status === "cancelled" && <p className="banner banner-warn" role="status"><strong>{m.cancelledLead}</strong> {m.cancelledText}</p>}
          {e.status === "postponed" && <p className="banner banner-warn" role="status"><strong>{m.postponedLead}</strong> {m.postponedText}</p>}
          {over && <p className="banner" role="status">{m.over(e.city_name)}</p>}

          <div className="event-layout">
            <div className="event-main">
              <dl className="facts">
                <div>
                  <dt>{m.when}</dt>
                  <dd><time dateTime={e.starts_at.toISOString()}>{whenText(e)}</time>{!e.start_time_known && <span className="muted">{m.timeNotAnnounced}</span>}</dd>
                </div>
                {e.venue_name && (
                  <div>
                    <dt>{m.where}</dt>
                    <dd>
                      {e.venue_slug ? <Link href={venuePath(e.city_slug, e.venue_slug)}>{e.venue_name}</Link> : e.venue_name}
                      {e.area_name && <>, <Link href={`/${e.city_slug}/area/${e.area_slug}`}>{e.area_name}</Link></>}, {e.city_name}
                      {e.venue_address && <span className="block muted">{e.venue_address}</span>}
                      <a className="block" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`} rel="noopener">{m.openMaps}</a>
                    </dd>
                  </div>
                )}
                {price && <div><dt>{m.price}</dt><dd>{price}</dd></div>}
                {e.artists.length > 0 && (
                  <div>
                    <dt>{e.artists.length === 1 ? m.performer : m.performers}</dt>
                    <dd>{e.artists.map((a, i) => <span key={a.slug}>{i > 0 && ", "}<Link href={`/artists/${a.slug}`}>{a.name}</Link></span>)}</dd>
                  </div>
                )}
                {e.organisers.length > 0 && (
                  <div>
                    <dt>{m.organisedBy}</dt>
                    <dd>{e.organisers.map((o, i) => <span key={o.slug}>{i > 0 && ", "}<Link href={`/organisers/${o.slug}`}>{o.name}</Link></span>)}</dd>
                  </div>
                )}
                {e.series && <div><dt>{m.partOf}</dt><dd><Link href={`/series/${e.series.slug}`}>{e.series.name}</Link></dd></div>}
              </dl>

              {e.description && <section aria-labelledby="about-heading"><h2 id="about-heading">{m.about}</h2><p className="about-text">{e.description}</p></section>}

              <section aria-labelledby="source-heading" className="provenance">
                <h2 id="source-heading">{m.source}</h2>
                <ul>
                  {e.sources.map((s, i) => (
                    <li key={i}>{s.url ? <a href={s.url} rel="noopener nofollow">{sourceLabel(s)}</a> : sourceLabel(s)}</li>
                  ))}
                </ul>
                {e.last_verified_at && (
                  <p className="muted small">{m.lastVerified} <time dateTime={e.last_verified_at.toISOString()}>{stamp(e.last_verified_at, e.timezone)}</time>.
                    {" "}{m.mistake} <PlainLink href="/corrections">{m.tellUs}</PlainLink>.</p>
                )}
              </section>
            </div>

            <aside className="event-side" aria-label={m.sideLabel}>
              <div className="ticket">
                {price && <p className="price">{price}</p>}
                {e.booking_url && !over && e.status !== "cancelled" && (
                  <p><a className="button" href={e.booking_url} rel="noopener nofollow">{m.book}</a>
                    <span className="block muted small">{m.bookNote}</span></p>
                )}
                <p className="actions">
                  <a href={`${eventPath(e)}/calendar.ics`}>{m.addToCalendar}</a>
                  <a href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} rel="noopener nofollow">{m.shareWhatsapp}</a>
                </p>
              </div>
            </aside>
          </div>
        </div>
      </article>

      <div className="wrap">
        {atVenue.length > 0 && (
          <section aria-labelledby="venue-more"><h2 id="venue-more">{m.moreAt(e.venue_name!)}</h2><EventList events={atVenue} empty="" /></section>
        )}
        {alike.length > 0 && (
          <section aria-labelledby="alike-more"><h2 id="alike-more">{m.moreLike(category!, e.city_name)}</h2><EventList events={alike} empty="" /></section>
        )}
        <Updated at={e.updated_at} timeZone={e.timezone} />
        <JsonLd data={[eventLd(e), pageLd(eventPath(e), e.title, e.updated_at, ids.event(eventPath(e)))]} />
      </div>
    </main>
  );
}
