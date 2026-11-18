/**
 * Crawl access check: requests five kinds of page through the live domain as
 * each AI crawler in config and records the status. A 403 or a challenge page
 * means the CDN is turning that crawler away, which would quietly undo the
 * whole project, so any failure is reported and alerted on.
 */
import type { Pool } from "pg";
import { aiCrawlers, site } from "../config";

export interface CrawlResult { agent: string; path: string; status: number; blocked: boolean; note?: string }
export interface CrawlReport { ok: boolean; pages: string[]; agents: number; requests: number; blocked: CrawlResult[]; byAgent: Record<string, string> }

/** Marks our own check so the crawler log does not count it as a real visit. */
export const CHECK_HEADER = "x-ptj-crawl-check";

const CHALLENGE = /(just a moment|attention required|cf-chl|challenge-platform|verify you are human|access denied)/i;

/** One page of each main type, taken from what is live. */
export async function samplePages(pool: Pool): Promise<string[]> {
  const one = async (sql: string) => (await pool.query<{ path: string }>(sql)).rows[0]?.path;
  const upcoming = "e.is_published AND c.is_live AND e.status = 'scheduled' AND e.starts_at > now()";
  const pages = [
    await one("SELECT '/' || slug AS path FROM cities WHERE is_live ORDER BY id LIMIT 1"),
    await one("SELECT '/' || slug || '/this-weekend' AS path FROM cities WHERE is_live ORDER BY id LIMIT 1"),
    await one(`SELECT '/' || c.slug || '/events/' || e.slug AS path FROM events e JOIN cities c ON c.id = e.city_id WHERE ${upcoming} ORDER BY e.starts_at LIMIT 1`),
    await one(`SELECT '/' || c.slug || '/venues/' || v.slug AS path FROM events e JOIN cities c ON c.id = e.city_id JOIN venues v ON v.id = e.venue_id WHERE ${upcoming} ORDER BY e.starts_at LIMIT 1`),
    await one(`SELECT '/artists/' || ar.slug AS path FROM events e JOIN cities c ON c.id = e.city_id JOIN event_artists ea ON ea.event_id = e.id JOIN artists ar ON ar.id = ea.artist_id WHERE e.is_published AND c.is_live ORDER BY e.starts_at DESC LIMIT 1`),
    "/how-we-verify",
  ];
  return [...new Set(pages.filter((p): p is string => !!p))].slice(0, 5);
}

export async function crawlCheck(pool: Pool, opts: { fetchFn?: typeof fetch; delayMs?: number } = {}): Promise<CrawlReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const pages = await samplePages(pool);
  const results: CrawlResult[] = [];
  for (const crawler of aiCrawlers) {
    for (const path of pages) {
      let result: CrawlResult;
      try {
        const res = await fetchFn(`${site.url}${path}`, {
          redirect: "manual",
          headers: { "User-Agent": `Mozilla/5.0 (compatible; ${crawler.token}/1.0)`, Accept: "text/html", [CHECK_HEADER]: "1" },
          signal: AbortSignal.timeout(30_000),
        });
        const body = res.status === 200 ? (await res.text()).slice(0, 4000) : "";
        const challenged = res.headers.get("cf-mitigated") !== null || (res.status === 200 && CHALLENGE.test(body) && !body.includes("application/ld+json"));
        result = { agent: crawler.token, path, status: res.status, blocked: res.status !== 200 || challenged, note: challenged ? "challenge page" : undefined };
      } catch (err) {
        result = { agent: crawler.token, path, status: 0, blocked: true, note: (err as Error).message };
      }
      results.push(result);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }
  const blocked = results.filter((r) => r.blocked);
  const byAgent: Record<string, string> = {};
  for (const c of aiCrawlers) {
    const mine = results.filter((r) => r.agent === c.token);
    byAgent[c.token] = mine.every((r) => !r.blocked) ? "200 on every page" : mine.filter((r) => r.blocked).map((r) => `${r.status} ${r.path}${r.note ? ` (${r.note})` : ""}`).join("; ");
  }
  return { ok: blocked.length === 0 && pages.length > 0, pages, agents: aiCrawlers.length, requests: results.length, blocked, byAgent };
}
