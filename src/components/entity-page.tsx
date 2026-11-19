/** Shared page for artists and organisers: bio, official links, upcoming and past events, sources. */
import type { Metadata } from "next";
import { artistTracking, displayTimeZone } from "@/config";
import { alternates, localePath, messages } from "@/lib/locale";
import { artistUpdates, artistVideos, listEvents, liveCities, type EventCard, type PersonDetail } from "@/lib/queries";
import { ids, officialLinks, pageLd, type Ld } from "@/lib/schema";
import { ShowsByCity, UpdateList, VideoList } from "./artist-media";
import { EventList, ExternalLinks, Hero, JsonLd, SourceList, Updated, initials } from "./ui";

export interface EntityKind {
  base: "artists" | "organisers";
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
  const m = messages().entity;
  const { upcoming, past } = await events(kind, p);
  const path = `/${kind.base}/${p.slug}`;
  const title = m.title(p.name);
  const description = p.bio ? p.bio.slice(0, 200) : m.description(p.name, upcoming.length, past.length);
  return {
    title, description, alternates: alternates(path),
    robots: isStub(p, upcoming.length + past.length) ? { index: false, follow: true } : undefined,
    openGraph: { title, description, url: localePath(path) },
  };
}

export async function EntityPage({ kind, p }: { kind: EntityKind; p: PersonDetail }) {
  const m = messages();
  const t = m.entity;
  const { upcoming, past } = await events(kind, p);
  const links = officialLinks(p.official_links, p.same_as);
  const modified = [...upcoming, ...past].reduce((max, e) => (e.updated_at > max ? e.updated_at : max), p.updated_at);
  const descriptor = [p.genre, p.hometown ? t.from(p.hometown) : null].filter(Boolean).join(", ");
  const works = p.notable_works ?? [];
  const path = `/${kind.base}/${p.slug}`;
  const isArtist = kind.base === "artists";
  // Artists only (Prompt 10): release notes, approved official videos, and their shows city by city.
  const [updates, videos, cities] = isArtist
    ? await Promise.all([artistUpdates(p.id), artistVideos([p.slug], artistTracking.videosPerArtist), liveCities()])
    : [[], [], []];

  return (
    <main>
      <Hero trail={[{ name: t[kind.base], path }]} title={p.name}
        kicker={<span className="avatar" aria-hidden="true">{initials(p.name)}</span>}>
        <p className="lead">{p.bio ?? t.stub(p.name, kind.base === "artists", upcoming.length + past.length, descriptor)}</p>
      </Hero>
      <div className="wrap page">
        {(p.genre || p.hometown) && (
          <dl className="facts">
            {p.genre && <div><dt>{t.genreLabel}</dt><dd>{p.genre}</dd></div>}
            {p.hometown && <div><dt>{t.fromLabel}</dt><dd>{p.hometown}</dd></div>}
          </dl>
        )}

        <section aria-labelledby="upcoming-heading">
          <h2 id="upcoming-heading">{t.upcoming}</h2>
          <EventList events={upcoming} empty={t.noUpcoming(p.name)} />
        </section>
        {past.length > 0 && (
          <section aria-labelledby="past-heading"><h2 id="past-heading">{t.past}</h2><EventList events={past} empty="" /></section>
        )}
        {isArtist && <UpdateList updates={updates} timeZone={displayTimeZone} />}
        {isArtist && <VideoList videos={videos} heading={t.videos} id="videos-heading" note={t.videosNote(p.name)} />}
        {isArtist && <ShowsByCity name={p.name} upcoming={upcoming} past={past} cities={cities} />}
        {works.length > 0 && (
          <section aria-labelledby="works-heading">
            <h2 id="works-heading">{t.works}</h2>
            <p className="muted small">{t.worksNote}</p>
            <ul className="links">
              {works.map((w) => (
                <li key={w.url}><a href={w.url} rel="noopener">{w.title}</a>{w.year ? ` (${w.year})` : ""}{t.onPlatform(w.platform)}</li>
              ))}
            </ul>
          </section>
        )}
        {links.length > 0 && (
          <section aria-labelledby="links-heading"><h2 id="links-heading">{m.common.officialLinks}</h2><ExternalLinks links={links} /></section>
        )}
        <SourceList sources={p.sources} />
        <Updated at={modified} timeZone={displayTimeZone} note={t.professional} />
        <JsonLd data={[kind.ld(p), pageLd(path, p.name, modified, kind.base === "artists" ? ids.artist(p.slug) : ids.organiser(p.slug))]} />
      </div>
    </main>
  );
}
