/** One renderer for every hub: city home, today, this weekend, this week, a category, an area, the archive. */
import type { Metadata } from "next";
import Link from "next/link";
import { hubFaqs, hubSummary, type Hub } from "@/lib/hubs";
import { areasWithEvents, cityLastChange, listCategories, listEvents, type City } from "@/lib/queries";
import { itemListLd, pageLd } from "@/lib/schema";
import { Breadcrumbs, EventList, FaqBlock, HubNav, JsonLd, Updated, type Crumb } from "./ui";

export async function hubMetadata(hub: Hub): Promise<Metadata> {
  // An empty category or area page has nothing to offer a searcher yet.
  const thin = (hub.kind === "category" || hub.kind === "area") && (await listEvents({ ...hub.filter, limit: 1 })).length === 0;
  return {
    title: hub.title,
    description: hub.description,
    alternates: { canonical: hub.path },
    robots: thin ? { index: false, follow: true } : undefined,
    openGraph: { title: hub.title, description: hub.description, url: hub.path, type: "website" },
  };
}

export async function HubPage({ city, hub }: { city: City; hub: Hub }) {
  const [events, categories, lastChange] = await Promise.all([listEvents(hub.filter), listCategories(), cityLastChange(city.id)]);
  const next = events.length === 0 && hub.kind !== "past" ? (await listEvents({ cityId: city.id, limit: 1 }))[0] : undefined;
  const areas = hub.kind === "home" ? await areasWithEvents(city.id) : [];
  const trail: Crumb[] = [{ name: city.name, path: `/${city.slug}` }];
  if (hub.kind !== "home") trail.push({ name: hub.heading, path: hub.path });

  return (
    <main>
      <Breadcrumbs trail={trail} />
      <h1>{hub.heading}</h1>
      <p className="lead">{hubSummary(hub, city, events, next)}</p>
      <HubNav city={city} categories={categories} current={hub.path} />

      <section aria-labelledby="list-heading">
        <h2 id="list-heading">{hub.kind === "past" ? "Past events" : hub.kind === "home" ? "On this week" : "Listings"}</h2>
        <EventList events={events} empty="Nothing is listed here yet." />
        {hub.kind === "home" && (
          <p className="actions">
            <Link href={`/${city.slug}/search`}>See everything coming up in {city.name}</Link>
            <a href={`/${city.slug}/feed.ics`}>Calendar feed (ICS)</a>
            <a href={`/${city.slug}/feed.json`}>JSON feed</a>
          </p>
        )}
      </section>

      {areas.length > 0 && (
        <section aria-labelledby="areas-heading">
          <h2 id="areas-heading">By area</h2>
          <ul className="chips">
            {areas.map((a) => <li key={a.slug}><Link href={`/${city.slug}/area/${a.slug}`}>{a.name}</Link></li>)}
          </ul>
        </section>
      )}

      <FaqBlock faqs={hubFaqs(hub, city, events)} />
      <Updated at={lastChange} timeZone={city.timezone} />
      {events.length > 0 && <JsonLd data={itemListLd(hub.heading, events)} />}
      <JsonLd data={pageLd(hub.path, hub.heading, lastChange)} />
    </main>
  );
}
