/**
 * Natural-language search (Prompt 7). A query such as "comedy show this
 * Saturday near Vijay Nagar" or "aaj Indore mein kya hai" becomes the same
 * filters the plain search page uses: city, dates, category, area, free or
 * paid, and search words.
 *
 *   1. Rules first: date words, category and area names, prices and filler
 *      words in English, Hindi and Hinglish. Most queries end here, free.
 *   2. Then the cache of queries the model has already read.
 *   3. Then one fast-tier model call, which sees only the query and the list
 *      of valid filter values, and answers only with filter values (never
 *      prose). Search words it returns must be words of the query.
 *   4. When the model may not be asked (per-address limit, daily or monthly
 *      cap, a crawler, an error), the search quietly falls back to what the
 *      rules understood plus the remaining words as search words.
 * Every query is logged in search_log with how it was read and how many
 * events it found; nothing about the visitor is stored there.
 */
import { z } from "zod";
import type { Pool } from "pg";
import { search as cfg, type Locale } from "../config";
import { BudgetExceededError } from "./budget-guard";
import { getPool } from "./db";
import { addDays, isoDay, weekdayOf } from "./format";
import { messages } from "./locale";
import type { LlmClient, LlmRequest } from "./pipeline/llm";
import { listEvents, type City, type EventCard, type EventFilter } from "./queries";
import { rateAllow } from "./security";

/** Bump when the rules or the model's instructions change: older cached answers are then ignored. */
export const PARSER_VERSION = 2;

export const WHEN = [
  "today", "tonight", "tomorrow", "day_after_tomorrow", "this_weekend", "next_weekend", "this_week", "next_week",
  "this_month", "next_month", "weekday", "next_weekday", "date",
] as const;
export type WhenKind = (typeof WHEN)[number];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/**
 * What a query asks for. Dates stay relative ("this saturday", "12-25") so a
 * cached reading is still right on another day; they become calendar dates
 * only in `resolveDates`.
 */
export interface ParsedQuery {
  when?: WhenKind;
  /** 0 = Sunday ... 6 = Saturday, with when "weekday" or "next_weekday". */
  weekday?: number;
  /** "MM-DD", with when "date". */
  dateFrom?: string;
  dateTo?: string;
  category?: string;
  area?: string;
  city?: string;
  price?: "free" | "paid";
  /** Folded search words. */
  keywords: string[];
}

export type ParseMethod = "rules" | "cache" | "model" | "keyword_fallback";

export interface Understanding {
  normalized: string;
  parsed: ParsedQuery;
  method: ParseMethod;
  /** Why the model was not used, for keyword_fallback. */
  reason?: "rate_limit" | "budget" | "crawler" | "error";
  /** "any" when the words are leftovers nobody understood. */
  keywordMode: "all" | "any";
  costUsd: number;
}

// ---------------------------------------------------------------- text

/**
 * The form a query is compared in: lower case, no apostrophes, nuktas and
 * chandrabindus folded (people type फ्री and फ़्री alike), anything that is
 * not a letter, mark or digit turned into a single space.
 */
export function foldText(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/['‘’`´]/g, "")
    .replace(/़/g, "")
    .replace(/ँ/g, "ं")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

// ---------------------------------------------------------------- vocabulary

type Tag =
  | { t: "when"; when: WhenKind }
  | { t: "weekday"; day: number; next: boolean }
  | { t: "month"; month: number }
  | { t: "category"; slug: string }
  | { t: "area"; slug: string }
  | { t: "city"; slug: string }
  | { t: "price"; price: "free" | "paid" }
  | { t: "stop" };

const WHEN_WORDS: Record<Exclude<WhenKind, "weekday" | "next_weekday" | "date">, string[]> = {
  today: ["today", "todays", "aaj", "aj", "abhi", "now", "right now", "आज", "अभी"],
  tonight: ["tonight", "tonite", "this evening", "today night", "today evening", "aaj raat", "aaj rat", "aj raat", "aaj shaam", "aaj sham",
    "आज रात", "आज शाम"],
  tomorrow: ["tomorrow", "tmrw", "tmr", "tomorow", "tommorow", "kal", "kal raat", "kal shaam", "tomorrow night", "tomorrow evening", "कल", "कल रात", "कल शाम"],
  day_after_tomorrow: ["day after tomorrow", "parso", "parson", "parsoon", "परसों", "परसो"],
  this_weekend: ["weekend", "this weekend", "the weekend", "is weekend", "iss weekend", "weekend pe", "sat sun", "saturday sunday", "saturday and sunday",
    "shanivar ravivar", "वीकेंड", "इस वीकेंड", "सप्ताहांत", "इस सप्ताहांत", "शनिवार रविवार"],
  next_weekend: ["next weekend", "agle weekend", "अगले वीकेंड", "अगले सप्ताहांत"],
  this_week: ["this week", "is week", "iss week", "is hafte", "iss hafte", "is hafta", "is saptah", "इस हफ्ते", "इस हफ़्ते", "इस सप्ताह"],
  next_week: ["next week", "agle hafte", "agle week", "agle saptah", "अगले हफ्ते", "अगले हफ़्ते", "अगले सप्ताह"],
  this_month: ["this month", "is month", "is mahine", "iss mahine", "इस महीने", "इस माह"],
  next_month: ["next month", "agle month", "agle mahine", "अगले महीने", "अगले माह"],
};

const WEEKDAY_WORDS: string[][] = [
  ["sunday", "sun", "ravivar", "raviwar", "itwar", "itvaar", "etwar", "रविवार", "इतवार"],
  ["monday", "mon", "somvar", "somwar", "somvaar", "सोमवार"],
  ["tuesday", "tue", "tues", "mangalvar", "mangalwar", "mangal", "मंगलवार"],
  ["wednesday", "wed", "budhvar", "budhwar", "budh", "बुधवार"],
  ["thursday", "thu", "thur", "thurs", "guruvar", "guruwar", "veervar", "brihaspativar", "गुरुवार", "बृहस्पतिवार", "वीरवार"],
  ["friday", "fri", "shukravar", "shukrawar", "shukrvar", "शुक्रवार"],
  ["saturday", "sat", "shanivar", "shaniwar", "shanivaar", "shani", "शनिवार"],
];

const MONTH_WORDS: string[][] = [
  ["january", "jan", "जनवरी"], ["february", "feb", "फरवरी", "फ़रवरी"], ["march", "मार्च"], ["april", "apr", "अप्रैल"], ["may", "मई"],
  ["june", "jun", "जून"], ["july", "jul", "जुलाई"], ["august", "aug", "अगस्त"], ["september", "sep", "sept", "सितंबर", "सितम्बर"],
  ["october", "oct", "अक्टूबर", "अक्तूबर"], ["november", "nov", "नवंबर", "नवम्बर"], ["december", "dec", "दिसंबर", "दिसम्बर"],
];

/** Words that name a category, beyond the category's own name in English and Hindi. */
const CATEGORY_WORDS: Record<string, string[]> = {
  music: ["music", "musical", "gig", "gigs", "concert", "concerts", "live music", "band", "bands", "singing", "sangeet", "sangit", "gaana", "gaane",
    "संगीत", "म्यूजिक", "कॉन्सर्ट", "गाना", "गाने"],
  comedy: ["comedy", "comedies", "comedian", "comedians", "standup", "stand up", "standup comedy", "stand up comedy", "comic", "hasya", "हास्य",
    "कॉमेडी", "कामेडी"],
  theatre: ["theatre", "theater", "theatres", "theaters", "play", "plays", "drama", "natak", "naatak", "nukkad natak", "rangmanch", "नाटक", "थिएटर",
    "थियेटर", "रंगमंच"],
  dance: ["dance", "dances", "dancing", "nritya", "नृत्य", "डांस"],
  workshops: ["workshop", "workshops", "class", "classes", "masterclass", "masterclasses", "course", "training", "karyashala", "कार्यशाला", "वर्कशॉप"],
  kids: ["kids", "kid", "children", "child", "family", "for kids", "bachche", "bachon", "bachchon", "bacchon", "bachho", "bachhon", "baccho", "bacho",
    "बच्चे", "बच्चों", "बच्चों के लिए"],
  food: ["food", "foodie", "food festival", "food fest", "khana", "khaana", "khane", "खाना", "खाने", "खाना पीना"],
  festivals: ["festival", "festivals", "fest", "mela", "melas", "utsav", "उत्सव", "मेला", "फेस्टिवल"],
  "religious-and-cultural": ["religious", "cultural", "spiritual", "bhajan", "bhajans", "kirtan", "satsang", "katha", "pravachan", "puja", "pooja",
    "aarti", "jagran", "भजन", "कीर्तन", "सत्संग", "कथा", "प्रवचन", "पूजा", "आरती", "जागरण", "धार्मिक", "सांस्कृतिक"],
  "sports-and-fitness": ["sports", "sport", "fitness", "yoga", "run", "running", "marathon", "cycling", "cricket", "football", "zumba", "khel",
    "खेल", "योग", "फिटनेस", "मैराथन"],
  exhibitions: ["exhibition", "exhibitions", "expo", "exhibit", "art show", "art exhibition", "pradarshani", "प्रदर्शनी", "एग्जिबिशन"],
  "college-events": ["college", "colleges", "campus", "university", "college fest", "college festival", "कॉलेज"],
  "business-and-networking": ["business", "networking", "startup", "startups", "conference", "summit", "seminar", "meetup", "meetups",
    "entrepreneurs", "बिजनेस", "नेटवर्किंग"],
  nightlife: ["nightlife", "night life", "party", "parties", "club", "clubbing", "pub", "bar", "dj", "पार्टी", "नाइटलाइफ", "क्लब"],
};

const PRICE_WORDS: Record<"free" | "paid", string[]> = {
  free: ["free", "free entry", "entry free", "free of cost", "no entry fee", "no ticket", "without ticket", "bina ticket", "muft", "mufat", "nishulk",
    "मुफ्त", "फ्री", "निःशुल्क", "निशुल्क", "फ्री एंट्री"],
  paid: ["paid", "ticketed", "paid entry", "with ticket", "टिकट वाले"],
};

/** Filler in the three ways people type. They carry no filter and are not search words. */
const STOP_WORDS = `a an the and or of for to in on at by with from into near nearby around close me my i we us you your any some something
anything everything what whats which where when who is are was be been there here this that these those it its event events show shows
happening happen going go goin do doing things thing stuff fun good best nice cool great interesting top find search looking look want wanna
need please plz pls tell let know list all upcoming new latest city town place places spot spots hangout hang out plan plans program programme
programs programmes evening morning afternoon night late can could should will would get got have has am live ticket tickets booking book
maybe perhaps like just also kind type sort really very more other etc someone anyone people friends
jo cheap cheaper budget affordable under below less than within sasta sasti saste kam se kam rupees rs inr
near me close by around me whats on going on something to do things to do
kya hai hain ha he h mein me main mai mei ka ki ke ko se par pe paas pas koi kuch kahan kaha kidhar kab kaun kon hoga hogi honge ho raha rahi
rahe chal chalo chalna chalein jaana jana dekhne dekhna dekho dikhao batao bataiye bata accha acha achha achchha badhiya badiya mast maza
mazedaar wala wali wale liye lie aur ya bhi hi toh jagah jagha shahar sheher shehar sab saare sare kaunsa konsa karyakram shaam sham raat rat
subah din mere aas aaspaas ke paas mere paas ho raha hai kya chal raha hai
क्या है हैं में मे के की का को से पर पे पास कोई कुछ कहाँ कहां कब कौन होगा होगी होंगे हो रहा रही रहे चल चलो देखने देखना दिखाओ बताओ बताइए अच्छा
बढ़िया मस्त वाला वाली वाले लिए और या भी ही तो जगह शहर इवेंट इवेंट्स शो कार्यक्रम प्रोग्राम आयोजन शाम रात सुबह दिन सारे सब मेरे आसपास नज़दीक
नजदीक`;

export interface Vocabulary {
  city: City;
  /** Live cities, with Hindi names where translated. */
  cities: { slug: string; name: string; hi: string | null }[];
  categories: { slug: string; name: string }[];
  /** Areas of the page's city. */
  areas: { slug: string; name: string; hi: string | null }[];
}

export async function loadVocabulary(pool: Pool, city: City): Promise<Vocabulary> {
  const hi = (type: string, alias: string, column: string) => `(SELECT tx.text FROM translations tx WHERE tx.entity_type = '${type}'
    AND tx.entity_id = ${alias}.id AND tx.locale = 'hi' AND tx.field = '${column}' AND tx.source_hash = md5(${alias}.${column}))`;
  const [cities, categories, areas] = await Promise.all([
    pool.query<{ slug: string; name: string; hi: string | null }>(`SELECT c.slug, c.name, ${hi("city", "c", "name")} AS hi FROM cities c WHERE c.is_live ORDER BY c.name`),
    pool.query<{ slug: string; name: string }>("SELECT slug, name FROM categories ORDER BY sort_order"),
    pool.query<{ slug: string; name: string; hi: string | null }>(`SELECT a.slug, a.name, ${hi("area", "a", "name")} AS hi FROM areas a WHERE a.city_id = $1 ORDER BY a.name`, [city.id]),
  ]);
  return { city, cities: cities.rows, categories: categories.rows, areas: areas.rows };
}

/** Spellings of a place name: as written, without "No." (Scheme 54), and run together (vijaynagar). */
function placeVariants(name: string): string[] {
  const f = foldText(name);
  const noNo = f.replace(/\bno\b /g, "");
  return [...new Set([f, noNo, f.replace(/ /g, ""), noNo.replace(/ /g, "")])].filter(Boolean);
}

const MAX_PHRASE = 5;
const dictionaryCache = new Map<string, { at: number; dict: Map<string, Tag> }>();

function buildDictionary(v: Vocabulary): Map<string, Tag> {
  const key = JSON.stringify([v.city.slug, v.cities, v.categories, v.areas]);
  const hit = dictionaryCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.dict;

  const dict = new Map<string, Tag>();
  // Later entries win, so the more specific kinds go last.
  const put = (phrase: string, tag: Tag) => { const k = foldText(phrase); if (k) dict.set(k, tag); };
  for (const w of STOP_WORDS.split(/\n/).map((l) => l.trim()).filter(Boolean)) {
    // Each line holds single words, then a few multi-word fillers at its end ("near me").
    for (const word of w.split(" ")) put(word, { t: "stop" });
  }
  for (const phrase of ["near me", "close by", "around me", "whats on", "going on", "something to do", "things to do", "ke paas", "mere paas",
    "ho raha hai", "kya chal raha hai", "kya hai", "के पास", "मेरे पास", "हो रहा है", "क्या चल रहा है"]) put(phrase, { t: "stop" });
  for (const [when, words] of Object.entries(WHEN_WORDS)) for (const w of words) put(w, { t: "when", when: when as WhenKind });
  WEEKDAY_WORDS.forEach((words, day) => {
    for (const w of words) {
      put(w, { t: "weekday", day, next: false });
      for (const pre of ["this", "coming", "this coming", "on", "is", "iss", "इस", "आने वाले"]) put(`${pre} ${w}`, { t: "weekday", day, next: false });
      for (const pre of ["next", "agle", "अगले"]) put(`${pre} ${w}`, { t: "weekday", day, next: true });
    }
  });
  MONTH_WORDS.forEach((words, i) => { for (const w of words) put(w, { t: "month", month: i + 1 }); });
  for (const c of v.categories) {
    put(c.name, { t: "category", slug: c.slug });
    put(c.slug.replace(/-/g, " "), { t: "category", slug: c.slug });
    const hiName = messages("hi").common.categories[c.slug];
    if (hiName) put(hiName, { t: "category", slug: c.slug });
    for (const w of CATEGORY_WORDS[c.slug] ?? []) put(w, { t: "category", slug: c.slug });
  }
  for (const [price, words] of Object.entries(PRICE_WORDS)) for (const w of words) put(w, { t: "price", price: price as "free" | "paid" });
  for (const c of v.cities) for (const n of [c.name, c.hi]) if (n) for (const p of placeVariants(n)) put(p, { t: "city", slug: c.slug });
  for (const a of v.areas) for (const n of [a.name, a.hi]) if (n) for (const p of placeVariants(n)) put(p, { t: "area", slug: a.slug });

  dictionaryCache.set(key, { at: Date.now(), dict });
  if (dictionaryCache.size > 20) dictionaryCache.delete(dictionaryCache.keys().next().value!);
  return dict;
}

// ---------------------------------------------------------------- rules

export interface RuleParse {
  parsed: ParsedQuery;
  /** Words no rule recognised. */
  leftovers: string[];
  /** True when the rules read the whole query and the model need not be asked. */
  resolved: boolean;
  /** Filters the rules found exactly one value for, even when the query as a whole needs the model. */
  certain: Partial<ParsedQuery>;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const validMonthDay = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= DAYS_IN_MONTH[m - 1];

export function parseByRules(query: string, v: Vocabulary): RuleParse {
  const dict = buildDictionary(v);
  const dates: string[][] = [];
  // Numeric dates, day first as written in India: 25/12, 25-12-2026, 5.1.
  const text = query.replace(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?\b/g, (all, d: string, m: string) => {
    if (!validMonthDay(Number(m), Number(d))) return all;
    dates.push([`${pad(Number(m))}-${pad(Number(d))}`]);
    return " ";
  });
  const tokens = foldText(text).split(" ").filter(Boolean);

  type Item = { tag: Tag } | { word: string };
  const items: Item[] = [];
  for (let i = 0; i < tokens.length;) {
    let matched = false;
    for (let n = Math.min(MAX_PHRASE, tokens.length - i); n >= 1; n--) {
      const phrase = tokens.slice(i, i + n);
      const tag = dict.get(phrase.join(" ")) ?? (n > 1 ? dict.get(phrase.join("")) : undefined);
      // A run-together spelling only counts for places ("vijay nagar" typed as two words that the dictionary holds as one).
      if (tag && (dict.has(phrase.join(" ")) || tag.t === "area" || tag.t === "city")) {
        items.push({ tag });
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) { items.push({ word: tokens[i] }); i++; }
  }

  // A month next to a day number is a date: "25 december", "dec 25th", "25th of december".
  const dayNumber = (it: Item | undefined) => {
    const m = it && "word" in it ? it.word.match(/^(\d{1,2})(st|nd|rd|th)?$/) : null;
    return m ? Number(m[1]) : null;
  };
  const isStop = (it: Item | undefined) => !!it && "tag" in it && it.tag.t === "stop";
  const used = new Set<number>();
  const months: { month: number; day: number | null }[] = [];
  items.forEach((it, i) => {
    if (!("tag" in it) || it.tag.t !== "month") return;
    const month = it.tag.month;
    const beforeAt = dayNumber(items[i - 1]) !== null ? i - 1 : isStop(items[i - 1]) && dayNumber(items[i - 2]) !== null ? i - 2 : -1;
    const before = beforeAt >= 0 ? dayNumber(items[beforeAt]) : null;
    const after = dayNumber(items[i + 1]);
    if (before !== null && validMonthDay(month, before)) {
      used.add(beforeAt);
      months.push({ month, day: before });
    } else if (after !== null && validMonthDay(month, after)) {
      used.add(i + 1);
      months.push({ month, day: after });
    } else months.push({ month, day: null });
  });

  const parsed: ParsedQuery = { keywords: [] };
  const seen = { when: new Set<string>(), category: new Set<string>(), area: new Set<string>(), city: new Set<string>(), price: new Set<string>() };
  const leftovers: string[] = [];
  items.forEach((it, i) => {
    if (used.has(i)) return;
    if ("word" in it) { leftovers.push(it.word); return; }
    const tag = it.tag;
    switch (tag.t) {
      case "stop": break;
      case "when": seen.when.add(tag.when); parsed.when = tag.when; break;
      case "weekday":
        seen.when.add(`weekday:${tag.day}:${tag.next}`);
        parsed.when = tag.next ? "next_weekday" : "weekday";
        parsed.weekday = tag.day;
        break;
      case "month": break; // handled above
      case "category": seen.category.add(tag.slug); parsed.category = tag.slug; break;
      case "area": seen.area.add(tag.slug); parsed.area = tag.slug; break;
      case "city": seen.city.add(tag.slug); parsed.city = tag.slug; break;
      case "price": seen.price.add(tag.price); parsed.price = tag.price; break;
    }
  });
  for (const d of dates) seen.when.add(`date:${d[0]}`);
  for (const m of months) seen.when.add(`month:${m.month}:${m.day}`);
  if (dates.length === 1 && seen.when.size === 1) { parsed.when = "date"; parsed.dateFrom = dates[0][0]; }
  if (months.length === 1 && seen.when.size === 1) {
    const { month, day } = months[0];
    parsed.when = "date";
    parsed.dateFrom = `${pad(month)}-${pad(day ?? 1)}`;
    parsed.dateTo = `${pad(month)}-${pad(day ?? DAYS_IN_MONTH[month - 1])}`;
  }

  // "tonight" and "today" together, or "this weekend on saturday", are one meaning or two; let the model decide.
  const whenConflict = seen.when.size > 1 && !(seen.when.size === 2 && seen.when.has("today") && seen.when.has("tonight"));
  if (seen.when.has("tonight")) parsed.when = "tonight";
  const conflict = whenConflict || seen.category.size > 1 || seen.area.size > 1 || seen.city.size > 1 || seen.price.size > 1;
  const plainWords = leftovers.length <= cfg.maxRuleKeywords && leftovers.every((w) => w.length > 1 && !/\d/.test(w));
  const resolved = !conflict && (leftovers.length === 0 || plainWords);
  if (resolved) parsed.keywords = leftovers;
  const certain: Partial<ParsedQuery> = {};
  if (!whenConflict && parsed.when) Object.assign(certain, { when: parsed.when, weekday: parsed.weekday, dateFrom: parsed.dateFrom, dateTo: parsed.dateTo });
  if (seen.category.size === 1) certain.category = parsed.category;
  if (seen.area.size === 1) certain.area = parsed.area;
  if (seen.city.size === 1) certain.city = parsed.city;
  if (seen.price.size === 1) certain.price = parsed.price;
  return { parsed, leftovers, resolved, certain };
}

// ---------------------------------------------------------------- model

const ModelSchema = (v: Vocabulary) =>
  z.object({
    when: z.enum(WHEN).nullable(),
    weekday: z.enum(WEEKDAYS).nullable(),
    date_from: z.string().nullable(),
    date_to: z.string().nullable(),
    category: z.enum(v.categories.map((c) => c.slug) as [string, ...string[]]).nullable(),
    area: v.areas.length ? z.enum(v.areas.map((a) => a.slug) as [string, ...string[]]).nullable() : z.null(),
    city: z.enum(v.cities.map((c) => c.slug) as [string, ...string[]]).nullable(),
    price: z.enum(["free", "paid"]).nullable(),
    keywords: z.array(z.string()),
  });
type ModelAnswer = z.infer<ReturnType<typeof ModelSchema>>;

function modelSystem(v: Vocabulary): string {
  const named = (x: { slug: string; name: string; hi?: string | null }) => `${x.slug} (${x.name}${x.hi && x.hi !== x.name ? `, ${x.hi}` : ""})`;
  return `You turn a search typed on an events listing site for Indian cities into search filters. The search may be in English, Hindi (Devanagari) or Hinglish (Hindi written in Latin letters), and may be misspelt.
Answer only with the filters. Use only the values listed below, and null for anything the search does not ask for. Never add a filter the search does not ask for.
- when: today, tonight, tomorrow, day_after_tomorrow, this_weekend, next_weekend, this_week, next_week, this_month, next_month; or weekday / next_weekday with weekday set ("this saturday" and "on sunday evening" are weekday, "next saturday" is next_weekday); or date, with date_from (and date_to for a range) written MM-DD, with no year. Set it whenever the search names a day or a time span, even in passing.
- category: one of the category slugs below.
- area: one of the area slugs below, only when the search names that locality or a recognisable spelling of it. If the place could be more than one area (for example "Palasia" for both Old Palasia and New Palasia), use null and put the place word in keywords instead.
- city: one of the city slugs below, only when the search names it.
- price: free only when the search asks for free entry; paid only when it asks for ticketed or paid events. A wish for something cheap or under an amount is neither: use null.
- keywords: at most 4 words copied exactly from the search that name a particular performer, venue, organiser, genre or kind of event that the filters above do not cover. Leave out filler words, dates, times, places, numbers, amounts, words about price or quality (cheap, sasta, best, achha) and words that only name a category.

Categories: ${v.categories.map(named).join("; ")}
Areas of ${v.city.name}: ${v.areas.map(named).join("; ") || "(none)"}
Cities: ${v.cities.map(named).join("; ")}`;
}

/** Keeps only search words that are really in the query, folded, and not filler or a word the filters already cover. */
function cleanKeywords(words: string[], normalized: string, v: Vocabulary): string[] {
  const dict = buildDictionary(v);
  const inQuery = new Set(normalized.split(" "));
  const out: string[] = [];
  for (const w of words) {
    for (const token of foldText(w).split(" ")) {
      if (token.length > 1 && !/^\d+$/.test(token) && inQuery.has(token) && !dict.has(token) && !out.includes(token)) out.push(token);
    }
  }
  return out.slice(0, 4);
}

const isMonthDay = (s: string | null): s is string => !!s && /^\d{2}-\d{2}$/.test(s) && validMonthDay(Number(s.slice(0, 2)), Number(s.slice(3)));

export function fromModel(a: ModelAnswer, normalized: string, v: Vocabulary): ParsedQuery {
  const p: ParsedQuery = { keywords: cleanKeywords(a.keywords, normalized, v) };
  if (a.when === "weekday" || a.when === "next_weekday") {
    if (a.weekday) { p.when = a.when; p.weekday = WEEKDAYS.indexOf(a.weekday); }
  } else if (a.when === "date") {
    if (isMonthDay(a.date_from)) { p.when = "date"; p.dateFrom = a.date_from; if (isMonthDay(a.date_to)) p.dateTo = a.date_to; }
  } else if (a.when) p.when = a.when;
  if (a.category) p.category = a.category;
  if (a.area) p.area = a.area;
  if (a.city) p.city = a.city;
  if (a.price) p.price = a.price;
  return p;
}

function modelRequest(query: string, v: Vocabulary): LlmRequest<ModelAnswer> {
  return {
    id: "search-parse", tier: "fast", system: modelSystem(v), content: [{ type: "text", text: query }], schema: ModelSchema(v),
    maxTokens: 300, effort: "low", estInputTokens: cfg.estInputTokens, estOutputTokens: cfg.estOutputTokens,
  };
}

// ---------------------------------------------------------------- understanding

export interface UnderstandInput {
  query: string;
  vocab: Vocabulary;
  /** Hashed client address for the per-address limit; null skips the limit (tests, scripts). */
  who: string | null;
  /** False for crawlers: they get the rules and keyword search, never a model call. */
  allowModel: boolean;
  now?: Date;
}

export async function understand(pool: Pool, llm: LlmClient, input: UnderstandInput): Promise<Understanding> {
  const query = input.query.slice(0, cfg.maxQueryChars);
  const normalized = foldText(query);
  const rules = parseByRules(query, input.vocab);
  if (rules.resolved) return { normalized, parsed: rules.parsed, method: "rules", keywordMode: "all", costUsd: 0 };

  const cityId = input.vocab.city.id;
  const now = input.now ?? new Date();
  const cached = await pool.query<{ parsed: ParsedQuery }>(
    `UPDATE search_parse_cache SET hits = hits + 1, last_used_at = $4
     WHERE city_id = $1 AND normalized = $2 AND version = $3 AND created_at > $4::timestamptz - make_interval(days => $5) RETURNING parsed`,
    [cityId, normalized, PARSER_VERSION, now, cfg.cacheDays]);
  if (cached.rows[0]) return { normalized, parsed: cached.rows[0].parsed, method: "cache", keywordMode: "all", costUsd: 0 };

  // What the rules made of it, with every unrecognised word as an optional search word.
  const fallback = (reason: Understanding["reason"], costUsd = 0): Understanding => ({
    normalized, method: "keyword_fallback", reason, keywordMode: "any", costUsd,
    parsed: { ...rules.parsed, keywords: rules.leftovers.filter((w) => w.length > 2 && !/^\d+$/.test(w)).slice(0, 6) },
  });
  if (!input.allowModel) return fallback("crawler");
  if (input.who && !(await rateAllow(`search:${input.who}`, [cfg.limits.hour, cfg.limits.day], pool))) return fallback("rate_limit");

  let res;
  try {
    [res] = await llm.run([modelRequest(query, input.vocab)], { jobName: "search", subBudget: "search", pool });
  } catch (err) {
    if (err instanceof BudgetExceededError) return fallback("budget");
    console.error(`[search] model parse failed: ${(err as Error).message}`);
    return fallback("error");
  }
  if (!res?.ok || !res.data) {
    if (res) console.error(`[search] model parse failed: ${res.error}`);
    return fallback("error", res?.usd ?? 0);
  }
  // Where the model left a filter empty but the rules found exactly one value for it, the rules' value stands.
  const answer = fromModel(res.data, normalized, input.vocab);
  const parsed: ParsedQuery = {
    ...answer,
    ...(answer.when ? {} : { when: rules.certain.when, weekday: rules.certain.weekday, dateFrom: rules.certain.dateFrom, dateTo: rules.certain.dateTo }),
    category: answer.category ?? rules.certain.category, area: answer.area ?? rules.certain.area,
    city: answer.city ?? rules.certain.city, price: answer.price ?? rules.certain.price,
  };
  for (const k of Object.keys(parsed) as (keyof ParsedQuery)[]) if (parsed[k] === undefined) delete parsed[k];
  await pool.query(
    `INSERT INTO search_parse_cache (city_id, normalized, version, parsed, created_at, last_used_at) VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (city_id, normalized, version) DO UPDATE SET parsed = EXCLUDED.parsed, created_at = EXCLUDED.created_at, hits = 0`,
    [cityId, normalized, PARSER_VERSION, parsed, now]);
  return { normalized, parsed, method: "model", keywordMode: "all", costUsd: res.usd };
}

// ---------------------------------------------------------------- dates and results

/** Calendar dates ("YYYY-MM-DD", in the city's own days) for a reading, given today's date there. */
export function resolveDates(p: ParsedQuery, today: string): { from: string; to: string } | null {
  const dow = weekdayOf(today);
  const weekendEnd = addDays(today, (7 - dow) % 7); // this Sunday (today, on a Sunday)
  const year = Number(today.slice(0, 4));
  const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  switch (p.when) {
    case "today": case "tonight": return { from: today, to: today };
    case "tomorrow": return { from: addDays(today, 1), to: addDays(today, 1) };
    case "day_after_tomorrow": return { from: addDays(today, 2), to: addDays(today, 2) };
    case "this_weekend": { const from = addDays(weekendEnd, -2); return { from: from < today ? today : from, to: weekendEnd }; }
    case "next_weekend": return { from: addDays(weekendEnd, 5), to: addDays(weekendEnd, 7) };
    case "this_week": return { from: today, to: addDays(today, 6) };
    case "next_week": { const mon = addDays(today, ((8 - dow) % 7) || 7); return { from: mon, to: addDays(mon, 6) }; }
    case "this_month": return { from: today, to: monthEnd(year, Number(today.slice(5, 7))) };
    case "next_month": {
      const m = Number(today.slice(5, 7));
      const [y, n] = m === 12 ? [year + 1, 1] : [year, m + 1];
      return { from: `${y}-${pad(n)}-01`, to: monthEnd(y, n) };
    }
    case "weekday": case "next_weekday": {
      if (p.weekday === undefined) return null;
      let d = addDays(today, (p.weekday - dow + 7) % 7);
      if (p.when === "next_weekday") {
        // The one in next week, Monday to Sunday.
        const nextMon = addDays(today, ((8 - dow) % 7) || 7);
        d = addDays(nextMon, (p.weekday + 6) % 7);
      }
      return { from: d, to: d };
    }
    case "date": {
      if (!p.dateFrom) return null;
      const clamp = (y: number, md: string) => {
        const [m, d] = md.split("-").map(Number);
        const last = Number(monthEnd(y, m).slice(8));
        return `${y}-${pad(m)}-${pad(Math.min(d, last))}`;
      };
      let from = clamp(year, p.dateFrom);
      let to = clamp(year, p.dateTo ?? p.dateFrom);
      if (to < from) to = clamp(year + 1, p.dateTo ?? p.dateFrom);
      if (to < today) { from = clamp(year + 1, p.dateFrom); to = clamp(year + (to.slice(0, 4) === String(year) ? 1 : 2), p.dateTo ?? p.dateFrom); }
      if (from < today) from = today;
      return { from, to };
    }
    default: return null;
  }
}

export interface SearchOutcome extends Understanding {
  query: string;
  /** Set when the query names another live city: the caller sends the reader there. */
  otherCity?: string;
  dates: { from: string; to: string } | null;
  filter: EventFilter;
  events: EventCard[];
  /** Events matching every filter and word. */
  strictCount: number;
  /** True when nothing matched the words, and `events` are those matching the other filters without them. */
  relaxed: boolean;
}

export interface SearchInput extends Omit<UnderstandInput, "vocab"> {
  city: City;
  locale: Locale;
}

/** Reads the query, runs it, logs it. */
export async function naturalSearch(llm: LlmClient, input: SearchInput, pool: Pool = getPool()): Promise<SearchOutcome> {
  const now = input.now ?? new Date();
  const query = input.query.trim().slice(0, cfg.maxQueryChars);
  const vocab = await loadVocabulary(pool, input.city);
  const u = await understand(pool, llm, { ...input, query, vocab, now });
  const base = { ...u, query, dates: null, filter: {}, events: [], strictCount: 0, relaxed: false };
  if (u.parsed.city && u.parsed.city !== input.city.slug) return { ...base, otherCity: u.parsed.city };

  const categories = await pool.query<{ id: number; slug: string }>("SELECT id, slug FROM categories");
  const areas = await pool.query<{ id: number; slug: string }>("SELECT id, slug FROM areas WHERE city_id = $1", [input.city.id]);
  const today = isoDay(now, input.city.timezone);
  const dates = resolveDates(u.parsed, today);
  const filter: EventFilter = {
    cityId: input.city.id, from: dates?.from ?? today, to: dates?.to,
    categoryId: categories.rows.find((c) => c.slug === u.parsed.category)?.id,
    areaId: areas.rows.find((a) => a.slug === u.parsed.area)?.id,
    free: u.parsed.price === "free" ? true : u.parsed.price === "paid" ? false : undefined,
    keywords: u.parsed.keywords, keywordMode: u.keywordMode,
  };
  let events = await listEvents(filter, input.locale);
  const strictCount = events.length;
  let relaxed = false;
  const otherFilters = Boolean(dates || filter.categoryId || filter.areaId || filter.free !== undefined);
  if (strictCount === 0 && u.parsed.keywords.length > 0 && otherFilters) {
    events = await listEvents({ ...filter, keywords: undefined }, input.locale);
    relaxed = events.length > 0;
  }

  await pool.query(
    `INSERT INTO search_log (searched_at, city_id, query, normalized, locale, parsed, parse_method, result_count, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [now, input.city.id, query, u.normalized, input.locale,
      { ...u.parsed, dates, ...(u.reason ? { reason: u.reason } : {}), ...(relaxed ? { relaxed } : {}), keywordMode: u.keywordMode },
      u.method, strictCount, u.costUsd]);
  return { ...base, dates, filter, events, strictCount, relaxed };
}
