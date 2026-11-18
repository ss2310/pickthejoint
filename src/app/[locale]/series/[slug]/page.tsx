import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EventList, ExternalLinks, Hero, JsonLd, SourceList, Updated } from "@/components/ui";
import { displayTimeZone } from "@/config";
import { alternates, localePath, messages, setLocale } from "@/lib/locale";
import { getSeries, listEvents } from "@/lib/queries";
import { ids, officialLinks, pageLd, seriesLd } from "@/lib/schema";

// Recurring festivals and annual events. The page is permanent; each year's events attach to it.
export const revalidate = 600;

type Props = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = await params;
  setLocale(p.locale);
  const s = await getSeries(p.slug);
  if (!s) return {};
  const path = `/series/${s.slug}`;
  const description = s.description?.slice(0, 200) ?? messages().series.description(s.name);
  return { title: s.name, description, alternates: alternates(path), openGraph: { title: s.name, description, url: localePath(path) } };
}

export default async function SeriesPage({ params }: Props) {
  const p = await params;
  setLocale(p.locale);
  const s = await getSeries(p.slug);
  if (!s) notFound();
  const all = messages();
  const m = all.series;
  const [upcoming, past] = await Promise.all([listEvents({ seriesId: s.id }), listEvents({ seriesId: s.id, when: "past", limit: 100 })]);
  const links = officialLinks(s.official_links, null);
  const modified = [...upcoming, ...past].reduce((max, e) => (e.updated_at > max ? e.updated_at : max), s.updated_at);
  const path = `/series/${s.slug}`;
  return (
    <main>
      <Hero trail={[{ name: s.name, path }]} title={s.name} tone="festivals" kicker={<p className="kicker"><span>{m.kicker}</span></p>}>
        <p className="lead">
          {s.description ?? m.fallback(s.name)}{" "}
          {s.recurrence ? m.recurrence(s.recurrence) : ""}
          {upcoming.length ? m.listed(upcoming.length) : m.notAnnounced}
        </p>
      </Hero>
      <div className="wrap page">
        <section aria-labelledby="upcoming-heading">
          <h2 id="upcoming-heading">{m.upcoming}</h2>
          <EventList events={upcoming} empty={m.noDates} />
        </section>
        {past.length > 0 && <section aria-labelledby="past-heading"><h2 id="past-heading">{m.past}</h2><EventList events={past} empty="" /></section>}
        {links.length > 0 && <section aria-labelledby="links-heading"><h2 id="links-heading">{all.common.officialLinks}</h2><ExternalLinks links={links} /></section>}
        <SourceList sources={s.sources} />
        <Updated at={modified} timeZone={displayTimeZone} />
        <JsonLd data={[seriesLd(s), pageLd(path, s.name, modified, ids.series(s.slug))]} />
      </div>
    </main>
  );
}
