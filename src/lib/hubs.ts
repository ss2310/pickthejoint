/**
 * Hub pages: city home, today, this weekend, this week, a category, an area
 * and the archive. Each hub is a date range and filter, a two-sentence summary
 * that answers the page's question, and a short FAQ. Summaries and answers are
 * built from the listings themselves, so they can never say more than the data.
 */
import { addDays, clock, isoDay, listJoin, longDay, plural, shortDate, weekdayOf } from "./format";
import type { Area, City, EventCard, EventFilter, Named } from "./queries";

export type HubKind = "home" | "today" | "this-weekend" | "this-week" | "category" | "area" | "past";
export const DATE_HUBS = ["today", "this-weekend", "this-week"] as const;

export interface Hub {
  kind: HubKind;
  path: string;
  /** <h1> */
  heading: string;
  /** <title>, without the site name. */
  title: string;
  description: string;
  filter: EventFilter;
  /** Words for the period or scope, used in sentences: "today", "this weekend", "in Vijay Nagar". */
  scope: string;
  category?: Named;
  area?: Area;
}

/** Friday to Sunday of the current week; on a Sunday, just that Sunday. */
export function weekendRange(today: string): { from: string; to: string } {
  const dow = weekdayOf(today); // 0 Sun .. 6 Sat
  const sunday = addDays(today, dow === 0 ? 0 : 7 - dow);
  const friday = addDays(sunday, -2);
  return { from: friday < today ? today : friday, to: sunday };
}

export function resolveHub(
  city: City, segment: string | undefined, categories: Named[], now = new Date(), area?: Area,
): Hub | null {
  const today = isoDay(now, city.timezone);
  const base = `/${city.slug}`;
  const cityId = city.id;
  if (area) {
    return {
      kind: "area", path: `${base}/area/${area.slug}`, area, scope: `in ${area.name}`,
      heading: `Events in ${area.name}, ${city.name}`, title: `Events in ${area.name}, ${city.name}`,
      description: `Upcoming events at venues in ${area.name}, ${city.name}, with dates, prices, sources and booking links.`,
      filter: { cityId, areaId: area.id },
    };
  }
  switch (segment) {
    case undefined:
      return {
        kind: "home", path: base, scope: "this week", heading: `Events in ${city.name}`, title: `Events in ${city.name}: what's on this week`,
        description: `Concerts, comedy, theatre, workshops and community events in ${city.name}, ${city.state}. Every listing shows its source and when it was last verified.`,
        filter: { cityId, from: today, to: addDays(today, 6) },
      };
    case "today":
      return {
        kind: "today", path: `${base}/today`, scope: "today", heading: `Events in ${city.name} today`, title: `Events in ${city.name} today`,
        description: `What's on in ${city.name} today, ${longDay(today)}: gigs, comedy, theatre, workshops and more, with times, venues and booking links.`,
        filter: { cityId, from: today, to: today },
      };
    case "this-weekend": {
      const w = weekendRange(today);
      return {
        kind: "this-weekend", path: `${base}/this-weekend`, scope: "this weekend", heading: `Events in ${city.name} this weekend`,
        title: `Events in ${city.name} this weekend`,
        description: `What's on in ${city.name} this weekend, ${longDay(w.from)} to ${longDay(w.to)}: every listed event with time, venue, price and booking link.`,
        filter: { cityId, ...w },
      };
    }
    case "this-week":
      return {
        kind: "this-week", path: `${base}/this-week`, scope: "this week", heading: `Events in ${city.name} this week`,
        title: `Events in ${city.name} this week`,
        description: `Every event listed in ${city.name} over the next seven days, from ${longDay(today)}, with times, venues, prices and booking links.`,
        filter: { cityId, from: today, to: addDays(today, 6) },
      };
    case "past":
      return {
        kind: "past", path: `${base}/past`, scope: "in the archive", heading: `Past events in ${city.name}`, title: `Past events in ${city.name}`,
        description: `An archive of events that have taken place in ${city.name}, with venues, performers and sources.`,
        filter: { cityId, when: "past", limit: 300 },
      };
    default: {
      const category = categories.find((c) => c.slug === segment);
      if (!category) return null;
      const name = category.name.toLowerCase();
      return {
        kind: "category", path: `${base}/${category.slug}`, category, scope: `in ${name}`,
        heading: `${category.name} events in ${city.name}`, title: `${category.name} events in ${city.name}`,
        description: `Upcoming ${name} events in ${city.name}, with dates, venues, prices, sources and booking links.`,
        filter: { cityId, categoryId: category.id },
      };
    }
  }
}

/** "Aria Quartet Live at The Blue Room (Sat 21 Nov, 8:00 PM)" */
export function eventLine(e: EventCard): string {
  const when = `${shortDate(e.starts_at, e.timezone)}${e.start_time_known ? `, ${clock(e.starts_at, e.timezone)}` : ""}`;
  return `${e.title}${e.venue_name ? ` at ${e.venue_name}` : ""} (${when})`;
}

const live = (events: EventCard[]) => events.filter((e) => e.status !== "cancelled");

/** Exactly two sentences answering the page's question from the listings. */
export function hubSummary(hub: Hub, city: City, events: EventCard[], next?: EventCard): string {
  const on = live(events);
  const n = on.length;
  if (hub.kind === "past") {
    return n === 0
      ? `No past events are in the ${city.name} archive yet. Events move here once they have taken place.`
      : `The archive holds ${plural(n, "event")} that ${n === 1 ? "has" : "have"} taken place in ${city.name}, most recent first. Each keeps its venue, performers and original source.`;
  }
  const what = hub.kind === "category" ? `${hub.category!.name.toLowerCase()} event` : "event";
  const where = hub.kind === "area" ? `${hub.area!.name}, ${city.name}` : city.name;
  const period = hub.kind === "category" || hub.kind === "area" ? "coming up" : hub.scope;
  if (n === 0) {
    const first = `No ${what}s are currently listed in ${where} ${period === "coming up" ? "for the coming weeks" : `for ${period}`}.`;
    return next ? `${first} The next listed event is ${eventLine(next)}.` : `${first} New listings are added every day as venues and organisers announce them.`;
  }
  const first = `${plural(n, what)} ${n === 1 ? "is" : "are"} listed in ${where} ${period}.`;
  const picks = on.slice(0, 3).map(eventLine);
  const free = on.filter((e) => e.is_free).length;
  const second = n === 1 ? `It is ${picks[0]}.` : `They include ${listJoin(picks)}${free ? `; ${plural(free, "event")} ${free === 1 ? "is" : "are"} free to enter` : ""}.`;
  return `${first} ${second}`;
}

export interface Faq { question: string; answer: string }

function listed(events: EventCard[], none: string): string {
  const on = live(events);
  if (on.length === 0) return none;
  const more = on.length > 5 ? ` There ${on.length - 5 === 1 ? "is" : "are"} ${on.length - 5} more on this page.` : "";
  return `${on.slice(0, 5).map(eventLine).join("; ")}.${more}`;
}

/** Questions phrased the way people ask them, a few in Hinglish, answered from the listings. */
export function hubFaqs(hub: Hub, city: City, events: EventCard[]): Faq[] {
  const on = live(events);
  const c = city.name;
  const free = on.filter((e) => e.is_free);
  const booking: Faq = {
    question: "Where do I book tickets?",
    answer: "Each listing links to the official booking page (for example District, BookMyShow or the organiser's own link) where one has been announced. Pick the Joint does not sell tickets.",
  };
  const freeFaq = (period: string): Faq => ({
    question: `Are there any free events in ${c} ${period}?`,
    answer: free.length ? `Yes, ${plural(free.length, "listed event")} ${free.length === 1 ? "has" : "have"} free entry: ${free.slice(0, 5).map(eventLine).join("; ")}.`
      : `No event listed ${period} is marked as free entry. Prices are shown on each listing where the organiser has announced them.`,
  });
  const none = (period: string) => `No events are listed in ${c} ${period} yet. Listings are updated every day.`;
  const noneHi = "Abhi koi event listed nahi hai. Listings roz update hoti hain.";
  const hi = (lead: string) => (on.length ? `${lead} ${on.slice(0, 5).map(eventLine).join("; ")}.` : noneHi);

  switch (hub.kind) {
    case "today":
      return [
        { question: `What is happening in ${c} today?`, answer: listed(events, none("today")) },
        { question: `Aaj ${c} mein kya ho raha hai?`, answer: hi(`Aaj ${c} mein ${on.length} event listed ${on.length === 1 ? "hai" : "hain"}:`) },
        freeFaq("today"), booking,
      ];
    case "this-weekend":
      return [
        { question: `What's on in ${c} this weekend?`, answer: listed(events, none("this weekend")) },
        { question: `Is weekend ${c} mein kya plan hai?`, answer: hi(`Is weekend ${c} mein ${on.length} event listed ${on.length === 1 ? "hai" : "hain"}:`) },
        freeFaq("this weekend"), booking,
      ];
    case "category": {
      const name = hub.category!.name.toLowerCase();
      return [
        { question: `Are there any ${name} events in ${c} coming up?`, answer: listed(events, `No ${name} events are listed in ${c} at the moment. Listings are updated every day.`) },
        { question: `${c} mein ${name} events kab hain?`, answer: hi(`${c} mein ${name} ke ${on.length} event listed ${on.length === 1 ? "hai" : "hain"}:`) },
        booking,
      ];
    }
    case "area": {
      const a = hub.area!.name;
      return [
        { question: `What events are happening in ${a}, ${c}?`, answer: listed(events, `No events are listed at venues in ${a} at the moment. Listings are updated every day.`) },
        { question: `${a} ke paas kya events hain?`, answer: hi(`${a} mein ${on.length} event listed ${on.length === 1 ? "hai" : "hain"}:`) },
        booking,
      ];
    }
    case "past":
      return [
        { question: `Why do you keep past events in ${c}?`, answer: "Past listings show what a venue or artist has hosted before, and each keeps its original source. Nothing is deleted once an event has taken place." },
      ];
    default:
      return [
        { question: `What is there to do in ${c} this week?`, answer: listed(events, none("this week")) },
        { question: `${c} mein is hafte kya events hain?`, answer: hi(`Is hafte ${c} mein ${on.length} event listed ${on.length === 1 ? "hai" : "hain"}:`) },
        freeFaq("this week"),
        { question: "How do you know these events are real?", answer: "Every listing comes from the organiser's or venue's own announcement or another named source, which is linked on the event page with the date it was last verified. Anything uncertain is held back for review instead of being published." },
        booking,
      ];
  }
}
