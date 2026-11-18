import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EventList, ExternalLinks, Hero, JsonLd } from "@/components/ui";
import { displayTimeZone } from "@/config";
import { plural, stamp } from "@/lib/format";
import { getSeries, listEvents } from "@/lib/queries";
import { ids, officialLinks, pageLd, seriesLd } from "@/lib/schema";

// Recurring festivals and annual events. The page is permanent; each year's events attach to it.
export const revalidate = 600;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const s = await getSeries((await params).slug);
  if (!s) return {};
  const description = s.description?.slice(0, 200) ?? `${s.name}: dates, venues and past editions, each with its source.`;
  return { title: s.name, description, alternates: { canonical: `/series/${s.slug}` }, openGraph: { title: s.name, description, url: `/series/${s.slug}` } };
}

export default async function SeriesPage({ params }: Props) {
  const s = await getSeries((await params).slug);
  if (!s) notFound();
  const [upcoming, past] = await Promise.all([listEvents({ seriesId: s.id }), listEvents({ seriesId: s.id, when: "past", limit: 100 })]);
  const links = officialLinks(s.official_links, null);
  const modified = [...upcoming, ...past].reduce((max, e) => (e.updated_at > max ? e.updated_at : max), s.updated_at);
  return (
    <main>
      <Hero trail={[{ name: s.name, path: `/series/${s.slug}` }]} title={s.name} tone="festivals"
        kicker={<p className="kicker"><span>Recurring event</span></p>}>
      <p className="lead">
        {s.description ?? `${s.name} is a recurring event.`}{" "}
        {s.recurrence ? `It takes place ${s.recurrence}. ` : ""}
        {upcoming.length ? `${plural(upcoming.length, "upcoming event")} ${upcoming.length === 1 ? "is" : "are"} listed.` : "Dates for the next edition have not been announced yet."}
      </p>
      </Hero>
      <div className="wrap page">
      <section aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading">Upcoming</h2>
        <EventList events={upcoming} empty="No upcoming dates are listed yet." />
      </section>
      {past.length > 0 && <section aria-labelledby="past-heading"><h2 id="past-heading">Past editions</h2><EventList events={past} empty="" /></section>}
      {links.length > 0 && <section aria-labelledby="links-heading"><h2 id="links-heading">Official links</h2><ExternalLinks links={links} /></section>}
      <p className="muted small updated">Updated <time dateTime={modified.toISOString()}>{stamp(modified, displayTimeZone)}</time>.</p>
      <JsonLd data={[seriesLd(s), pageLd(`/series/${s.slug}`, s.name, modified, ids.series(s.slug))]} />
      </div>
    </main>
  );
}
