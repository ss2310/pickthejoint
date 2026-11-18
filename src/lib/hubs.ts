/**
 * Hub pages: city home, today, this weekend, this week, a category, an area
 * and the archive. Each hub is a date range and filter, a two-sentence summary
 * that answers the page's question, and a short FAQ. Summaries and answers are
 * built from the listings themselves, so they can never say more than the data.
 * The sentences themselves live in the locale files; this module supplies the
 * facts that go into them.
 */
import type { Locale } from "../config";
import type { Faq, HubKind } from "../locales/en";
import { addDays, clock, isoDay, longDay, shortDate, weekdayOf } from "./format";
import { getLocale, messages } from "./locale";
import type { Area, City, EventCard, EventFilter, Named } from "./queries";

export type { Faq, HubKind };
export const DATE_HUBS = ["today", "this-weekend", "this-week"] as const;

export interface Hub {
  kind: HubKind;
  /** Without a language prefix: "/indore/today". */
  path: string;
  /** <h1> */
  heading: string;
  /** <title>, without the site name. */
  title: string;
  description: string;
  filter: EventFilter;
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

/** A category's name in a language: the interface's own word where it has one, else the stored name. */
export function categoryName(c: { slug: string | null; name: string | null }, locale: Locale = getLocale()): string {
  return (c.slug && messages(locale).common.categories[c.slug]) || c.name || "";
}

export function resolveHub(
  city: City, segment: string | undefined, categories: Named[], now = new Date(), area?: Area, locale: Locale = getLocale(),
): Hub | null {
  const today = isoDay(now, city.timezone);
  const base = `/${city.slug}`;
  const cityId = city.id;
  const text = (kind: HubKind, extra: { category?: string; area?: string; from?: string; to?: string } = {}) =>
    messages(locale).hub.text({ kind, city: city.name, state: city.state, today: longDay(today, locale), ...extra });

  if (area) return { kind: "area", path: `${base}/area/${area.slug}`, area, ...text("area", { area: area.name }), filter: { cityId, areaId: area.id } };
  switch (segment) {
    case undefined:
      return { kind: "home", path: base, ...text("home"), filter: { cityId, from: today, to: addDays(today, 6) } };
    case "today":
      return { kind: "today", path: `${base}/today`, ...text("today"), filter: { cityId, from: today, to: today } };
    case "this-weekend": {
      const w = weekendRange(today);
      return { kind: "this-weekend", path: `${base}/this-weekend`, ...text("this-weekend", { from: longDay(w.from, locale), to: longDay(w.to, locale) }), filter: { cityId, ...w } };
    }
    case "this-week":
      return { kind: "this-week", path: `${base}/this-week`, ...text("this-week"), filter: { cityId, from: today, to: addDays(today, 6) } };
    case "past":
      return { kind: "past", path: `${base}/past`, ...text("past"), filter: { cityId, when: "past", limit: 300 } };
    default: {
      const category = categories.find((c) => c.slug === segment);
      if (!category) return null;
      return {
        kind: "category", path: `${base}/${category.slug}`, category, ...text("category", { category: categoryName(category, locale) }),
        filter: { cityId, categoryId: category.id },
      };
    }
  }
}

/** "Aria Quartet Live at The Blue Room (Sat 21 Nov, 8:00 PM)" */
export function eventLine(e: EventCard, locale: Locale = getLocale()): string {
  const when = `${shortDate(e.starts_at, e.timezone, locale)}${e.start_time_known ? `, ${clock(e.starts_at, e.timezone, locale)}` : ""}`;
  return messages(locale).hub.eventLine(e.title, e.venue_name, when);
}

const live = (events: EventCard[]) => events.filter((e) => e.status !== "cancelled");
const names = (hub: Hub, city: City, locale: Locale) => ({
  kind: hub.kind, city: city.name, category: hub.category ? categoryName(hub.category, locale) : undefined, area: hub.area?.name,
});

/** Exactly two sentences answering the page's question from the listings. */
export function hubSummary(hub: Hub, city: City, events: EventCard[], next?: EventCard, locale: Locale = getLocale()): string {
  const on = live(events);
  return messages(locale).hub.summary({
    ...names(hub, city, locale), count: on.length, picks: on.slice(0, 3).map((e) => eventLine(e, locale)),
    free: on.filter((e) => e.is_free).length, next: next ? eventLine(next, locale) : undefined,
  });
}

/** Questions phrased the way people ask them, answered from the listings. */
export function hubFaqs(hub: Hub, city: City, events: EventCard[], locale: Locale = getLocale()): Faq[] {
  const on = live(events);
  const free = on.filter((e) => e.is_free);
  return messages(locale).hub.faqs({
    ...names(hub, city, locale), count: on.length, lines: on.slice(0, 5).map((e) => eventLine(e, locale)),
    freeCount: free.length, freeLines: free.slice(0, 5).map((e) => eventLine(e, locale)),
  });
}
