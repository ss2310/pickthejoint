/** One renderer for every hub: city home, today, this weekend, this week, a category, an area, the archive. */
import type { Metadata } from "next";
import { hubFaqs, hubSummary, type Hub } from "@/lib/hubs";
import { alternates, localePath, messages } from "@/lib/locale";
import { areasWithEvents, cityLastChange, listCategories, listEvents, type City } from "@/lib/queries";
import { itemListLd, pageLd } from "@/lib/schema";
import { AskBox, EventList, FaqBlock, Hero, HubNav, JsonLd, Link, Updated, type Crumb } from "./ui";

export async function hubMetadata(hub: Hub): Promise<Metadata> {
  // An empty category or area page has nothing to offer a searcher yet.
  const thin = (hub.kind === "category" || hub.kind === "area") && (await listEvents({ ...hub.filter, limit: 1 })).length === 0;
  return {
    title: hub.title,
    description: hub.description,
    alternates: alternates(hub.path),
    robots: thin ? { index: false, follow: true } : undefined,
    openGraph: { title: hub.title, description: hub.description, url: localePath(hub.path), type: "website" },
  };
}

export async function HubPage({ city, hub }: { city: City; hub: Hub }) {
  const m = messages().hub;
  const [events, categories, lastChange] = await Promise.all([listEvents(hub.filter), listCategories(), cityLastChange(city.id)]);
  const next = events.length === 0 && hub.kind !== "past" ? (await listEvents({ cityId: city.id, limit: 1 }))[0] : undefined;
  const areas = hub.kind === "home" ? await areasWithEvents(city.id) : [];
  const trail: Crumb[] = [{ name: city.name, path: `/${city.slug}` }];
  if (hub.kind !== "home") trail.push({ name: hub.heading, path: hub.path });

  return (
    <main>
      <Hero trail={trail} title={hub.heading} tone={hub.kind === "category" ? hub.category!.slug : null}>
        <p className="lead">{hubSummary(hub, city, events, next)}</p>
        {hub.kind === "home" && <AskBox city={city} />}
      </Hero>
      <div className="wrap page">
        <HubNav city={city} categories={categories} current={hub.path} />

        <section aria-labelledby="list-heading">
          <h2 id="list-heading">{m.listHeading(hub.kind)}</h2>
          <EventList events={events} empty={m.nothing} />
          {hub.kind === "home" && (
            <p className="actions">
              <Link href={`/${city.slug}/search`}>{m.seeAll(city.name)}</Link>
              <a href={`/${city.slug}/feed.ics`}>{m.calendarFeed}</a>
              <a href={`/${city.slug}/feed.json`}>{m.jsonFeed}</a>
            </p>
          )}
        </section>

        {areas.length > 0 && (
          <section aria-labelledby="areas-heading">
            <h2 id="areas-heading">{m.byArea}</h2>
            <ul className="chips">
              {areas.map((a) => <li key={a.slug}><Link href={`/${city.slug}/area/${a.slug}`}>{a.name}</Link></li>)}
            </ul>
          </section>
        )}

        <FaqBlock faqs={hubFaqs(hub, city, events)} />
        <Updated at={lastChange} timeZone={city.timezone} />
        {events.length > 0 && <JsonLd data={itemListLd(hub.heading, events)} />}
        <JsonLd data={pageLd(hub.path, hub.heading, lastChange)} />
      </div>
    </main>
  );
}
