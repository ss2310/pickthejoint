import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, EventList, JsonLd, priceLabel } from "@/components/ui";
import { clock, longDate, stamp } from "@/lib/format";
import { getEvent, listEvents, type EventDetail } from "@/lib/queries";
import { abs, eventImagePath, eventLd, eventPath, ids, pageLd, venuePath } from "@/lib/schema";

// Rebuilt at most every 10 minutes, so a change to the event (new time, cancellation) reaches the page quickly.
export const revalidate = 600;

type Props = { params: Promise<{ city: string; slug: string }> };

function whenText(e: EventDetail): string {
  const day = longDate(e.starts_at, e.timezone);
  if (!e.start_time_known) return day;
  const start = clock(e.starts_at, e.timezone);
  if (!e.ends_at) return `${day}, ${start}`;
  const endDay = longDate(e.ends_at, e.timezone);
  const longRun = e.ends_at.getTime() - e.starts_at.getTime() > 20 * 3_600_000;
  return longRun ? `${day}, ${start} to ${endDay}, ${clock(e.ends_at, e.timezone)}` : `${day}, ${start} to ${clock(e.ends_at, e.timezone)}`;
}

function sourceLabel(s: { source_type: string; url: string | null }): string {
  if (s.source_type === "instagram") return "Instagram post by the organiser or venue";
  if (s.source_type === "submission") return "Submitted by the organiser";
  try { return `Listing on ${new URL(s.url!).hostname.replace(/^www\./, "")}`; } catch { return "Web listing"; }
}

function metaDescription(e: EventDetail): string {
  const price = priceLabel(e);
  const bits = [
    `${e.title}${e.venue_name ? ` at ${e.venue_name}` : ""}, ${e.city_name}`,
    whenText(e),
    price ?? undefined,
  ].filter(Boolean);
  return `${bits.join(". ")}. Source and last-verified date on the page.`.slice(0, 300);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { city, slug } = await params;
  const e = await getEvent(city, slug);
  if (!e) return {};
  const title = `${e.title}${e.venue_name ? `, ${e.venue_name}` : ""} (${longDate(e.starts_at, e.timezone).replace(/^\w+, /, "")})`;
  return {
    title,
    description: metaDescription(e),
    alternates: { canonical: eventPath(e) },
    openGraph: {
      title, description: metaDescription(e), url: eventPath(e), type: "article",
      images: [{ url: eventImagePath(e, "16x9"), width: 1200, height: 675, alt: `${e.title}: date, venue and city` }],
    },
    twitter: { card: "summary_large_image", images: [eventImagePath(e, "16x9")] },
  };
}

export default async function EventPage({ params }: Props) {
  const { city, slug } = await params;
  const e = await getEvent(city, slug);
  if (!e) notFound();

  const [atVenue, alike] = await Promise.all([
    e.venue_id ? listEvents({ venueId: e.venue_id, excludeId: e.id, limit: 5 }) : [],
    e.category_id ? listEvents({ cityId: e.city_id, categoryId: e.category_id, excludeId: e.id, limit: 5 }) : [],
  ]);
  const price = priceLabel(e);
  const over = e.status === "happened";
  const mapQuery = e.venue_lat != null && e.venue_lng != null
    ? `${e.venue_lat},${e.venue_lng}`
    : [e.venue_name, e.venue_address, e.city_name].filter(Boolean).join(", ");
  const trail = [
    { name: e.city_name, path: `/${e.city_slug}` },
    ...(e.category_slug ? [{ name: e.category_name!, path: `/${e.city_slug}/${e.category_slug}` }] : []),
    { name: e.title, path: eventPath(e) },
  ];

  return (
    <main>
      <Breadcrumbs trail={trail} />
      <article className="event-page">
        {e.status === "cancelled" && <p className="banner banner-warn" role="status"><strong>Cancelled.</strong> The organiser has announced that this event will not take place.</p>}
        {e.status === "postponed" && <p className="banner banner-warn" role="status"><strong>Postponed.</strong> The organiser has postponed this event; the date below is the original one until a new date is announced.</p>}
        {over && <p className="banner" role="status">This event has taken place. It is kept here as part of the {e.city_name} archive.</p>}

        <header>
          {e.category_name && <p className="kicker"><Link href={`/${e.city_slug}/${e.category_slug}`}>{e.category_name}</Link></p>}
          <h1>{e.title}</h1>
        </header>

        <dl className="facts">
          <div>
            <dt>When</dt>
            <dd><time dateTime={e.starts_at.toISOString()}>{whenText(e)}</time>{!e.start_time_known && <span className="muted"> (start time not announced)</span>}</dd>
          </div>
          {e.venue_name && (
            <div>
              <dt>Where</dt>
              <dd>
                {e.venue_slug ? <Link href={venuePath(e.city_slug, e.venue_slug)}>{e.venue_name}</Link> : e.venue_name}
                {e.area_name && <>, <Link href={`/${e.city_slug}/area/${e.area_slug}`}>{e.area_name}</Link></>}, {e.city_name}
                {e.venue_address && <span className="block muted">{e.venue_address}</span>}
                <a className="block" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`} rel="noopener">Open in Google Maps</a>
              </dd>
            </div>
          )}
          {price && <div><dt>Price</dt><dd>{price}</dd></div>}
          {e.artists.length > 0 && (
            <div>
              <dt>{e.artists.length === 1 ? "Performer" : "Performers"}</dt>
              <dd>{e.artists.map((a, i) => <span key={a.slug}>{i > 0 && ", "}<Link href={`/artists/${a.slug}`}>{a.name}</Link></span>)}</dd>
            </div>
          )}
          {e.organisers.length > 0 && (
            <div>
              <dt>Organised by</dt>
              <dd>{e.organisers.map((o, i) => <span key={o.slug}>{i > 0 && ", "}<Link href={`/organisers/${o.slug}`}>{o.name}</Link></span>)}</dd>
            </div>
          )}
          {e.series && <div><dt>Part of</dt><dd><Link href={`/series/${e.series.slug}`}>{e.series.name}</Link></dd></div>}
        </dl>

        {e.booking_url && !over && e.status !== "cancelled" && (
          <p><a className="button" href={e.booking_url} rel="noopener nofollow">Book on the official page</a>
            <span className="block muted small">Pick the Joint does not sell tickets. This link goes to the organiser&apos;s booking page.</span></p>
        )}

        <p className="actions">
          <a href={`${eventPath(e)}/calendar.ics`}>Add to calendar</a>
          <a href={`https://wa.me/?text=${encodeURIComponent(`${e.title}, ${whenText(e)}${e.venue_name ? `, ${e.venue_name}` : ""}. ${abs(eventPath(e))}`)}`} rel="noopener nofollow">Share on WhatsApp</a>
        </p>

        {e.description && <section aria-labelledby="about-heading"><h2 id="about-heading">About this event</h2><p>{e.description}</p></section>}

        <section aria-labelledby="source-heading" className="provenance">
          <h2 id="source-heading">Source</h2>
          <ul>
            {e.sources.map((s, i) => (
              <li key={i}>{s.url ? <a href={s.url} rel="noopener nofollow">{sourceLabel(s)}</a> : sourceLabel(s)}</li>
            ))}
          </ul>
          {e.last_verified_at && (
            <p className="muted small">Last verified <time dateTime={e.last_verified_at.toISOString()}>{stamp(e.last_verified_at, e.timezone)}</time>.
              {" "}Spotted a mistake? <Link href="/corrections">Tell us</Link>.</p>
          )}
        </section>
      </article>

      {atVenue.length > 0 && (
        <section aria-labelledby="venue-more"><h2 id="venue-more">More at {e.venue_name}</h2><EventList events={atVenue} empty="" /></section>
      )}
      {alike.length > 0 && (
        <section aria-labelledby="alike-more"><h2 id="alike-more">More {e.category_name!.toLowerCase()} in {e.city_name}</h2><EventList events={alike} empty="" /></section>
      )}
      <p className="muted small updated">Updated <time dateTime={e.updated_at.toISOString()}>{stamp(e.updated_at, e.timezone)}</time>.</p>
      <JsonLd data={[eventLd(e), pageLd(eventPath(e), e.title, e.updated_at, ids.event(eventPath(e)))]} />
    </main>
  );
}
