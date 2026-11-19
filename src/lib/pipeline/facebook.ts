/**
 * Public Facebook events (Prompt 9, the owner's decision of 18 Nov 2026):
 * the upcoming events of the city's venue and organiser pages, read logged
 * out through an Apify actor (no Facebook account is used), once a week,
 * within the `facebookEvents` sub-budget. Pages come from the Facebook links
 * on venue and organiser pages and from ones the admin adds.
 * Only facts are kept: the event text is read in memory by the extraction
 * model, and only the name, link and extracted facts are stored. The events
 * then go through the same matching, dedup and confidence rules as the rest.
 */
import type { Pool } from "pg";
import { sourcing } from "../../config";
import { guardedCall } from "../budget-guard";
import type { ApifyClient } from "./apify";
import { eventText, type LdEvent } from "./calendars";
import { extractionRequest, type Extraction } from "./extract";
import type { LlmClient } from "./llm";
import { claimFetch } from "./sources";
import { localDate } from "./text";

const NOT_PAGES = new Set(["events", "groups", "pages", "profile.php", "watch", "share", "sharer", "marketplace", "hashtag", "photo.php", "story.php", "people"]);

/**
 * A Facebook page's path ("fleamarketindore") from a link to it; null for anything that is not a page.
 * A page without a username has an address like /p/Some-Name-61565553603715/: its path is the number,
 * which facebook.com/<number> also leads to.
 */
export function facebookPage(url: string | null | undefined): string | null {
  const numbered = (url ?? "").trim().match(/^(?:https?:\/\/)?(?:www\.|m\.|web\.)?facebook\.com\/p\/[^/?#]*?-?(\d{8,})\/?(?:[?#].*)?$/i);
  if (numbered) return numbered[1];
  const m = (url ?? "").trim().match(/^(?:https?:\/\/)?(?:www\.|m\.|web\.)?facebook\.com\/([A-Za-z0-9.\-]{3,80})\/?(?:[?#].*)?$/i);
  if (!m || NOT_PAGES.has(m[1].toLowerCase())) return null;
  return m[1];
}

/** Adds the Facebook pages linked from venue and organiser pages of a city to the list. */
export async function syncFacebookPages(pool: Pool, cityId: number): Promise<number> {
  const { rows } = await pool.query<{ link: string; name: string; venue_id: number | null; organiser_id: number | null }>(
    `SELECT v.official_links->>'facebook' AS link, v.name, v.id AS venue_id, NULL::bigint AS organiser_id
       FROM venues v WHERE v.city_id = $1 AND v.official_links ? 'facebook'
     UNION ALL
     SELECT o.official_links->>'facebook', o.name, NULL, o.id FROM organisers o
      WHERE o.official_links ? 'facebook'
        AND EXISTS (SELECT 1 FROM event_organisers eo JOIN events e ON e.id = eo.event_id WHERE eo.organiser_id = o.id AND e.city_id = $1)
     UNION ALL
     SELECT vc.facebook_url, vc.name, vc.venue_id, NULL FROM venue_census vc WHERE vc.city_id = $1 AND vc.facebook_url IS NOT NULL AND NOT vc.ignored`,
    [cityId]);
  let added = 0;
  for (const r of rows) {
    const page = facebookPage(r.link);
    if (!page) continue;
    const res = await pool.query(
      `INSERT INTO facebook_pages (city_id, page, name, venue_id, organiser_id, added_via) VALUES ($1,$2,$3,$4,$5,'official_link')
       ON CONFLICT (city_id, page) DO NOTHING`, [cityId, page, r.name, r.venue_id, r.organiser_id]);
    added += res.rowCount ?? 0;
  }
  return added;
}

/** Maps one item of apify/facebook-events-scraper to our structured event. */
export function facebookEvent(item: Record<string, unknown>): (LdEvent & { id: string; online: boolean; cancelled: boolean }) | null {
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const url = typeof item.url === "string" ? item.url : null;
  const id = String(item.id ?? url?.match(/events\/(\d+)/)?.[1] ?? "");
  if (!name || !id) return null;
  const loc = (item.location ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const start = s(item.utcStartDate) ?? s(item.startTime) ?? s(item.startDate);
  const durationMs = typeof item.duration === "string" ? parseDuration(item.duration) : null;
  const end = s(item.utcEndDate) ?? (start && durationMs ? new Date(Date.parse(start) + durationMs).toISOString() : null);
  const organisers = Array.isArray(item.organizators) ? item.organizators.map((o) => s((o as Record<string, unknown>)?.name)).filter((o): o is string => !!o) : [];
  const tickets = (item.ticketsInfo ?? {}) as Record<string, unknown>;
  return {
    id, name, startDate: start, endDate: end,
    venue: s(loc.name), address: [s(loc.streetAddress), s(loc.city)].filter(Boolean).join(", ") || s(item.address),
    city: s(loc.city), price: null, isFree: null, bookingUrl: s(tickets.buyUrl),
    organiser: organisers[0] ?? s(item.organizedBy)?.replace(/^Event by\s+/i, "") ?? null, performers: [],
    url, status: item.isCanceled === true ? "EventCancelled" : null,
    description: s(item.description), online: item.isOnline === true, cancelled: item.isCanceled === true,
  };
}

/** "PT2H30M" or "2 hr 30 min" -> milliseconds. */
function parseDuration(d: string): number | null {
  const iso = d.match(/^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?$/i);
  if (iso && (iso[1] || iso[2])) return ((Number(iso[1] ?? 0) * 60) + Number(iso[2] ?? 0)) * 60_000;
  const h = d.match(/(\d+)\s*h/i), m = d.match(/(\d+)\s*m/i);
  return h || m ? ((Number(h?.[1] ?? 0) * 60) + Number(m?.[1] ?? 0)) * 60_000 : null;
}

/** Items the actor bills as events; a page with no upcoming events comes back as an "error: no_results" row. */
const billedEvents = (items: Record<string, unknown>[]) => items.filter((i) => !i.error && !i.errorDescription).length;

export interface FacebookReport {
  status: string;
  pagesKnown: number;
  pagesAdded: number;
  pagesChecked: number;
  eventsReturned: number;
  alreadyStored: number;
  skipped: number;
  /** Why items were set aside (first few), so a change in the actor's output shows up in the run report. */
  skipReasons: string[];
  newEvents: number;
  eventsExtracted: number;
  scrapeUsd: number;
  modelUsd: number;
}

export async function fetchFacebookEvents(
  pool: Pool, apify: ApifyClient, llm: LlmClient,
  opts: { jobName: string; dryRun?: boolean; city?: string; maxPages?: number; force?: boolean; batch?: boolean },
): Promise<FacebookReport> {
  const cfg = sourcing.facebook;
  const rep: FacebookReport = { status: "ok", pagesKnown: 0, pagesAdded: 0, pagesChecked: 0, eventsReturned: 0, alreadyStored: 0, skipped: 0, skipReasons: [], newEvents: 0, eventsExtracted: 0, scrapeUsd: 0, modelUsd: 0 };
  if (!cfg.enabled) { rep.status = "switched off (FACEBOOK_EVENTS=off)"; return rep; }
  const cities = (await pool.query<{ id: number; slug: string; name: string; timezone: string }>(
    "SELECT id, slug, name, timezone FROM cities WHERE is_live AND ($1::text IS NULL OR slug = $1) ORDER BY id", [opts.city ?? null])).rows;
  const categorySlugs = (await pool.query<{ slug: string }>("SELECT slug FROM categories ORDER BY sort_order")).rows.map((c) => c.slug);

  for (const city of cities) {
    if (!opts.dryRun) rep.pagesAdded += await syncFacebookPages(pool, city.id);
    const pages = (await pool.query<{ id: number; page: string }>(
      // Pages that have shown an event before are read every week; the rest take turns.
      "SELECT id, page FROM facebook_pages WHERE city_id = $1 AND active ORDER BY (events_seen > 0) DESC, last_checked_at NULLS FIRST, id LIMIT $2",
      [city.id, Math.min(opts.maxPages ?? cfg.maxPagesPerRun, cfg.maxPagesPerRun)])).rows;
    rep.pagesKnown += Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM facebook_pages WHERE city_id = $1 AND active", [city.id])).rows[0].n);
    if (pages.length === 0) { rep.status = "no Facebook pages on record yet"; continue; }
    const due = await claimFetch(pool, `facebook:${city.slug}`, opts.force ? 0 : cfg.everyHours, !!opts.dryRun);
    if (!due) { rep.status = "not due (read weekly)"; continue; }

    const maxItems = pages.length * cfg.maxEventsPerPage;
    const estimate = maxItems * cfg.usdPerEvent + cfg.usdPerRun;
    const items = await guardedCall(
      {
        bucket: "scrape", subBudget: "facebookEvents", service: "apify", model: cfg.actorId,
        units: maxItems, unitLabel: "events", estimatedUsd: estimate, jobName: opts.jobName, dryRun: opts.dryRun,
      },
      async () => {
        const run = await apify.runActor(cfg.actorId, {
          startUrls: pages.map((p) => ({ url: `https://www.facebook.com/${p.page}/upcoming_hosted_events` })),
          maxEvents: cfg.maxEventsPerPage,
        }, { maxChargeUsd: estimate, maxItems, timeoutSecs: 900 });
        const events = billedEvents(run.items);
        return { result: run.items, actualUsd: events * cfg.usdPerEvent + cfg.usdPerRun, units: events };
      },
      { pool },
    );
    if (opts.dryRun || !items) { rep.status = `dry run: would check ${pages.length} page(s), up to ${maxItems} events, about $${estimate.toFixed(2)}`; continue; }
    rep.pagesChecked += pages.length;
    rep.eventsReturned += items.length;
    rep.scrapeUsd += billedEvents(items) * cfg.usdPerEvent + cfg.usdPerRun;
    await pool.query("UPDATE facebook_pages SET last_checked_at = now() WHERE id = ANY($1)", [pages.map((p) => p.id)]);

    const today = localDate(new Date(), city.timezone);
    const fresh: { shortcode: string; url: string; name: string; text: string; page: string }[] = [];
    for (const item of items) {
      const e = facebookEvent(item);
      const skip = (why: string) => { rep.skipped++; if (rep.skipReasons.length < 5) rep.skipReasons.push(why.slice(0, 200)); };
      if (!e) {
        const err = item.error ?? item.errorDescription ?? item.message;
        skip(err ? `actor said: ${String(err)}` : `unreadable item with fields: ${Object.keys(item).slice(0, 12).join(", ")}`);
        continue;
      }
      const day = e.startDate ? localDate(new Date(e.startDate), city.timezone) : null;
      if (e.online) { skip(`online event: ${e.name}`); continue; }
      if (day && day < today && !e.endDate) { skip(`already past (${day}): ${e.name}`); continue; }
      const shortcode = `fb:${e.id}`;
      if ((await pool.query("SELECT 1 FROM raw_posts WHERE shortcode = $1", [shortcode])).rowCount) { rep.alreadyStored++; continue; }
      const page = pages.find((p) => typeof item.inputUrl === "string" && item.inputUrl.includes(`/${p.page}/`))?.page ?? "facebook";
      if (page !== "facebook") await pool.query("UPDATE facebook_pages SET events_seen = events_seen + 1 WHERE city_id = $1 AND page = $2", [city.id, page]);
      fresh.push({ shortcode, url: e.url ?? `https://www.facebook.com/events/${e.id}/`, name: e.name, page,
        text: `${e.cancelled ? "This event has been CANCELLED.\n" : ""}${eventText(e, city.timezone, e.url ?? "")}${e.city ? `\nCity given on Facebook: ${e.city}` : ""}` });
    }
    rep.newEvents += fresh.length;
    const areas = (await pool.query<{ name: string }>("SELECT name FROM areas WHERE city_id = $1 ORDER BY name", [city.id])).rows.map((a) => a.name);
    const results = await llm.run(fresh.map((f) => extractionRequest({
      id: f.shortcode, sourceKind: "facebook", sourceName: `facebook.com/${f.page}`, cityName: city.name, timeZone: city.timezone,
      postedAt: new Date(), text: f.text, areas, categorySlugs,
    })), { jobName: opts.jobName, batch: opts.batch, subBudget: "webCalendars", pool });
    for (const r of results) {
      const f = fresh.find((x) => x.shortcode === r.id)!;
      const data = r.ok ? r.data as Extraction : null;
      rep.modelUsd += r.usd;
      if (data) rep.eventsExtracted += data.events.length;
      await pool.query(
        `INSERT INTO raw_posts (shortcode, handle, post_url, caption, posted_at, source_kind, city_id, filter_result, extraction, processing_state, error, model_usd)
         VALUES ($1,$2,$3,$4,now(),'facebook',$5,'event',$6,$7,$8,$9) ON CONFLICT (shortcode) DO NOTHING`,
        [f.shortcode, f.page, f.url, f.name.slice(0, 300), city.id, data ? JSON.stringify(data) : null, data ? "extracted" : "error",
          data ? null : r.error ?? "extraction failed", r.usd]);
    }
  }
  rep.scrapeUsd = Number(rep.scrapeUsd.toFixed(4));
  rep.modelUsd = Number(rep.modelUsd.toFixed(4));
  return rep;
}
