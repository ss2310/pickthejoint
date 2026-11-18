/**
 * schema.org JSON-LD builders. Each returns a plain object; pages render them
 * with <JsonLd>. Only facts we hold are emitted: an unknown property is left
 * out, never guessed.
 */
import { site } from "../config";
import { isoDay, isoWithOffset } from "./format";
import type { EventCard, EventDetail, PersonDetail, SeriesDetail, VenueDetail } from "./queries";

export type Ld = Record<string, unknown>;

export const abs = (path: string) => `${site.url}${path}`;
export const eventPath = (e: Pick<EventCard, "city_slug" | "slug">) => `/${e.city_slug}/events/${e.slug}`;
export const venuePath = (citySlug: string, slug: string) => `/${citySlug}/venues/${slug}`;

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
  name: string; path?: string; address?: string | null; city: string; state: string; lat?: number | null; lng?: number | null;
  sameAs?: string[];
}): Ld {
  return clean({
    "@type": "Place",
    name: v.name,
    url: v.path ? abs(v.path) : undefined,
    address: clean({
      "@type": "PostalAddress", streetAddress: v.address ?? undefined, addressLocality: v.city, addressRegion: v.state, addressCountry: "IN",
    }),
    geo: v.lat != null && v.lng != null ? { "@type": "GeoCoordinates", latitude: v.lat, longitude: v.lng } : undefined,
    sameAs: v.sameAs,
  });
}

export function eventLd(e: EventDetail): Ld {
  const start = e.start_time_known ? isoWithOffset(e.starts_at, e.timezone) : isoDay(e.starts_at, e.timezone);
  const offers = e.booking_url || e.is_free
    ? clean({
        "@type": "Offer",
        url: e.booking_url ?? abs(eventPath(e)),
        price: e.is_free ? 0 : undefined,
        priceCurrency: "INR",
        description: e.is_free ? undefined : e.price_text ?? undefined,
        availability: e.status === "cancelled" ? "https://schema.org/Discontinued" : "https://schema.org/InStock",
      })
    : undefined;
  return clean({
    "@context": "https://schema.org",
    "@type": EVENT_TYPE[e.category_slug ?? ""] ?? "Event",
    name: e.title,
    url: abs(eventPath(e)),
    description: e.description ?? undefined,
    startDate: start,
    endDate: e.ends_at ? isoWithOffset(e.ends_at, e.timezone) : undefined,
    eventStatus: STATUS[e.status],
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: e.venue_name
      ? placeLd({
          name: e.venue_name, path: e.venue_slug ? venuePath(e.city_slug, e.venue_slug) : undefined, address: e.venue_address,
          city: e.city_name, state: e.city_state, lat: e.venue_lat, lng: e.venue_lng,
        })
      : undefined,
    performer: e.artists.map((a) => ({ "@type": a.kind === "group" ? "MusicGroup" : "Person", name: a.name, url: abs(`/artists/${a.slug}`) })),
    organizer: e.organisers.map((o) => ({ "@type": "Organization", name: o.name, url: abs(`/organisers/${o.slug}`) })),
    offers,
  });
}

export function venueLd(v: VenueDetail): Ld {
  return {
    "@context": "https://schema.org",
    ...placeLd({
      name: v.name, path: venuePath(v.city_slug, v.slug), address: v.address, city: v.city_name, state: v.city_state,
      lat: v.lat, lng: v.lng, sameAs: links(v.official_links, v.same_as),
    }),
    ...clean({ description: v.description ?? undefined, maximumAttendeeCapacity: v.capacity ?? undefined }),
  };
}

export function artistLd(p: PersonDetail): Ld {
  return clean({
    "@context": "https://schema.org",
    "@type": p.kind === "group" ? "MusicGroup" : "Person",
    name: p.name,
    url: abs(`/artists/${p.slug}`),
    description: p.bio ?? undefined,
    genre: p.kind === "group" ? p.genre ?? undefined : undefined,
    sameAs: links(p.official_links, p.same_as),
  });
}

export function organiserLd(p: PersonDetail): Ld {
  return clean({
    "@context": "https://schema.org", "@type": "Organization", name: p.name, url: abs(`/organisers/${p.slug}`),
    description: p.bio ?? undefined, sameAs: links(p.official_links, p.same_as),
  });
}

export function seriesLd(s: SeriesDetail): Ld {
  return clean({
    "@context": "https://schema.org", "@type": "EventSeries", name: s.name, url: abs(`/series/${s.slug}`),
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

export function siteLd(): Ld {
  return {
    "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: site.url,
    publisher: { "@type": "Organization", name: site.name, url: site.url },
  };
}
