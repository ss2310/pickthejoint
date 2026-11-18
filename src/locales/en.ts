/**
 * English interface text. Every word the site itself says (as opposed to
 * what is stored about an event, venue or artist) lives in a locale file;
 * `hi.ts` has the same shape in Hindi. The files hold plain strings and small
 * functions that build sentences, nothing else.
 */

export type HubKind = "home" | "today" | "this-weekend" | "this-week" | "category" | "area" | "past";

export interface HubTextInput { kind: HubKind; city: string; state: string; category?: string; area?: string; today: string; from?: string; to?: string }
export interface HubText { heading: string; title: string; description: string }
export interface SummaryInput { kind: HubKind; city: string; category?: string; area?: string; count: number; picks: string[]; free: number; next?: string }
export interface FaqInput { kind: HubKind; city: string; category?: string; area?: string; count: number; lines: string[]; freeCount: number; freeLines: string[] }
export interface Faq { question: string; answer: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listJoin = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const PERIOD: Partial<Record<HubKind, string>> = { home: "this week", today: "today", "this-weekend": "this weekend", "this-week": "this week" };

export const en = {
  site: {
    description: "What's on in Indian cities: concerts, comedy, theatre, workshops and more, with sources and verification dates.",
    skip: "Skip to content",
    navAbout: "About",
    navVerify: "How we verify",
    navLabel: "Site",
    footerLabel: "Footer",
    footer: (name: string) => `${name} lists events from named public sources and links to the official booking page. It does not sell tickets.`,
    footerVerify: "How we collect and verify events",
    footerCorrections: "Corrections and takedown",
    footerChangelog: "Changelog",
    /** The link to the other language, shown in that language. */
    switchTo: "हिन्दी में पढ़ें",
    breadcrumb: "Breadcrumb",
  },
  common: {
    updated: "Updated",
    cancelled: "Cancelled",
    postponed: "Postponed",
    freeEntry: "Free entry",
    events: (n: number) => plural(n, "event"),
    faqHeading: "Questions people ask",
    sourcesHeading: "Sources for this page",
    sourcesNote: "Each fact above was taken from the pages listed here and written in our own words.",
    usedFor: "Used for",
    /** Names of the facts a source supported; English is stored, so nothing to map. */
    factLabels: {} as Record<string, string>,
    officialLinks: "Official links",
    /** Category names by slug, where the interface has its own; otherwise the stored name is used. */
    categories: {} as Record<string, string>,
  },
  nav: {
    listings: (city: string) => `${city} listings`,
    thisWeek: "This week", today: "Today", thisWeekend: "This weekend", past: "Past events", search: "Search",
  },
  hub: {
    listHeading: (kind: HubKind): string => (kind === "past" ? "Past events" : kind === "home" ? "On this week" : "Listings"),
    nothing: "Nothing is listed here yet.",
    seeAll: (city: string) => `See everything coming up in ${city}`,
    calendarFeed: "Calendar feed (ICS)",
    jsonFeed: "JSON feed",
    byArea: "By area",
    eventLine: (title: string, venue: string | null, when: string) => `${title}${venue ? ` at ${venue}` : ""} (${when})`,
    text(i: HubTextInput): HubText {
      const c = i.city;
      switch (i.kind) {
        case "area":
          return { heading: `Events in ${i.area}, ${c}`, title: `Events in ${i.area}, ${c}`,
            description: `Upcoming events at venues in ${i.area}, ${c}, with dates, prices, sources and booking links.` };
        case "home":
          return { heading: `Events in ${c}`, title: `Events in ${c}: what's on this week`,
            description: `Concerts, comedy, theatre, workshops and community events in ${c}, ${i.state}. Every listing shows its source and when it was last verified.` };
        case "today":
          return { heading: `Events in ${c} today`, title: `Events in ${c} today`,
            description: `What's on in ${c} today, ${i.today}: gigs, comedy, theatre, workshops and more, with times, venues and booking links.` };
        case "this-weekend":
          return { heading: `Events in ${c} this weekend`, title: `Events in ${c} this weekend`,
            description: `What's on in ${c} this weekend, ${i.from} to ${i.to}: every listed event with time, venue, price and booking link.` };
        case "this-week":
          return { heading: `Events in ${c} this week`, title: `Events in ${c} this week`,
            description: `Every event listed in ${c} over the next seven days, from ${i.today}, with times, venues, prices and booking links.` };
        case "past":
          return { heading: `Past events in ${c}`, title: `Past events in ${c}`,
            description: `An archive of events that have taken place in ${c}, with venues, performers and sources.` };
        default:
          return { heading: `${i.category} events in ${c}`, title: `${i.category} events in ${c}`,
            description: `Upcoming ${i.category!.toLowerCase()} events in ${c}, with dates, venues, prices, sources and booking links.` };
      }
    },
    /** Exactly two sentences answering the page's question from the listings. */
    summary(i: SummaryInput): string {
      const n = i.count;
      if (i.kind === "past") {
        return n === 0
          ? `No past events are in the ${i.city} archive yet. Events move here once they have taken place.`
          : `The archive holds ${plural(n, "event")} that ${n === 1 ? "has" : "have"} taken place in ${i.city}, most recent first. Each keeps its venue, performers and original source.`;
      }
      const what = i.kind === "category" ? `${i.category!.toLowerCase()} event` : "event";
      const where = i.kind === "area" ? `${i.area}, ${i.city}` : i.city;
      const period = PERIOD[i.kind] ?? "coming up";
      if (n === 0) {
        const first = `No ${what}s are currently listed in ${where} ${period === "coming up" ? "for the coming weeks" : `for ${period}`}.`;
        return i.next ? `${first} The next listed event is ${i.next}.` : `${first} New listings are added every day as venues and organisers announce them.`;
      }
      const first = `${plural(n, what)} ${n === 1 ? "is" : "are"} listed in ${where} ${period}.`;
      const second = n === 1 ? `It is ${i.picks[0]}.`
        : `They include ${listJoin(i.picks)}${i.free ? `; ${plural(i.free, "event")} ${i.free === 1 ? "is" : "are"} free to enter` : ""}.`;
      return `${first} ${second}`;
    },
    /** Questions phrased the way people ask them, a few in Hinglish, answered from the listings. */
    faqs(i: FaqInput): Faq[] {
      const c = i.city;
      const n = i.count;
      const listed = (none: string) => {
        if (n === 0) return none;
        const more = n > 5 ? ` There ${n - 5 === 1 ? "is" : "are"} ${n - 5} more on this page.` : "";
        return `${i.lines.join("; ")}.${more}`;
      };
      const booking: Faq = {
        question: "Where do I book tickets?",
        answer: "Each listing links to the official booking page (for example District, BookMyShow or the organiser's own link) where one has been announced. Pick the Joint does not sell tickets.",
      };
      const freeFaq = (period: string): Faq => ({
        question: `Are there any free events in ${c} ${period}?`,
        answer: i.freeCount ? `Yes, ${plural(i.freeCount, "listed event")} ${i.freeCount === 1 ? "has" : "have"} free entry: ${i.freeLines.join("; ")}.`
          : `No event listed ${period} is marked as free entry. Prices are shown on each listing where the organiser has announced them.`,
      });
      const none = (period: string) => `No events are listed in ${c} ${period} yet. Listings are updated every day.`;
      const hinglish = (lead: string) => (n ? `${lead} ${i.lines.join("; ")}.` : "Abhi koi event listed nahi hai. Listings roz update hoti hain.");
      const hai = n === 1 ? "hai" : "hain";
      switch (i.kind) {
        case "today":
          return [
            { question: `What is happening in ${c} today?`, answer: listed(none("today")) },
            { question: `Aaj ${c} mein kya ho raha hai?`, answer: hinglish(`Aaj ${c} mein ${n} event listed ${hai}:`) },
            freeFaq("today"), booking,
          ];
        case "this-weekend":
          return [
            { question: `What's on in ${c} this weekend?`, answer: listed(none("this weekend")) },
            { question: `Is weekend ${c} mein kya plan hai?`, answer: hinglish(`Is weekend ${c} mein ${n} event listed ${hai}:`) },
            freeFaq("this weekend"), booking,
          ];
        case "category": {
          const name = i.category!.toLowerCase();
          return [
            { question: `Are there any ${name} events in ${c} coming up?`, answer: listed(`No ${name} events are listed in ${c} at the moment. Listings are updated every day.`) },
            { question: `${c} mein ${name} events kab hain?`, answer: hinglish(`${c} mein ${name} ke ${n} event listed ${hai}:`) },
            booking,
          ];
        }
        case "area":
          return [
            { question: `What events are happening in ${i.area}, ${c}?`, answer: listed(`No events are listed at venues in ${i.area} at the moment. Listings are updated every day.`) },
            { question: `${i.area} ke paas kya events hain?`, answer: hinglish(`${i.area} mein ${n} event listed ${hai}:`) },
            booking,
          ];
        case "past":
          return [
            { question: `Why do you keep past events in ${c}?`, answer: "Past listings show what a venue or artist has hosted before, and each keeps its original source. Nothing is deleted once an event has taken place." },
          ];
        default:
          return [
            { question: `What is there to do in ${c} this week?`, answer: listed(none("this week")) },
            { question: `${c} mein is hafte kya events hain?`, answer: hinglish(`Is hafte ${c} mein ${n} event listed ${hai}:`) },
            freeFaq("this week"),
            { question: "How do you know these events are real?", answer: "Every listing comes from the organiser's or venue's own announcement or another named source, which is linked on the event page with the date it was last verified. Anything uncertain is held back for review instead of being published." },
            booking,
          ];
      }
    },
  },
  event: {
    cancelledLead: "Cancelled.", cancelledText: "The organiser has announced that this event will not take place.",
    postponedLead: "Postponed.", postponedText: "The organiser has postponed this event; the date below is the original one until a new date is announced.",
    over: (city: string) => `This event has taken place. It is kept here as part of the ${city} archive.`,
    when: "When", where: "Where", price: "Price", performer: "Performer", performers: "Performers", organisedBy: "Organised by", partOf: "Part of",
    timeNotAnnounced: " (start time not announced)",
    to: "to",
    openMaps: "Open in Google Maps",
    book: "Book on the official page",
    bookNote: "Pick the Joint does not sell tickets. This link goes to the organiser's booking page.",
    sideLabel: "Booking and sharing",
    addToCalendar: "Add to calendar",
    shareWhatsapp: "Share on WhatsApp",
    about: "About this event",
    source: "Source",
    sourceInstagram: "Instagram post by the organiser or venue",
    sourceSubmitted: "Submitted by the organiser",
    sourceListing: (host: string) => `Listing on ${host}`,
    sourceWeb: "Web listing",
    lastVerified: "Last verified",
    mistake: "Spotted a mistake?", tellUs: "Tell us",
    moreAt: (venue: string) => `More at ${venue}`,
    moreLike: (category: string, city: string) => `More ${category.toLowerCase()} in ${city}`,
    titleLine: (title: string, venue: string | null, date: string) => `${title}${venue ? `, ${venue}` : ""} (${date})`,
    metaLead: (title: string, venue: string | null, city: string) => `${title}${venue ? ` at ${venue}` : ""}, ${city}`,
    metaTail: "Source and last-verified date on the page.",
    imageAlt: (title: string) => `${title}: date, venue and city`,
  },
  venue: {
    kicker: "Venue",
    title: (name: string, where: string) => `${name}, ${where}: upcoming events`,
    description: (name: string, where: string, address: string | null) => `Upcoming and past events at ${name} in ${where}${address ? `. Address: ${address}` : ""}. Each listing links to its source.`,
    lead(name: string, type: string | null, area: string | null, city: string, state: string, upcoming: number): string {
      const kind = type ? `${/^[aeiou]/i.test(type) ? "an" : "a"} ${type}` : "a venue";
      const count = upcoming ? `${plural(upcoming, "upcoming event")} ${upcoming === 1 ? "is" : "are"} listed here.` : "No upcoming events are listed here at the moment.";
      return `${name} is ${kind} in ${area ? `${area}, ` : ""}${city}, ${state}. ${count}`;
    },
    address: "Address", area: "Area", map: "Map", landmarks: "Nearest landmarks", howToReach: "How to reach", parking: "Parking", capacity: "Capacity",
    capacityValue: (n: string) => `About ${n} people`,
    about: (name: string) => `About ${name}`,
    upcomingAt: (name: string) => `Upcoming events at ${name}`,
    nothing: "Nothing is listed at this venue right now.",
    pastAt: (name: string) => `Past events at ${name}`,
  },
  entity: {
    artists: "Artists", organisers: "Organisers",
    title: (name: string) => `${name}: upcoming events and past shows`,
    description: (name: string, upcoming: number, past: number) =>
      `Events featuring ${name} listed on Pick the Joint: ${plural(upcoming, "upcoming event")} and ${plural(past, "past event")}, each with its source.`,
    stub: (name: string, artist: boolean, total: number, descriptor: string) =>
      `${name} ${artist ? "has appeared at" : "has organised"} ${plural(total, "event")} listed on Pick the Joint${descriptor ? ` (${descriptor})` : ""}. A fuller profile will be added once it can be sourced.`,
    from: (place: string) => `from ${place}`,
    genreLabel: "Genre or form", fromLabel: "From",
    upcoming: "Upcoming events",
    noUpcoming: (name: string) => `No upcoming events with ${name} are listed right now.`,
    past: "Past events",
    works: "Notable work",
    worksNote: "Each title links to the work on its official platform. Nothing is hosted here.",
    onPlatform: (platform: string) => `, on ${platform}`,
    professional: "Only professional, public facts are listed here.",
  },
  series: {
    kicker: "Recurring event",
    fallback: (name: string) => `${name} is a recurring event.`,
    recurrence: (text: string) => `It takes place ${text}. `,
    listed: (n: number) => `${plural(n, "upcoming event")} ${n === 1 ? "is" : "are"} listed.`,
    notAnnounced: "Dates for the next edition have not been announced yet.",
    description: (name: string) => `${name}: dates, venues and past editions, each with its source.`,
    upcoming: "Upcoming", noDates: "No upcoming dates are listed yet.", past: "Past editions",
  },
  search: {
    title: (city: string) => `Search events in ${city}`,
    description: (city: string) => `Find events in ${city} by date, category, area and price.`,
    from: "From", until: "Until", category: "Category", area: "Area", price: "Price", any: "Any", free: "Free", paid: "Paid",
    submit: "Show events",
    inArea: (area: string) => `in ${area}`, fromDay: (day: string) => `from ${day}`, untilDay: (day: string) => `until ${day}`,
    freeEntry: "free entry", paidEntry: "paid entry",
    status: (n: number, applied: string[], city: string) =>
      `${plural(n, "event")} ${n === 1 ? "matches" : "match"}${applied.length ? `: ${applied.join(", ")}.` : `: everything coming up in ${city}.`}`,
    empty: "No listed events match these filters. Try a wider date range or fewer filters.",
  },
  notFound: {
    title: "This page is not here",
    lead: "The page may have moved, or the address may be mistyped.",
    button: "See what is on",
  },
};

export type Messages = typeof en;
