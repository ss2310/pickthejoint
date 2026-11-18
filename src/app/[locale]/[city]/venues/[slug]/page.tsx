import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EventList, ExternalLinks, Hero, JsonLd, Link, SourceList, Updated } from "@/components/ui";
import { alternates, localePath, messages, setLocale } from "@/lib/locale";
import { getVenue, listEvents } from "@/lib/queries";
import { ids, officialLinks, pageLd, venueLd, venuePath } from "@/lib/schema";

export const revalidate = 600;

type Props = { params: Promise<{ locale: string; city: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, city, slug } = await params;
  setLocale(locale);
  const v = await getVenue(city, slug);
  if (!v) return {};
  const m = messages().venue;
  const where = [v.area_name, v.city_name].filter(Boolean).join(", ");
  const title = m.title(v.name, where);
  const description = m.description(v.name, where, v.address);
  const path = venuePath(v.city_slug, v.slug);
  return { title, description, alternates: alternates(path), openGraph: { title, description, url: localePath(path) } };
}

export default async function VenuePage({ params }: Props) {
  const { locale, city, slug } = await params;
  setLocale(locale);
  const v = await getVenue(city, slug);
  if (!v) notFound();
  const all = messages();
  const m = all.venue;
  const [upcoming, past] = await Promise.all([
    listEvents({ venueId: v.id }),
    listEvents({ venueId: v.id, when: "past", limit: 50 }),
  ]);
  const path = venuePath(v.city_slug, v.slug);
  // The page changes when the venue's details or any of its listings change.
  const modified = [...upcoming, ...past].reduce((max, e) => (e.updated_at > max ? e.updated_at : max), v.updated_at);
  const mapQuery = v.lat != null && v.lng != null ? `${v.lat},${v.lng}` : [v.name, v.address, v.city_name].filter(Boolean).join(", ");
  const links = officialLinks(v.official_links, v.same_as);

  return (
    <main>
      <Hero trail={[{ name: v.city_name, path: `/${v.city_slug}` }, { name: v.name, path }]} title={v.name}
        kicker={<p className="kicker"><span>{v.venue_type ? v.venue_type[0].toUpperCase() + v.venue_type.slice(1) : m.kicker}</span></p>}>
        <p className="lead">{m.lead(v.name, v.venue_type, v.area_name, v.city_name, v.city_state, upcoming.length)}</p>
      </Hero>
      <div className="wrap page">
        <dl className="facts">
          {v.address && <div><dt>{m.address}</dt><dd>{v.address}</dd></div>}
          {v.area_name && <div><dt>{m.area}</dt><dd><Link href={`/${v.city_slug}/area/${v.area_slug}`}>{v.area_name}</Link></dd></div>}
          <div><dt>{m.map}</dt><dd><a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`} rel="noopener">{all.event.openMaps}</a></dd></div>
          {v.landmarks && <div><dt>{m.landmarks}</dt><dd>{v.landmarks}</dd></div>}
          {v.how_to_reach && <div><dt>{m.howToReach}</dt><dd>{v.how_to_reach}</dd></div>}
          {v.parking && <div><dt>{m.parking}</dt><dd>{v.parking}</dd></div>}
          {v.capacity != null && <div><dt>{m.capacity}</dt><dd>{m.capacityValue(v.capacity.toLocaleString("en-IN"))}</dd></div>}
        </dl>

        {v.description && <section aria-labelledby="about-heading"><h2 id="about-heading">{m.about(v.name)}</h2><p className="about-text">{v.description}</p></section>}

        <section aria-labelledby="upcoming-heading">
          <h2 id="upcoming-heading">{m.upcomingAt(v.name)}</h2>
          <EventList events={upcoming} empty={m.nothing} />
        </section>
        {past.length > 0 && (
          <section aria-labelledby="past-heading">
            <h2 id="past-heading">{m.pastAt(v.name)}</h2>
            <EventList events={past} empty="" />
          </section>
        )}

        {links.length > 0 && (
          <section aria-labelledby="links-heading"><h2 id="links-heading">{all.common.officialLinks}</h2><ExternalLinks links={links} /></section>
        )}
        <SourceList sources={v.sources} />
        <Updated at={modified} timeZone={v.timezone} />
        <JsonLd data={[venueLd(v), pageLd(path, v.name, modified, ids.venue(v.city_slug, v.slug))]} />
      </div>
    </main>
  );
}
