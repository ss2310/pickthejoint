/**
 * Artist page extras (Prompt 10): official videos, dated release notes and
 * the artist's shows city by city. Everything is plain server-rendered HTML.
 * A video is YouTube's own player in an iframe, loaded lazily by the browser
 * (no script of ours), with a line of text beside it saying what it is,
 * because crawlers cannot read inside an embed (hard rule 5).
 */
import { plainDate } from "@/lib/format";
import { messages } from "@/lib/locale";
import type { ArtistUpdate, ArtistVideo, City, EventCard } from "@/lib/queries";
import { eventPath, venuePath } from "@/lib/schema";
import { Link } from "./ui";

export function VideoList({ videos, heading, id, note, more }: {
  videos: ArtistVideo[]; heading: string; id: string; note: string; more?: { href: string; text: string };
}) {
  const t = messages().entity;
  if (videos.length === 0) return null;
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{heading}</h2>
      <p className="muted small">{note}</p>
      <div className="videos">
        {videos.map((v) => (
          <figure key={v.video_id} className="video">
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${v.video_id}`} title={v.title} loading="lazy"
              allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin" />
            <figcaption>
              <strong>{v.title}</strong>{v.published_year ? ` (${v.published_year})` : ""}. {v.blurb}{" "}
              <a href={`https://www.youtube.com/watch?v=${v.video_id}`} rel="noopener">{t.watchOnYoutube}</a>
              {v.channel_title ? <span className="muted small"> · {t.videoBy(v.channel_title)}</span> : null}
            </figcaption>
          </figure>
        ))}
      </div>
      {more && <p><Link href={more.href}>{more.text}</Link></p>}
    </section>
  );
}

export function UpdateList({ updates, timeZone }: { updates: ArtistUpdate[]; timeZone: string }) {
  const t = messages().entity;
  if (updates.length === 0) return null;
  return (
    <section aria-labelledby="updates-heading">
      <h2 id="updates-heading">{t.updates}</h2>
      <p className="muted small">{t.updatesNote}</p>
      <ul className="updates">
        {updates.map((u) => (
          <li key={u.post_url}>
            {u.posted_at && <><time dateTime={u.posted_at.toISOString()}>{plainDate(u.posted_at, timeZone)}</time>: </>}
            {u.text} <a href={u.post_url} rel="noopener nofollow">{t.updateLink}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The artist's upcoming and past events in each of our cities, with venue and date. */
export function ShowsByCity({ name, upcoming, past, cities }: { name: string; upcoming: EventCard[]; past: EventCard[]; cities: City[] }) {
  const t = messages().entity;
  const all = [...upcoming.map((e) => ({ e, upcoming: true })), ...past.map((e) => ({ e, upcoming: false }))];
  if (all.length === 0) return null;
  const slugs = [...new Set(all.map((x) => x.e.city_slug))];
  return (
    <section aria-labelledby="bycity-heading">
      <h2 id="bycity-heading">{t.byCity}</h2>
      <p className="muted small">{t.byCityNote(name)}</p>
      {slugs.map((slug) => (
        <div key={slug}>
          <h3>{t.inCity(cities.find((c) => c.slug === slug)?.name ?? slug)}</h3>
          <ul className="history">
            {all.filter((x) => x.e.city_slug === slug).map(({ e, upcoming: soon }) => (
              <li key={e.id}>
                <time dateTime={e.starts_at.toISOString()}>{plainDate(e.starts_at, e.timezone)}</time>: <Link href={eventPath(e)}>{e.title}</Link>
                {e.venue_name && <>, {e.venue_slug ? <Link href={venuePath(e.city_slug, e.venue_slug)}>{e.venue_name}</Link> : e.venue_name}</>}
                <span className="muted small"> ({e.status === "cancelled" ? t.cancelledTag : soon ? t.upcomingTag : t.pastTag})</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
