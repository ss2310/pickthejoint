/**
 * Web calendars (Prompt 9): event listings and institution calendars whose
 * terms and robots.txt allow polite automated reading (docs/sources.md). The
 * list per city is in data/sourcing.json. Each source is read at most every
 * few days, robots.txt is checked on every run, and only facts are kept: the
 * page is read in memory, the extraction model returns the facts, and only the
 * headline, the link and the facts are stored. From there the events go
 * through the same matching, dedup and confidence rules as Instagram posts.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { sourcing } from "../../config";
import { extractionRequest, type Extraction } from "./extract";
import type { LlmClient } from "./llm";
import { enabledCalendars, type CalendarSource } from "./sourcing-data";
import { claimFetch, htmlToText, robotsAllows } from "./sources";
import { localDate } from "./text";

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 20);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ JSON-LD events

export interface LdEvent {
  name: string;
  startDate: string | null;
  endDate: string | null;
  venue: string | null;
  address: string | null;
  city: string | null;
  price: string | null;
  isFree: boolean | null;
  bookingUrl: string | null;
  organiser: string | null;
  performers: string[];
  url: string | null;
  status: string | null;
  description: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const first = <T>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v);
const isEventType = (t: unknown) => (Array.isArray(t) ? t : [t]).some((x) => typeof x === "string" && /(Event|Festival)$/.test(x));

function addressText(a: unknown): { text: string | null; city: string | null } {
  if (typeof a === "string") return { text: str(a), city: null };
  const o = (a ?? {}) as Record<string, unknown>;
  const parts = [o.streetAddress, o.addressLocality, o.addressRegion, o.postalCode].map(str).filter(Boolean);
  return { text: parts.length ? parts.join(", ") : null, city: str(o.addressLocality) };
}

function toLdEvent(o: Record<string, unknown>): LdEvent | null {
  const name = str(o.name);
  if (!name) return null;
  const loc = (first(o.location as unknown[]) ?? {}) as Record<string, unknown>;
  const addr = addressText(loc.address);
  const offer = (first(o.offers as unknown[]) ?? {}) as Record<string, unknown>;
  const price = offer.price ?? offer.lowPrice;
  const priceText = price !== undefined && price !== null && String(price) !== ""
    ? `${offer.priceCurrency === "INR" || !offer.priceCurrency ? "₹" : `${String(offer.priceCurrency)} `}${String(price)}${offer.lowPrice !== undefined ? " onwards" : ""}`
    : null;
  const names = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : [])
    .map((p) => (typeof p === "string" ? p : str((p as Record<string, unknown>)?.name)))
    .filter((p): p is string => !!p);
  return {
    name,
    startDate: str(o.startDate),
    endDate: str(o.endDate),
    venue: str(loc.name),
    address: addr.text,
    city: addr.city,
    price: priceText,
    isFree: o.isAccessibleForFree === true || o.isAccessibleForFree === "true" ? true : price !== undefined && Number(price) === 0 ? true : null,
    bookingUrl: str(offer.url),
    organiser: names(o.organizer)[0] ?? null,
    performers: names(o.performer),
    url: str(o.url),
    status: str(o.eventStatus)?.replace(/^https?:\/\/schema\.org\//, "") ?? null,
    description: str(o.description),
  };
}

/** schema.org Event (and Festival, ComedyEvent ...) objects in a page's JSON-LD blocks, including @graph and ItemList items. */
export function jsonLdEvents(html: string): LdEvent[] {
  const out: LdEvent[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    const o = node as Record<string, unknown>;
    if (isEventType(o["@type"])) { const e = toLdEvent(o); if (e) out.push(e); return; }
    for (const k of ["@graph", "itemListElement", "item", "subEvent"]) if (k in o) walk(o[k], depth + 1);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim()), 0); } catch { /* a broken block is skipped */ }
  }
  return out;
}

/** Links a listing's JSON-LD ItemList or anchors point to, matching the source's event URL pattern. */
export function eventLinks(html: string, baseUrl: string, pattern: string): string[] {
  const re = new RegExp(pattern);
  const found = new Set<string>();
  const add = (u: string) => { try { const abs = new URL(u, baseUrl).toString().replace(/[?#].*$/, ""); if (re.test(abs)) found.add(abs); } catch { /* skip */ } };
  for (const m of html.matchAll(/"(?:url|item|@id)"\s*:\s*"([^"]+)"/g)) add(m[1]);
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#]+)"/gi)) add(m[1]);
  return [...found];
}

/** <loc> and <lastmod> pairs from a sitemap. */
export function sitemapUrls(xml: string): { url: string; lastmod: string | null }[] {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
    url: (m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1] ?? "").replace(/&amp;/g, "&"),
    lastmod: m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1] ?? null,
  })).filter((u) => u.url);
}

/** A date-time from structured data, as the city's local date and time ("2026-12-05 19:30"). */
export function localWhen(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // A time with no offset is taken as already local.
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return iso.replace("T", " ").slice(0, 16);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(d).reduce<Record<string, string>>((a, p) => ({ ...a, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
}

/** The facts of a structured event, as plain lines for the extraction model. */
export function eventText(e: LdEvent, timeZone: string, pageUrl: string): string {
  const lines = [
    `Event name: ${e.name}`,
    e.status && e.status !== "EventScheduled" ? `Status: ${e.status}` : "",
    `Starts (local time): ${localWhen(e.startDate, timeZone) ?? "not given"}`,
    e.endDate ? `Ends (local time): ${localWhen(e.endDate, timeZone)}` : "",
    `Venue: ${e.venue ?? "not given"}`,
    e.address ? `Address: ${e.address}` : "",
    e.price ? `Price: ${e.price}` : e.isFree ? "Price: free" : "",
    e.organiser ? `Organiser: ${e.organiser}` : "",
    e.performers.length ? `Performers: ${e.performers.join(", ")}` : "",
    `Event page: ${e.url ?? pageUrl}`,
    e.bookingUrl ? `Booking link: ${e.bookingUrl}` : "",
    e.description ? `Description (from the listing): ${e.description.replace(/\s+/g, " ").slice(0, 1200)}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

/** True if the event has clearly ended before `today` (local date). */
function isPast(e: LdEvent, timeZone: string, today: string): boolean {
  const end = localWhen(e.endDate ?? e.startDate, timeZone)?.slice(0, 10);
  return !!end && /^\d{4}-\d{2}-\d{2}$/.test(end) && end < today;
}

// ------------------------------------------------------------------ the job

export interface CalendarReport {
  source: string;
  status: string;
  pagesFetched: number;
  itemsSeen: number;
  alreadyStored: number;
  skipped: number;
  read: number;
  eventsExtracted: number;
  modelUsd: number;
}

interface City { id: number; slug: string; name: string; timezone: string }
interface Item { shortcode: string; url: string; title: string; text: string }

export interface CalendarOptions {
  jobName: string;
  dryRun?: boolean;
  city?: string;
  /** Read at most this many new items per source (for checks with small limits). */
  maxItems?: number;
  /** Ignore the every-few-days schedule. */
  force?: boolean;
  fetchFn?: typeof fetch;
  delayMs?: number;
  batch?: boolean;
  /** Only these calendar keys. */
  only?: string[];
}

export async function fetchCalendars(pool: Pool, llm: LlmClient, opts: CalendarOptions): Promise<CalendarReport[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const delay = opts.delayMs ?? sourcing.delayMs;
  const get = (url: string, accept = "text/html") =>
    fetchFn(url, { headers: { "User-Agent": sourcing.userAgent, Accept: accept }, signal: AbortSignal.timeout(30_000) });
  const cities = (await pool.query<City>(
    "SELECT id, slug, name, timezone FROM cities WHERE is_live AND ($1::text IS NULL OR slug = $1) ORDER BY id", [opts.city ?? null])).rows;
  const categorySlugs = (await pool.query<{ slug: string }>("SELECT slug FROM categories ORDER BY sort_order")).rows.map((c) => c.slug);
  const reports: CalendarReport[] = [];

  for (const city of cities) {
    const areas = (await pool.query<{ name: string }>("SELECT name FROM areas WHERE city_id = $1 ORDER BY name", [city.id])).rows.map((a) => a.name);
    const today = localDate(new Date(), city.timezone);
    for (const src of enabledCalendars(city.slug).filter((c) => !opts.only || opts.only.includes(c.key))) {
      const rep: CalendarReport = { source: `${city.slug}:${src.key}`, status: "ok", pagesFetched: 0, itemsSeen: 0, alreadyStored: 0, skipped: 0, read: 0, eventsExtracted: 0, modelUsd: 0 };
      reports.push(rep);
      // A forced run ignores the schedule but still records the read.
      const due = await claimFetch(pool, `web:${city.slug}:${src.key}`, opts.force ? 0 : src.everyDays * 24 - 4, !!opts.dryRun);
      if (!due) { rep.status = `not due (read every ${src.everyDays} days)`; continue; }
      try {
        const origin = new URL(src.url).origin;
        const robots = await get(`${origin}/robots.txt`, "text/plain");
        const robotsTxt = robots.ok ? await robots.text() : "";
        const allowed = (u: string) => robotsAllows(robotsTxt, new URL(u).pathname + new URL(u).search, "PickTheJointBot");
        if (!allowed(src.url)) { rep.status = "skipped: robots.txt disallows the listing"; continue; }
        const items = await collect(pool, src, city, today, { get, allowed, delay, rep, maxItems: opts.maxItems, dryRun: !!opts.dryRun });
        if (opts.dryRun) {
          rep.status = `dry run: would read ${items.length} new item(s)`;
          if (items.length) await llm.run(items.map((it) => request(it, src, city, areas, categorySlugs)), { jobName: opts.jobName, dryRun: true, subBudget: "webCalendars", pool });
          continue;
        }
        const results = await llm.run(items.map((it) => request(it, src, city, areas, categorySlugs)),
          { jobName: opts.jobName, batch: opts.batch, subBudget: "webCalendars", pool });
        for (const r of results) {
          const it = items.find((i) => i.shortcode === r.id)!;
          rep.modelUsd += r.usd;
          rep.read++;
          const data = r.ok ? r.data as Extraction : null;
          if (data) rep.eventsExtracted += data.events.length;
          await pool.query(
            `INSERT INTO raw_posts (shortcode, handle, post_url, caption, posted_at, source_kind, city_id, filter_result, extraction, processing_state, error, model_usd)
             VALUES ($1,$2,$3,$4,now(),'web',$5,'event',$6,$7,$8,$9) ON CONFLICT (shortcode) DO NOTHING`,
            [it.shortcode, src.key, it.url, it.title.slice(0, 300), city.id, data ? JSON.stringify(data) : null,
              data ? "extracted" : "error", data ? null : r.error ?? "extraction failed", r.usd]);
        }
      } catch (err) {
        if ((err as Error).name === "BudgetExceededError") { rep.status = `stopped: ${(err as Error).message}`; break; }
        rep.status = `failed: ${(err as Error).message}`.slice(0, 300);
      }
      rep.modelUsd = Number(rep.modelUsd.toFixed(4));
    }
  }
  return reports;
}

function request(it: Item, src: CalendarSource, city: City, areas: string[], categorySlugs: string[]) {
  return extractionRequest({
    id: it.shortcode, sourceKind: "web", sourceName: `${src.name} (${it.url})`, cityName: city.name, timeZone: city.timezone,
    postedAt: new Date(), text: it.text, areas, categorySlugs,
  });
}

/** Where a marker phrase starts in a text, whatever whitespace or line breaks sit between its words; -1 if absent. */
function findMarker(text: string, marker: string): number {
  const re = new RegExp(marker.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "i");
  return text.search(re);
}

/**
 * A page's text, cut to the part between the source's markers. Null when the
 * source has a start marker and the page lacks it (a different page template:
 * set aside rather than read with navigation and footer text that may name the city).
 */
export function pageText(html: string, src: Pick<CalendarSource, "textStart" | "textEnd">): string | null {
  let text = htmlToText(html);
  if (src.textStart) {
    const i = findMarker(text, src.textStart);
    if (i < 0) return null;
    text = text.slice(i);
  }
  if (src.textEnd) { const i = findMarker(text, src.textEnd); if (i > 0) text = text.slice(0, i); }
  return text.trim().slice(0, sourcing.calendars.maxChars);
}

const pageTitle = (html: string) => htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();

async function stored(pool: Pool, shortcode: string): Promise<boolean> {
  return !!(await pool.query("SELECT 1 FROM raw_posts WHERE shortcode = $1", [shortcode])).rowCount;
}

/** Remembers a page we read and set aside (not about the city, or past), so it is not fetched again. */
async function setAside(pool: Pool, shortcode: string, src: CalendarSource, url: string, title: string, cityId: number, dryRun: boolean) {
  if (dryRun) return;
  await pool.query(
    `INSERT INTO raw_posts (shortcode, handle, post_url, caption, posted_at, source_kind, city_id, filter_result, processing_state, processed_at)
     VALUES ($1,$2,$3,$4,now(),'web',$5,'not_event','filtered_out',now()) ON CONFLICT (shortcode) DO NOTHING`,
    [shortcode, src.key, url, title.slice(0, 300), cityId]);
}

async function collect(
  pool: Pool, src: CalendarSource, city: City, today: string,
  t: { get: (u: string, accept?: string) => Promise<Response>; allowed: (u: string) => boolean; delay: number; rep: CalendarReport; maxItems?: number; dryRun: boolean },
): Promise<Item[]> {
  const items: Item[] = [];
  const limit = Math.min(t.maxItems ?? Infinity, sourcing.calendars.maxPagesPerRun);
  const fetchPage = async (url: string) => {
    await sleep(t.delay);
    t.rep.pagesFetched++;
    const res = await t.get(url);
    return res.ok ? await res.text() : null;
  };

  if (src.kind === "page") {
    const html = await fetchPage(src.url);
    if (html === null) { t.rep.status = "page did not load"; return items; }
    const text = pageText(html, src) ?? "";
    const shortcode = `web:${src.key}:${hash(text)}`;
    t.rep.itemsSeen = 1;
    if (await stored(pool, shortcode)) { t.rep.alreadyStored++; return items; }
    if (src.mustMention && !text.toLowerCase().includes(src.mustMention.toLowerCase())) {
      t.rep.skipped++;
      await setAside(pool, shortcode, src, src.url, pageTitle(html), city.id, t.dryRun);
      return items;
    }
    items.push({ shortcode, url: src.url, title: pageTitle(html) || src.name, text });
    return items;
  }

  let candidates: { url: string; version: string }[] = [];
  if (src.kind === "sitemap-page") {
    const res = await t.get(src.url, "application/xml");
    if (!res.ok) { t.rep.status = `sitemap returned ${res.status}`; return items; }
    const re = new RegExp(src.eventUrlPattern ?? ".");
    candidates = sitemapUrls(await res.text()).filter((u) => re.test(u.url))
      .sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""))
      .map((u) => ({ url: u.url, version: u.lastmod ?? "" }));
  } else {
    const html = await fetchPage(src.url);
    if (html === null) { t.rep.status = "listing did not load"; return items; }
    candidates = eventLinks(html, src.url, src.eventUrlPattern ?? "^https?://").map((url) => ({ url, version: "" }));
  }
  t.rep.itemsSeen = candidates.length;

  for (const c of candidates) {
    if (items.length >= limit || t.rep.pagesFetched >= sourcing.calendars.maxFetchesPerRun) break;
    // A page is read again only when its sitemap date changes.
    const shortcode = `web:${src.key}:${hash(`${c.url}|${c.version}`)}`;
    if (await stored(pool, shortcode)) { t.rep.alreadyStored++; continue; }
    if (!t.allowed(c.url)) { t.rep.skipped++; continue; }
    const html = await fetchPage(c.url);
    if (html === null) { t.rep.skipped++; continue; }
    const title = pageTitle(html);
    const events = jsonLdEvents(html).filter((e) => !isPast(e, city.timezone, today));
    let text: string;
    // Where the city must be named: the event's own part of the page, not its title or menus.
    let mentionIn: string;
    if (src.kind === "jsonld-list") {
      if (events.length === 0) { t.rep.skipped++; await setAside(pool, shortcode, src, c.url, title, city.id, t.dryRun); continue; }
      text = events.map((e) => eventText(e, city.timezone, c.url)).join("\n\n");
      mentionIn = text;
    } else {
      const body = pageText(html, src);
      if (body === null) { t.rep.skipped++; await setAside(pool, shortcode, src, c.url, title, city.id, t.dryRun); continue; }
      const ld = jsonLdEvents(html)[0];
      // The page's own dates go first; a page whose event has passed is set aside without a model call.
      if (ld && isPast(ld, city.timezone, today)) { t.rep.skipped++; await setAside(pool, shortcode, src, c.url, title, city.id, t.dryRun); continue; }
      text = [`Page title: ${title}`, ld ? `Event name: ${ld.name}\nDates: ${ld.startDate ?? "?"} to ${ld.endDate ?? ld.startDate ?? "?"}` : "", body]
        .filter(Boolean).join("\n\n");
      mentionIn = body;
    }
    const mention = src.mustMention?.toLowerCase();
    if (mention && !mentionIn.toLowerCase().includes(mention)) {
      t.rep.skipped++;
      await setAside(pool, shortcode, src, c.url, title, city.id, t.dryRun);
      continue;
    }
    items.push({ shortcode, url: c.url, title: title || events[0]?.name || c.url, text });
  }
  return items;
}
