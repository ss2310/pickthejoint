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
/** How a plain-words search was read, ready to be put into a sentence. Dates are already written out. */
export interface Understood {
  category?: string;
  when?: { kind: "today" | "tonight" | "tomorrow" | "day" | "range"; from: string; to: string };
  area?: string;
  price?: "free" | "paid";
  words?: string[];
  /** The words are leftovers the search did not understand: any of them may match. */
  anyWords?: boolean;
}

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
    paused: (name: string) => `${name} is paused. Listings are not being updated, so check the date and details with the organiser before you go.`,
    footerVerify: "How we collect and verify events",
    footerCorrections: "Corrections and takedown",
    footerChangelog: "Changelog",
    footerCitations: "Do AI assistants cite us?",
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
    sourcePoster: "Submitted poster",
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
    updates: "Latest releases",
    updatesNote: "Dated notes on new work, written by us from the artist's own announcements. Each links to the original post.",
    updateLink: "Original post on Instagram",
    videos: "Official videos",
    videosNote: (name: string) => `Videos from ${name}'s official YouTube channel, played with YouTube's own player. The text beside each one says what it is.`,
    watchOnYoutube: "Watch on YouTube",
    videoBy: (channel: string) => `from the official channel ${channel}`,
    byCity: "Shows by city",
    byCityNote: (name: string) => `Every event with ${name} that we have listed, city by city, with its venue and date.`,
    inCity: (city: string) => `In ${city}`,
    upcomingTag: "upcoming", pastTag: "past", cancelledTag: "cancelled",
    getToKnow: (name: string) => `Get to know ${name}`,
    morePage: (name: string) => `More about ${name}: shows, releases and videos`,
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
    askLabel: "Search in your own words",
    askPlaceholder: "e.g. comedy this Saturday, or free events today",
    askButton: "Search",
    askHint: "English, Hindi or Hinglish: “standup this weekend”, “aaj kya hai”, “इस शनिवार संगीत”.",
    filtersHeading: "Or choose filters",
    understood(u: Understood): string {
      const quote = (w: string[]) => w.map((x) => `“${x}”`).join(u.anyWords ? " or " : " ");
      const noun = u.category ? `${u.category.toLowerCase()}${/events?$/i.test(u.category) ? "" : " events"}` : "events";
      const when = u.when && ({
        today: "today", tonight: "tonight", tomorrow: `tomorrow (${u.when.from})`, day: `on ${u.when.from}`, range: `from ${u.when.from} to ${u.when.to}`,
      })[u.when.kind];
      const parts = [noun, when, u.area && `in ${u.area}`, u.price === "free" ? "with free entry" : u.price === "paid" ? "with paid entry" : "",
        u.words?.length ? `mentioning ${u.anyWords ? "any of " : ""}${quote(u.words)}` : ""].filter(Boolean);
      const nothing = !u.category && !u.when && !u.area && !u.price && !u.words?.length;
      return nothing ? "We could not pick out a date, category or place, so here is everything coming up."
        : `We read this as: ${parts.join(" ")}.`;
    },
    relaxed: (words: string[]) => `No listed event mentions ${words.map((w) => `“${w}”`).join(" ")}, so these match the rest of your search.`,
    found: (n: number) => `${plural(n, "event")} ${n === 1 ? "matches" : "match"}.`,
  },
  proof: {
    title: "Do AI assistants cite Pick the Joint?",
    description: "Week by week: how often ChatGPT, Gemini, Perplexity and Google AI Overviews cite pickthejoint.com when asked what is on in Indore, with AI crawler visits and the number of live listings.",
    lead: "Pick the Joint is a public test of one idea: that a complete, current and honest events listing will be the source AI assistants cite when people ask what is on in their city. Every week we ask the same questions and publish what happened, including the weeks we were not cited.",
    citedHeading: "How often we were cited",
    citedNote: "Each figure is the number of answers that listed a pickthejoint.com page among their sources, out of the questions that engine answered that week.",
    allEngines: "All engines",
    weekOf: "Week of",
    baseline: "baseline",
    of: (n: number, d: number) => `${n} of ${d}`,
    siteHeading: "AI crawlers and live listings",
    crawlerVisits: "AI crawler visits",
    liveEvents: "Upcoming events listed",
    venues: "Venues",
    artists: "Artists",
    noData: "The first week has not been recorded yet.",
    methodHeading: "How we measure",
    method: (questions: number) => [
      `The same ${questions} questions, in English and Hindi, are asked every week. They do not change, so one week can be compared with the next.`,
      "ChatGPT, Gemini and Perplexity are asked through their programming interfaces with web search switched on. Google AI Overviews are read from a live Google search for the same question. These are not the consumer apps, which tailor answers to the person asking, so your own results may differ.",
      "An answer counts as citing us when a pickthejoint.com page is among the sources it lists. When an engine gives no answer (for example, Google shows no AI Overview for a search), that check is left out rather than counted as a miss.",
      "AI crawler visits are requests to our pages from the AI companies' published crawlers, counted from our own logs. Listings are counted at the end of each week. Weeks run Monday to Sunday, India time.",
    ],
    questionsHeading: "The questions",
    updated: "Updated",
  },
  notFound: {
    title: "This page is not here",
    lead: "The page may have moved, or the address may be mistyped.",
    button: "See what is on",
  },
  submit: {
    nav: "Add an event",
    title: "Add an event",
    metaDescription: "Send us an event for the listings: a gig, a workshop, a college fest, a puja or a free meet-up. A person checks every submission before it appears.",
    lead: "Running an event, or seen a poster for one? Send us the details. A person checks every submission before it appears, listing is free, and we link to your own booking page.",
    posterHeading: "Snap a poster",
    posterLead: "Have a photo of a street poster, a notice-board flyer or a poster forwarded on WhatsApp? Upload it and we will fill in the form from it for you to check.",
    posterFile: "Poster photo",
    posterFileHint: "JPEG, PNG or WebP, up to 8 MB.",
    posterNote: "Anything to add (optional)",
    posterButton: "Read the poster",
    posterPrivacy: "The photo is kept privately for our review only. It is never shown on the site, its location data is removed when it is uploaded, and it is deleted after the event.",
    formHeading: "Event details",
    formLead: "Fields marked * are needed.",
    city: "City", eventTitle: "Name of the event", date: "Date", startTime: "Start time", endDate: "Last day (if more than one day)", endTime: "End time",
    venue: "Venue", venueAddress: "Venue address", area: "Area", category: "Category", price: "Price", isFree: "Entry is free",
    bookingUrl: "Booking or registration link", instagramUrl: "Instagram post about the event", performers: "Performers or speakers",
    organiser: "Organiser", note: "Anything else we should know (not published)",
    timeHint: "Leave empty if it has not been announced.", performersHint: "Separate names with commas.",
    bookingHint: "The official page where people book or register.", instagramHint: "A link to the event's own post, if there is one.",
    priceHint: "As the organiser states it, for example \"₹499 onwards\".",
    aboutYou: "About you", aboutYouNote: "Not shown on the site. We use it only if we need to check a detail.",
    name: "Your name", contact: "Email or phone number",
    choose: "Choose…",
    send: "Send for review",
    captchaNote: "The check below keeps out spam. It needs JavaScript; if it does not appear, email the details to us instead.",
    errorSummary: "Please correct the marked fields and send again.",
    errors: {
      required: "This is needed.", badDate: "Enter a valid date.", pastDate: "This date has already passed.",
      farDate: "We list events up to a year ahead.", badTime: "Enter a time such as 19:30.", endBeforeStart: "The last day is before the first.",
      badUrl: "Enter a full link starting with https://", badInstagram: "Enter a link to an Instagram post (instagram.com/p/...).",
      badCategory: "Choose a category from the list.", badContact: "Enter an email address or a phone number.",
      noFacts: "Fill in at least one detail.", captcha: "The spam check did not pass. Please try again.", tooMany: "Too many submissions from this connection. Please try again later.",
    } as Record<string, string>,
    posterRead: "We read the poster and filled in what we could. Please check every field before sending.",
    posterUnsure: (fields: string[]) => `Please check these closely, we were not sure of them: ${fields.join(", ")}.`,
    posterMany: (n: number) => `This poster lists ${n} events. The form has the first one; please send the others separately.`,
    posterNone: "We could not find event details in that photo. You can fill in the form yourself.",
    posterFailed: "We could not read that photo just now. You can fill in the form yourself.",
    posterPaused: "Reading posters is paused for now. Please fill in the form yourself.",
    posterAttached: "Your poster photo is attached for our review (kept privately).",
    uploadErrors: {
      empty: "Choose a photo to upload.", tooBig: "That photo is larger than 8 MB.",
      badType: "Please upload a JPEG, PNG or WebP photo.", unreadable: "That file could not be opened as a photo.",
      captcha: "The spam check did not pass. Please try again.", tooMany: "You have sent several posters today. Please fill in the form instead.",
    } as Record<string, string>,
    thanksTitle: "Thank you",
    thanksLead: "Your event has been sent for review. We check every submission by hand before it appears on the site. If we need to confirm a detail, we will contact you.",
    thanksAgain: "Add another event",
    thanksBack: (city: string) => `See what is on in ${city}`,
  },
  /** Practical facts on event pages, and the form for adding them (Prompt 11). */
  practical: {
    heading: "Before you go",
    note: "Only questions a source answers are listed here; each answer says where it came from.",
    q: {
      start: (t: string) => `What time does ${t} start?`,
      doors_time: (t: string) => `When do the doors open for ${t}?`,
      end: (t: string) => `What time does ${t} end?`,
      age_limit: (t: string) => `Is there an age limit for ${t}?`,
      entry_rules: (t: string) => `What are the entry rules for ${t}?`,
      seating: (t: string) => `Is ${t} seated or standing?`,
      indoor_outdoor: (t: string) => `Is ${t} indoors or outdoors?`,
      language: (t: string) => `What language is ${t} in?`,
      food_drink: (t: string) => `Is food and drink available at ${t}?`,
      dress_code: (t: string) => `Is there a dress code for ${t}?`,
      refund_policy: (t: string) => `Can tickets for ${t} be refunded or cancelled?`,
      accessibility: (v: string) => `Is ${v} accessible for wheelchair users?`,
      parking: (v: string) => `Is there parking at ${v}?`,
      how_to_reach: (v: string) => `How do I get to ${v}?`,
    },
    startAnswer: (time: string, day: string) => `It starts at ${time} on ${day}.`,
    doorsAnswer: (time: string) => `Doors open at ${time}.`,
    endAnswer: (time: string) => `It is expected to end at ${time}.`,
    sourceLabel: "Source",
    fromListing: "the event's sources listed below",
    fromPost: (host: string) => (host.includes("instagram") ? "Instagram post" : host.includes("facebook") ? "Facebook post" : host),
    fromOrganiser: "sent in by the organiser and checked by us",
    fromAdmin: "checked by Pick the Joint",
    addOrCorrect: "Organising this event? Add or correct these details",
    // The form
    formHeading: "Practical details (optional)",
    formLead: "Only what is true for this event. Leave anything you are not sure of empty.",
    labels: {
      doors_time: "Doors open at", age_limit: "Age limit", entry_rules: "Entry rules", seating: "Seated or standing",
      indoor_outdoor: "Indoors or outdoors", language: "Language of the performance", food_drink: "Food and drink",
      dress_code: "Dress code", refund_policy: "Refund or cancellation terms", accessibility: "Wheelchair access",
      parking: "Parking", how_to_reach: "How to reach the venue",
    } as Record<string, string>,
    hints: {
      age_limit: "For example: 18+ only, or children under 5 free", entry_rules: "For example: ID needed, entry closes at 9 PM",
      seating: "For example: seated, standing, floor seating", indoor_outdoor: "Indoors, outdoors or both",
      food_drink: "For example: food stalls inside, no outside food", parking: "For example: free parking in the basement",
    } as Record<string, string>,
    forHeading: (title: string) => `Practical details for ${title}`,
    forLead: "Add or correct the details people ask before going. A person checks them before they appear on the event page.",
    forNotFound: "That event is not listed, so details cannot be added to it.",
    forEvent: "Event",
  },
  /** The weekly roundup per city (Prompt 11). */
  guide: {
    kicker: "Weekly guide",
    indexTitle: (city: string) => `${city} weekly guides: what is on each week`,
    indexHeading: (city: string) => `${city} weekly guides`,
    indexDescription: (city: string) => `Every Thursday, a plain guide to what is on in ${city} over the weekend and the week ahead, with dates, venues and prices.`,
    none: "No guide has been published yet.",
    period: (from: string, to: string) => `${from} to ${to}`,
    published: "Published",
    inThis: "In this guide",
    free: "Free this weekend",
    families: "For families",
    other: "More events",
    method: "Written by Pick the Joint from our listings. Each event links to its own page, which names its source and when it was last checked. Times and prices can change, so check the event page before you go.",
    latest: (city: string) => `This week's guide to ${city}`,
    all: "All weekly guides",
    count: (n: number) => plural(n, "event"),
  },
};

export type Messages = typeof en;
