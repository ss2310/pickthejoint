import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { EventList, ExternalLinks, Hero, JsonLd, SourceList } from "@/components/ui";
import { plural, stamp } from "@/lib/format";
import { getVenue, listEvents } from "@/lib/queries";
import { ids, officialLinks, pageLd, venueLd, venuePath } from "@/lib/schema";

export const revalidate = 600;

type Props = { params: Promise<{ city: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { city, slug } = await params;
  const v = await getVenue(city, slug);
  if (!v) return {};
  const where = [v.area_name, v.city_name].filter(Boolean).join(", ");
  const title = `${v.name}, ${where}: upcoming events`;
  const description = `Upcoming and past events at ${v.name} in ${where}${v.address ? `. Address: ${v.address}` : ""}. Each listing links to its source.`;
  return { title, description, alternates: { canonical: venuePath(v.city_slug, v.slug) }, openGraph: { title, description, url: venuePath(v.city_slug, v.slug) } };
}

export default async function VenuePage({ params }: Props) {
  const { city, slug } = await params;
  const v = await getVenue(city, slug);
  if (!v) notFound();
  const [upcoming, past] = await Promise.all([
    listEvents({ venueId: v.id }),
    listEvents({ venueId: v.id, when: "past", limit: 50 }),
  ]);
  const path = venuePath(v.city_slug, v.slug);
  // The page changes when the venue's details or any of its listings change.
  const modified = [...upcoming, ...past].reduce((max, e) => (e.updated_at > max ? e.updated_at : max), v.updated_at);
  const mapQuery = v.lat != null && v.lng != null ? `${v.lat},${v.lng}` : [v.name, v.address, v.city_name].filter(Boolean).join(", ");

  return (
    <main>
      <Hero trail={[{ name: v.city_name, path: `/${v.city_slug}` }, { name: v.name, path }]} title={v.name}
        kicker={<p className="kicker"><span>{v.venue_type ? v.venue_type[0].toUpperCase() + v.venue_type.slice(1) : "Venue"}</span></p>}>
      <p className="lead">
        {v.name} is {v.venue_type ? `${/^[aeiou]/i.test(v.venue_type) ? "an" : "a"} ${v.venue_type}` : "a venue"} in {v.area_name ? `${v.area_name}, ` : ""}{v.city_name}, {v.city_state}.{" "}
        {upcoming.length ? `${plural(upcoming.length, "upcoming event")} ${upcoming.length === 1 ? "is" : "are"} listed here.` : "No upcoming events are listed here at the moment."}
      </p>
      </Hero>
      <div className="wrap page">

      <dl className="facts">
        {v.address && <div><dt>Address</dt><dd>{v.address}</dd></div>}
        {v.area_name && <div><dt>Area</dt><dd><Link href={`/${v.city_slug}/area/${v.area_slug}`}>{v.area_name}</Link></dd></div>}
        <div><dt>Map</dt><dd><a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`} rel="noopener">Open in Google Maps</a></dd></div>
        {v.landmarks && <div><dt>Nearest landmarks</dt><dd>{v.landmarks}</dd></div>}
        {v.how_to_reach && <div><dt>How to reach</dt><dd>{v.how_to_reach}</dd></div>}
        {v.parking && <div><dt>Parking</dt><dd>{v.parking}</dd></div>}
        {v.capacity != null && <div><dt>Capacity</dt><dd>About {v.capacity.toLocaleString("en-IN")} people</dd></div>}
      </dl>

      {v.description && <section aria-labelledby="about-heading"><h2 id="about-heading">About {v.name}</h2><p className="about-text">{v.description}</p></section>}

      <section aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading">Upcoming events at {v.name}</h2>
        <EventList events={upcoming} empty="Nothing is listed at this venue right now." />
      </section>
      {past.length > 0 && (
        <section aria-labelledby="past-heading">
          <h2 id="past-heading">Past events at {v.name}</h2>
          <EventList events={past} empty="" />
        </section>
      )}

      {officialLinks(v.official_links, v.same_as).length > 0 && (
        <section aria-labelledby="links-heading"><h2 id="links-heading">Official links</h2><ExternalLinks links={officialLinks(v.official_links, v.same_as)} /></section>
      )}
      <SourceList sources={v.sources} />
      <p className="muted small updated">Updated <time dateTime={modified.toISOString()}>{stamp(modified, v.timezone)}</time>.</p>
      <JsonLd data={[venueLd(v), pageLd(path, v.name, modified, ids.venue(v.city_slug, v.slug))]} />
      </div>
    </main>
  );
}
