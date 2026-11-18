/**
 * schema.org JSON-LD builders. Each returns a plain object; pages render them
 * with <JsonLd>. Only facts we hold are emitted: an unknown property is left
 * out, never guessed.
 *
 * Every venue, artist, organiser and the site itself has one stable @id (its
 * page address plus a fragment). Pages refer to an entity by that @id, so a
 * crawler reading several pages sees one entity, not several lookalikes.
 */
import { site } from "../config";
import { isoDay, isoWithOffset } from "./format";
import type { EventCard, EventDetail, PersonDetail, SeriesDetail, VenueDetail } from "./queries";

export type Ld = Record<string, unknown>;

export const abs = (path: string) => `${site.url}${path}`;
export const eventPath = (e: Pick<EventCard, "city_slug" | "slug">) => `/${e.city_slug}/events/${e.slug}`;
export const venuePath = (citySlug: string, slug: string) => `/${citySlug}/venues/${slug}`;

export const ids = {
  organization: `${site.url}/#organization`,
  website: `${site.url}/#website`,
  event: (path: string) => `${abs(path)}#event`,
  venue: (citySlug: string, slug: string) => `${abs(venuePath(citySlug, slug))}#venue`,
  artist: (slug: string) => `${abs(`/artists/${slug}`)}#artist`,
  organiser: (slug: string) => `${abs(`/organisers/${slug}`)}#organiser`,
  series: (slug: string) => `${abs(`/series/${slug}`)}#series`,
};

/** Generated event card images, in the three shapes Google asks for. */
export const EVENT_IMAGE_SHAPES = { "1x1": [1200, 1200], "4x3": [1200, 900], "16x9": [1200, 675] } as const;
export type EventImageShape = keyof typeof EVENT_IMAGE_SHAPES;
export const eventImagePath = (e: Pick<EventCard, "city_slug" | "slug">, shape: EventImageShape) => `${eventPath(e)}/image/${shape}`;

const EVENT_TYPE: Record<string, string> = {
  music: "MusicEvent", comedy: "ComedyEvent", theatre: "TheaterEvent", dance: "DanceEvent", workshops: "EducationEvent",
  kids: "ChildrensEvent", food: "FoodEvent", festivals: "Festival", "sports-and-fitness": "SportsEvent",
  exhibitions: "ExhibitionEvent", "business-and-networking": "BusinessEvent", nightlife: "SocialEvent",
};
const STATUS: Record<string, string> = {
  scheduled: "https://schema.org/EventScheduled", happened: "https://schema.org/EventScheduled",
  cancelled: "https://schema.org/EventCancelled", postponed: "https://schema.org/EventPostponed",
};

/** Drops undefined, null, empty strings and empty arrays so absent facts are simply absent. */
function clean<T extends Ld>(obj: T): T {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) delete obj[k];
  }
  return obj;
}

function links(official: Record<string, string> | null, sameAs: string[] | null): string[] {
  const out = new Set<string>();
  for (const [kind, value] of Object.entries(official ?? {})) {
    if (!value) continue;
    out.add(/^https?:\/\//.test(value) ? value : kind === "instagram" ? `https://www.instagram.com/${value}/` : "");
  }
  for (const u of sameAs ?? []) out.add(u);
  out.delete("");
  return [...out];
}
export const officialLinks = links;

export function placeLd(v: {
  id?: string; name: string; path?: string; address?: string | null; city: string; state: string; lat?: number | null;
  lng?: number | null; sameAs?: string[];
}): Ld {
  return clean({
    "@type": "Place",
    "@id": v.id,
    name: v.name,
    url: v.path ? abs(v.path) : undefined,
    address: clean({
      "@type": "PostalAddress", streetAddress: v.address ?? undefined, addressLocality: v.city, addressRegion: v.state, addressCountry: "IN",
    }),
    geo: v.lat != null && v.lng != null ? { "@type": "GeoCoordinates", latitude: v.lat, longitude: v.lng } : undefined,
    sameAs: v.sameAs,
  });
}

/** The first rupee amount in a price line: "₹499 onwards" is 499. Nothing is returned for text with no number. */
export function priceFromText(text: string | null): number | undefined {
  const m = text?.replace(/,/g, "").match(/(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?)/i) ?? text?.replace(/,/g, "").match(/^\s*(\d+(?:\.\d+)?)\b/);
  return m ? Number(m[1]) : undefined;
}

export function eventLd(e: EventDetail): Ld {
  const path = eventPath(e);
  const start = e.start_time_known ? isoWithOffset(e.starts_at, e.timezone) : isoDay(e.starts_at, e.timezone);
  const price = e.is_free ? 0 : priceFromText(e.price_text);
  const offers = e.booking_url || e.is_free || price !== undefined
    ? clean({
        "@type": "Offer",
        url: e.booking_url ?? abs(path),
        price,
        priceCurrency: "INR",
        description: e.is_free ? undefined : e.price_text ?? undefined,
        availability: e.status === "cancelled" ? "https://schema.org/Discontinued" : e.status === "happened" ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
      })
    : undefined;
  return clean({
    "@context": "https://schema.org",
    "@type": EVENT_TYPE[e.category_slug ?? ""] ?? "Event",
    "@id": ids.event(path),
    name: e.title,
    url: abs(path),
    description: e.description ?? undefined,
    image: (Object.keys(EVENT_IMAGE_SHAPES) as EventImageShape[]).map((shape) => abs(eventImagePath(e, shape))),
    startDate: start,
    endDate: e.ends_at ? isoWithOffset(e.ends_at, e.timezone) : undefined,
    eventStatus: STATUS[e.status],
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: e.venue_name
      ? placeLd({
          id: e.venue_slug ? ids.venue(e.city_slug, e.venue_slug) : undefined,
          name: e.venue_name, path: e.venue_slug ? venuePath(e.city_slug, e.venue_slug) : undefined, address: e.venue_address,
          city: e.city_name, state: e.city_state, lat: e.venue_lat, lng: e.venue_lng,
        })
      : undefined,
    performer: e.artists.map((a) => ({
      "@type": a.kind === "group" ? "MusicGroup" : "Person", "@id": ids.artist(a.slug), name: a.name, url: abs(`/artists/${a.slug}`),
    })),
    organizer: e.organisers.map((o) => ({ "@type": "Organization", "@id": ids.organiser(o.slug), name: o.name, url: abs(`/organisers/${o.slug}`) })),
    superEvent: e.series ? { "@type": "EventSeries", "@id": ids.series(e.series.slug), name: e.series.name, url: abs(`/series/${e.series.slug}`) } : undefined,
    offers,
  });
}

export function venueLd(v: VenueDetail): Ld {
  return {
    "@context": "https://schema.org",
    ...placeLd({
      id: ids.venue(v.city_slug, v.slug), name: v.name, path: venuePath(v.city_slug, v.slug), address: v.address, city: v.city_name,
      state: v.city_state, lat: v.lat, lng: v.lng, sameAs: links(v.official_links, v.same_as),
    }),
    ...clean({ description: v.description ?? undefined, maximumAttendeeCapacity: v.capacity ?? undefined }),
  };
}

export function artistLd(p: PersonDetail): Ld {
  return clean({
    "@context": "https://schema.org",
    "@type": p.kind === "group" ? "MusicGroup" : "Person",
    "@id": ids.artist(p.slug),
    name: p.name,
    url: abs(`/artists/${p.slug}`),
    description: p.bio ?? undefined,
    genre: p.kind === "group" ? p.genre ?? undefined : undefined,
    sameAs: links(p.official_links, p.same_as),
  });
}

export function organiserLd(p: PersonDetail): Ld {
  return clean({
    "@context": "https://schema.org", "@type": "Organization", "@id": ids.organiser(p.slug), name: p.name, url: abs(`/organisers/${p.slug}`),
    description: p.bio ?? undefined, sameAs: links(p.official_links, p.same_as),
  });
}

export function seriesLd(s: SeriesDetail): Ld {
  return clean({
    "@context": "https://schema.org", "@type": "EventSeries", "@id": ids.series(s.slug), name: s.name, url: abs(`/series/${s.slug}`),
    description: s.description ?? undefined, sameAs: links(s.official_links, null),
  });
}

export function breadcrumbLd(trail: { name: string; path: string }[]): Ld {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, item: abs(t.path) })),
  };
}

export function itemListLd(name: string, events: EventCard[]): Ld {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    numberOfItems: events.length,
    itemListElement: events.map((e, i) => ({ "@type": "ListItem", position: i + 1, name: e.title, url: abs(eventPath(e)) })),
  };
}

export function faqLd(faqs: { question: string; answer: string }[]): Ld {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })),
  };
}

/**
 * The page itself: its address, who publishes it, what it is about and when
 * its content last changed. `modified` must be the same instant the page shows
 * as "Updated".
 */
export function pageLd(path: string, name: string, modified: Date | null, aboutId?: string): Ld {
  return clean({
    "@context": "https://schema.org", "@type": "WebPage", "@id": abs(path), url: abs(path), name,
    isPartOf: { "@id": ids.website }, publisher: { "@id": ids.organization },
    mainEntity: aboutId ? { "@id": aboutId } : undefined,
    dateModified: modified ? modified.toISOString() : undefined,
    inLanguage: "en-IN",
  });
}

/** Pick the Joint as an organisation and as a website. Rendered once, in the layout. */
export function siteLd(): Ld[] {
  return [
    clean({
      "@context": "https://schema.org", "@type": "Organization", "@id": ids.organization, name: site.name, url: site.url,
      email: site.contactEmail || undefined, sameAs: [...site.profiles],
    }),
    { "@context": "https://schema.org", "@type": "WebSite", "@id": ids.website, name: site.name, url: site.url, publisher: { "@id": ids.organization }, inLanguage: "en-IN" },
  ];
}
