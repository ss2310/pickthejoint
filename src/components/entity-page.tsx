/** Shared page for artists and organisers: bio, official links, upcoming and past events, sources. */
import type { Metadata } from "next";
import { displayTimeZone } from "@/config";
import { plural, stamp } from "@/lib/format";
import { listEvents, type EventCard, type PersonDetail } from "@/lib/queries";
import { ids, officialLinks, pageLd, type Ld } from "@/lib/schema";
import { Breadcrumbs, EventList, ExternalLinks, JsonLd } from "./ui";

export interface EntityKind {
  /** "artists" | "organisers" */
  base: string;
  label: string;
  filter: (id: number) => { artistId: number } | { organiserId: number };
  ld: (p: PersonDetail) => Ld;
}

async function events(kind: EntityKind, p: PersonDetail): Promise<{ upcoming: EventCard[]; past: EventCard[] }> {
  const [upcoming, past] = await Promise.all([
    listEvents(kind.filter(p.id)),
    listEvents({ ...kind.filter(p.id), when: "past", limit: 50 }),
  ]);
  return { upcoming, past };
}

/** A page with no bio and a single event says too little to be worth indexing yet. */
const isStub = (p: PersonDetail, total: number) => !p.bio && total < 2;

export async function entityMetadata(kind: EntityKind, p: PersonDetail): Promise<Metadata> {
  const { upcoming, past } = await events(kind, p);
  const title = `${p.name}: upcoming events and past shows`;
  const description = p.bio
    ? p.bio.slice(0, 200)
    : `Events featuring ${p.name} listed on Pick the Joint: ${plural(upcoming.length, "upcoming event")} and ${plural(past.length, "past event")}, each with its source.`;
  return {
    title, description, alternates: { canonical: `/${kind.base}/${p.slug}` },
    robots: isStub(p, upcoming.length + past.length) ? { index: false, follow: true } : undefined,
    openGraph: { title, description, url: `/${kind.base}/${p.slug}` },
  };
}

export async function EntityPage({ kind, p }: { kind: EntityKind; p: PersonDetail }) {
  const { upcoming, past } = await events(kind, p);
  const links = officialLinks(p.official_links, p.same_as);
  const modified = [...upcoming, ...past].reduce((max, e) => (e.updated_at > max ? e.updated_at : max), p.updated_at);
  const descriptor = [p.genre, p.hometown ? `from ${p.hometown}` : null].filter(Boolean).join(", ");

  return (
    <main>
      <Breadcrumbs trail={[{ name: kind.label, path: `/${kind.base}/${p.slug}` }]} />
      <h1>{p.name}</h1>
      <p className="lead">
        {p.bio ?? `${p.name} ${kind.base === "artists" ? "has appeared at" : "has organised"} ${plural(upcoming.length + past.length, "event")} listed on Pick the Joint${descriptor ? ` (${descriptor})` : ""}. A fuller profile will be added once it can be sourced.`}
      </p>

      <section aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading">Upcoming events</h2>
        <EventList events={upcoming} empty={`No upcoming events with ${p.name} are listed right now.`} />
      </section>
      {past.length > 0 && (
        <section aria-labelledby="past-heading"><h2 id="past-heading">Past events</h2><EventList events={past} empty="" /></section>
      )}
      {links.length > 0 && (
        <section aria-labelledby="links-heading"><h2 id="links-heading">Official links</h2><ExternalLinks links={links} /></section>
      )}
      {p.sources.length > 0 && (
        <section aria-labelledby="sources-heading">
          <h2 id="sources-heading">Sources for this page</h2>
          <ul className="links">{p.sources.map((s) => <li key={s.url}><a href={s.url} rel="noopener nofollow">{s.title ?? s.url}</a></li>)}</ul>
        </section>
      )}
      <p className="muted small updated">
        Updated <time dateTime={modified.toISOString()}>{stamp(modified, displayTimeZone)}</time>.
        {" "}Only professional, public facts are listed here.
      </p>
      <JsonLd data={[kind.ld(p), pageLd(`/${kind.base}/${p.slug}`, p.name, modified, kind.base === "artists" ? ids.artist(p.slug) : ids.organiser(p.slug))]} />
    </main>
  );
}
