/** Shared page for artists and organisers: bio, official links, upcoming and past events, sources. */
import type { Metadata } from "next";
import { displayTimeZone } from "@/config";
import { plural, stamp } from "@/lib/format";
import { listEvents, type EventCard, type PersonDetail } from "@/lib/queries";
import { ids, officialLinks, pageLd, type Ld } from "@/lib/schema";
import { Breadcrumbs, EventList, ExternalLinks, JsonLd, SourceList } from "./ui";

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
  const works = p.notable_works ?? [];

  return (
    <main>
      <Breadcrumbs trail={[{ name: kind.label, path: `/${kind.base}/${p.slug}` }]} />
      <h1>{p.name}</h1>
      <p className="lead">
        {p.bio ?? `${p.name} ${kind.base === "artists" ? "has appeared at" : "has organised"} ${plural(upcoming.length + past.length, "event")} listed on Pick the Joint${descriptor ? ` (${descriptor})` : ""}. A fuller profile will be added once it can be sourced.`}
      </p>
      {(p.genre || p.hometown) && (
        <dl className="facts">
          {p.genre && <div><dt>Genre or form</dt><dd>{p.genre}</dd></div>}
          {p.hometown && <div><dt>From</dt><dd>{p.hometown}</dd></div>}
        </dl>
      )}

      <section aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading">Upcoming events</h2>
        <EventList events={upcoming} empty={`No upcoming events with ${p.name} are listed right now.`} />
      </section>
      {past.length > 0 && (
        <section aria-labelledby="past-heading"><h2 id="past-heading">Past events</h2><EventList events={past} empty="" /></section>
      )}
      {works.length > 0 && (
        <section aria-labelledby="works-heading">
          <h2 id="works-heading">Notable work</h2>
          <p className="muted small">Each title links to the work on its official platform. Nothing is hosted here.</p>
          <ul className="links">
            {works.map((w) => (
              <li key={w.url}><a href={w.url} rel="noopener">{w.title}</a>{w.year ? ` (${w.year})` : ""}, on {w.platform}</li>
            ))}
          </ul>
        </section>
      )}
      {links.length > 0 && (
        <section aria-labelledby="links-heading"><h2 id="links-heading">Official links</h2><ExternalLinks links={links} /></section>
      )}
      <SourceList sources={p.sources} />
      <p className="muted small updated">
        Updated <time dateTime={modified.toISOString()}>{stamp(modified, displayTimeZone)}</time>.
        {" "}Only professional, public facts are listed here.
      </p>
      <JsonLd data={[kind.ld(p), pageLd(`/${kind.base}/${p.slug}`, p.name, modified, kind.base === "artists" ? ids.artist(p.slug) : ids.organiser(p.slug))]} />
    </main>
  );
}
