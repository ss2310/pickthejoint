/**
 * The two launch sources beyond Instagram (Prompt 2, step 8):
 *   - Google event results, read from the "events" block of a Google results
 *     page through DataForSEO;
 *   - local news event roundups, fetched politely from papers whose terms
 *     allow it.
 * Both store items in raw_posts (source_kind 'google' / 'news'); from there
 * they go through the same extraction confidence, matching and dedup rules as
 * Instagram posts. Only facts are kept: article text is read in memory, passed
 * to the extraction model and never stored or published.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { webSources } from "../../config";
import { guardedCall } from "../budget-guard";
import { extractionRequest } from "./extract";
import type { LlmClient } from "./llm";

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 20);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface City { id: number; slug: string; name: string; state: string; timezone: string }

async function liveCities(pool: Pool, slug?: string): Promise<City[]> {
  return (await pool.query<City>(
    "SELECT id, slug, name, state, timezone FROM cities WHERE is_live AND ($1::text IS NULL OR slug = $1) ORDER BY id", [slug ?? null])).rows;
}

/** True if this source has not been fetched in the last 20 hours; records the fetch. */
function claimDailyFetch(pool: Pool, key: string, dryRun: boolean): Promise<boolean> {
  return claimFetch(pool, key, 20, dryRun);
}

/** True if this source has not been fetched in the last `hours`; records the fetch (not in a dry run). */
export async function claimFetch(pool: Pool, key: string, hours: number, dryRun: boolean): Promise<boolean> {
  const { rows } = await pool.query<{ due: boolean }>(
    "SELECT (last_fetched_at IS NULL OR last_fetched_at < now() - make_interval(secs => $2)) AS due FROM source_state WHERE source_key = $1",
    [key, hours * 3600]);
  if (rows[0] && !rows[0].due) return false;
  if (!dryRun) {
    await pool.query(
      `INSERT INTO source_state (source_key, last_fetched_at) VALUES ($1, now())
       ON CONFLICT (source_key) DO UPDATE SET last_fetched_at = now()`, [key]);
  }
  return true;
}

// ------------------------------------------------------------------ Google

export interface GoogleEventItem { title: string; snippet: string; url: string }

/** Pulls event entries out of a DataForSEO Google organic "advanced" response. */
export function parseGoogleEvents(body: unknown): { items: GoogleEventItem[]; costUsd?: number } {
  const task = (body as { tasks?: { cost?: number; result?: { items?: unknown[] }[] }[] })?.tasks?.[0];
  const out: GoogleEventItem[] = [];
  for (const block of task?.result?.[0]?.items ?? []) {
    const b = block as { type?: string; items?: { title?: string; snippet?: string; url?: string }[] };
    if (b.type !== "events") continue;
    for (const el of b.items ?? []) {
      if (el.title && el.url) out.push({ title: el.title, snippet: el.snippet ?? "", url: el.url });
    }
  }
  return { items: out, costUsd: typeof task?.cost === "number" ? task.cost : undefined };
}

export interface GoogleReport { queries: number; eventsSeen: number; newItems: number; alreadyStored: number; spentUsd: number; skipped?: string }

export async function fetchGoogleEvents(
  pool: Pool, opts: { jobName: string; dryRun?: boolean; city?: string; fetchFn?: typeof fetch },
): Promise<GoogleReport> {
  const report: GoogleReport = { queries: 0, eventsSeen: 0, newItems: 0, alreadyStored: 0, spentUsd: 0 };
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!opts.dryRun && (!login || !password)) {
    report.skipped = "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set";
    return report;
  }
  const fetchFn = opts.fetchFn ?? fetch;
  for (const city of await liveCities(pool, opts.city)) {
    if (!(await claimDailyFetch(pool, `google:${city.slug}`, !!opts.dryRun))) { report.skipped = "already fetched today"; continue; }
    for (const template of webSources.google.queries) {
      const keyword = template.replace("{city}", city.name);
      const body = await guardedCall(
        {
          bucket: "scrape", subBudget: "googleEvents", service: "dataforseo", model: "serp/google/organic/live",
          units: 1, unitLabel: "queries", estimatedUsd: webSources.google.usdPerQuery, jobName: opts.jobName, dryRun: opts.dryRun,
        },
        async () => {
          const res = await fetchFn("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
            method: "POST",
            headers: { Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`, "Content-Type": "application/json" },
            body: JSON.stringify([{ keyword, location_name: `${city.name},${city.state},India`, language_code: "en", depth: 10 }]),
          });
          if (!res.ok) throw new Error(`DataForSEO ${res.status}: ${(await res.text()).slice(0, 200)}`);
          const json = (await res.json()) as unknown;
          return { result: json, actualUsd: parseGoogleEvents(json).costUsd };
        },
        { pool },
      );
      report.queries++;
      if (opts.dryRun || body === undefined) continue;
      const { items, costUsd } = parseGoogleEvents(body);
      report.spentUsd += costUsd ?? webSources.google.usdPerQuery;
      report.eventsSeen += items.length;
      for (const it of items) {
        const res = await pool.query(
          `INSERT INTO raw_posts (shortcode, handle, post_url, caption, posted_at, source_kind, city_id, filter_result)
           VALUES ($1, 'google-events', $2, $3, now(), 'google', $4, 'event') ON CONFLICT (shortcode) DO NOTHING`,
          [`google:${hash(`${it.title}|${it.snippet}`.toLowerCase())}`, it.url, `Event: ${it.title}\nDetails: ${it.snippet}`, city.id]);
        if (res.rowCount) report.newItems++; else report.alreadyStored++;
      }
    }
  }
  report.spentUsd = Number(report.spentUsd.toFixed(4));
  return report;
}

// -------------------------------------------------------------------- News

/**
 * Whether robots.txt lets us fetch a path. Uses the group naming our bot if
 * there is one, otherwise the "*" group; no matching group means allowed.
 * Supports "*" wildcards and "$" anchors; the longest matching rule wins.
 */
export function robotsAllows(robotsTxt: string, path: string, botToken: string): boolean {
  const groups = new Map<string, { allow: boolean; pattern: string }[]>();
  let agents: string[] = [];
  let inRules = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (inRules) { agents = []; inRules = false; }
      agents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      if (value) for (const a of agents) groups.get(a)!.push({ allow: key === "allow", pattern: value });
    }
  }
  const rules = groups.get(botToken.toLowerCase()) ?? groups.get("*") ?? [];
  let best: { allow: boolean; length: number } | undefined;
  for (const r of rules) {
    const re = new RegExp("^" + r.pattern.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\?\$$/, "$"));
    if (re.test(path) && (!best || r.pattern.length > best.length || (r.pattern.length === best.length && r.allow))) {
      best = { allow: r.allow, length: r.pattern.length };
    }
  }
  return best ? best.allow : true;
}

const ROUNDUP_HINT = /(events?|weekend|what'?s on|things to do|this week|line[- ]?up|festival|concert|gig|garba|exhibition|workshop|mela|कार्यक्रम|आयोजन|महोत्सव|उत्सव|मेला|प्रदर्शनी)/i;

/** Article links on a section page that look like event roundups or event announcements. */
export function findRoundupLinks(html: string, baseUrl: string, articlePattern: string): { url: string; title: string }[] {
  const pattern = new RegExp(articlePattern);
  const seen = new Set<string>();
  const out: { url: string; title: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#?]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: string;
    try { url = new URL(m[1], baseUrl).toString(); } catch { continue; }
    const title = htmlToText(m[2]);
    if (!pattern.test(url) || seen.has(url) || !ROUNDUP_HINT.test(`${title} ${url}`)) continue;
    seen.add(url);
    out.push({ url, title });
  }
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export interface NewsSourceReport { source: string; status: string; roundupsFound: number; articlesRead: number; eventsExtracted: number; modelUsd: number }

export async function fetchNewsCalendars(
  pool: Pool, llm: LlmClient, opts: { jobName: string; dryRun?: boolean; city?: string; fetchFn?: typeof fetch; delayMs?: number },
): Promise<NewsSourceReport[]> {
  const cfg = webSources.news;
  const fetchFn = opts.fetchFn ?? fetch;
  const delay = opts.delayMs ?? cfg.delayMs;
  const get = (url: string) => fetchFn(url, { headers: { "User-Agent": cfg.userAgent, Accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
  const reports: NewsSourceReport[] = [];
  const cities = await liveCities(pool, opts.city);
  const areas = await pool.query<{ city_id: number; name: string }>("SELECT city_id, name FROM areas ORDER BY name");
  const categorySlugs = (await pool.query<{ slug: string }>("SELECT slug FROM categories ORDER BY sort_order")).rows.map((c) => c.slug);

  for (const src of cfg.sources) {
    const rep: NewsSourceReport = { source: src.key, status: "ok", roundupsFound: 0, articlesRead: 0, eventsExtracted: 0, modelUsd: 0 };
    reports.push(rep);
    const city = cities.find((c) => c.slug === src.city);
    if (!city) { rep.status = "city not live or not selected"; continue; }
    if (!(cfg.enabled as readonly string[]).includes(src.key)) { rep.status = "switched off (not in NEWS_SOURCES)"; continue; }
    if (!(await claimDailyFetch(pool, `news:${src.key}`, !!opts.dryRun))) { rep.status = "already fetched today"; continue; }
    if (opts.dryRun) { rep.status = `would fetch ${src.sectionUrl} and up to ${cfg.maxArticlesPerDay} roundup articles`; continue; }
    try {
      const origin = new URL(src.sectionUrl).origin;
      const robots = await get(`${origin}/robots.txt`);
      const robotsTxt = robots.ok ? await robots.text() : "";
      const allowed = (u: string) => robotsAllows(robotsTxt, new URL(u).pathname, "PickTheJointBot");
      if (!allowed(src.sectionUrl)) { rep.status = "skipped: robots.txt disallows the section page"; continue; }
      await sleep(delay);
      const page = await get(src.sectionUrl);
      if (!page.ok) { rep.status = `section page returned ${page.status}`; continue; }
      const links = findRoundupLinks(await page.text(), src.sectionUrl, src.articlePattern).filter((l) => allowed(l.url));
      rep.roundupsFound = links.length;
      for (const link of links) {
        if (rep.articlesRead >= cfg.maxArticlesPerDay) break;
        const shortcode = `news:${hash(link.url)}`;
        if ((await pool.query("SELECT 1 FROM raw_posts WHERE shortcode = $1", [shortcode])).rowCount) continue;
        await sleep(delay);
        const res = await get(link.url);
        if (!res.ok) continue;
        const text = htmlToText(await res.text()).slice(0, cfg.maxArticleChars);
        rep.articlesRead++;
        const [out] = await llm.run([extractionRequest({
          id: shortcode, sourceKind: "news", sourceName: src.name, cityName: city.name, timeZone: city.timezone, postedAt: new Date(),
          text: `${link.title}\n\n${text}`, areas: areas.rows.filter((a) => a.city_id === city.id).map((a) => a.name), categorySlugs,
        })], { jobName: opts.jobName, subBudget: "newsCalendars", pool });
        rep.modelUsd += out?.usd ?? 0;
        // Only the headline, the link and the extracted facts are stored.
        await pool.query(
          `INSERT INTO raw_posts (shortcode, handle, post_url, caption, posted_at, source_kind, city_id, filter_result, extraction, processing_state, error)
           VALUES ($1,$2,$3,$4,now(),'news',$5,'event',$6,$7,$8) ON CONFLICT (shortcode) DO NOTHING`,
          [shortcode, src.key, link.url, link.title, city.id, out?.ok ? JSON.stringify(out.data) : null,
            out?.ok ? "extracted" : "error", out?.ok ? null : out?.error ?? "extraction failed"]);
        if (out?.ok && out.data) rep.eventsExtracted += out.data.events.length;
      }
    } catch (err) {
      if ((err as Error).name === "BudgetExceededError") { rep.status = `stopped: ${(err as Error).message}`; break; }
      rep.status = `failed: ${(err as Error).message}`;
    }
    rep.modelUsd = Number(rep.modelUsd.toFixed(4));
  }
  return reports;
}
