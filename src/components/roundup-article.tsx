/**
 * A weekly guide (Prompt 11), as the public page and the admin preview show it.
 * The overview is the stored text; every event line comes from the database
 * now, so a cancelled or corrected event reads correctly in old guides too.
 */
import { categoryName } from "@/lib/hubs";
import { longDay, plainDate } from "@/lib/format";
import { messages } from "@/lib/locale";
import type { EventCard } from "@/lib/queries";
import type { Roundup } from "@/lib/roundups";
import { articleLd, eventPath, pageLd } from "@/lib/schema";
import { EventList, Hero, JsonLd, Link, Updated } from "./ui";

export const guidePath = (city: string, slug: string) => `/${city}/guide/${slug}`;

/** A section's heading: the category's name in the page's language (from its events), or the guide's own words. */
export function sectionHeading(key: string, events: EventCard[]): string {
  const g = messages().guide;
  if (key === "free") return g.free;
  if (key === "families") return g.families;
  if (key === "other") return g.other;
  return categoryName({ slug: key, name: events.find((e) => e.category_slug === key)?.category_name ?? key });
}

export function RoundupArticle({ r, events, preview }: { r: Roundup; events: Map<number, EventCard>; preview?: boolean }) {
  const g = messages().guide;
  const path = guidePath(r.city_slug, r.slug);
  const sections = r.sections
    .map((s) => ({ key: s.key, events: s.event_ids.map((id) => events.get(Number(id))).filter((e): e is EventCard => !!e) }))
    .filter((s) => s.events.length > 0);
  const listed = [...new Set(sections.flatMap((s) => s.events.map((e) => eventPath(e))))];
  const published = r.published_at ?? r.generated_at;
  // The admin preview sits inside the admin page's own <main>.
  const Outer = preview ? "div" : "main";
  return (
    <Outer>
      <article className="guide">
        <Hero trail={[{ name: r.city_name, path: `/${r.city_slug}` }, { name: g.indexHeading(r.city_name), path: `/${r.city_slug}/guide` }, { name: r.title, path }]}
          title={r.title} long kicker={<p className="kicker">{g.kicker}</p>}>
          <p className="lead">
            {g.period(longDay(r.period_start), longDay(r.period_end))} · {g.count(listed.length)}
            {r.published_at && <> · {g.published} <time dateTime={r.published_at.toISOString()}>{plainDate(r.published_at, r.timezone)}</time></>}
          </p>
        </Hero>
        <div className="wrap page">
          {preview && <p className="banner banner-warn">Preview: {r.status === "draft" ? "this draft is not public yet." : "this guide is published."}</p>}
          <p className="about-text guide-intro">{r.intro}</p>
          {sections.length > 1 && (
            <nav aria-labelledby="guide-toc" className="guide-toc">
              <h2 id="guide-toc" className="small">{g.inThis}</h2>
              <ul>{sections.map((s) => <li key={s.key}><a href={`#s-${s.key}`}>{sectionHeading(s.key, s.events)}</a> ({s.events.length})</li>)}</ul>
            </nav>
          )}
          {sections.map((s) => (
            <section key={s.key} aria-labelledby={`s-${s.key}`}>
              <h2 id={`s-${s.key}`}>{sectionHeading(s.key, s.events)}</h2>
              <EventList events={s.events} empty="" />
            </section>
          ))}
          <p className="muted small">{g.method}</p>
          <p className="small"><Link href={`/${r.city_slug}/guide`}>{g.all}</Link></p>
          <Updated at={r.updated_at} timeZone={r.timezone} />
          {!preview && (
            <JsonLd data={[
              articleLd({ path, headline: r.title, description: r.intro, published, modified: r.updated_at, city: r.city_name, eventPaths: listed }),
              pageLd(path, r.title, r.updated_at, undefined),
            ]} />
          )}
        </div>
      </article>
    </Outer>
  );
}
