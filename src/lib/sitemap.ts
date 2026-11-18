/** XML sitemaps, split by page type, with last-modified dates taken from the data. */
import { getPool } from "./db";
import { locales, site } from "../config";
import { changelog } from "../content/changelog";
import { DATE_HUBS } from "./hubs";
import { isoDay } from "./format";
import { LANG_TAG, localePath } from "./locale";
import { zonedToUtc } from "./pipeline/text";
import { areasWithEvents, cityLastChange, listCategories, listEvents, liveCities, sitemapRows } from "./queries";

export const SITEMAP_TYPES = ["hubs", "events", "venues", "artists", "organisers", "series", "pages"] as const;
export type SitemapType = (typeof SITEMAP_TYPES)[number];

export interface SitemapEntry {
  path: string; lastmod: Date;
  /** Set on pages that exist in English only. */
  oneLanguage?: boolean;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * One <url> per language version of a page. Each lists every version of that
 * page (hreflang), which is how search engines learn the two belong together.
 */
export function urlsetXml(entries: SitemapEntry[]): string {
  const urls = entries.flatMap((e) => {
    const lastmod = `<lastmod>${e.lastmod.toISOString()}</lastmod>`;
    if (e.oneLanguage) return [`<url><loc>${esc(site.url + e.path)}</loc>${lastmod}</url>`];
    const links = [
      ...locales.map((l) => `<xhtml:link rel="alternate" hreflang="${LANG_TAG[l]}" href="${esc(site.url + localePath(e.path, l))}"/>`),
      `<xhtml:link rel="alternate" hreflang="x-default" href="${esc(site.url + e.path)}"/>`,
    ].join("");
    return locales.map((l) => `<url><loc>${esc(site.url + localePath(e.path, l))}</loc>${lastmod}${links}</url>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}

export function indexXml(entries: SitemapEntry[]): string {
  const maps = entries.map((e) => `<sitemap><loc>${esc(site.url + e.path)}</loc><lastmod>${e.lastmod.toISOString()}</lastmod></sitemap>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${maps.join("\n")}\n</sitemapindex>\n`;
}

/** Hub pages. Date hubs change at local midnight even when no listing does. */
async function hubEntries(now: Date): Promise<SitemapEntry[]> {
  const out: SitemapEntry[] = [];
  const categories = await listCategories();
  for (const city of await liveCities()) {
    const base = `/${city.slug}`;
    const changed = (await cityLastChange(city.id)) ?? now;
    const midnight = zonedToUtc(isoDay(now, city.timezone), "00:00", city.timezone);
    const daily = changed > midnight ? changed : midnight;
    out.push({ path: base, lastmod: daily });
    for (const h of DATE_HUBS) out.push({ path: `${base}/${h}`, lastmod: daily });
    out.push({ path: `${base}/past`, lastmod: changed }, { path: `${base}/search`, lastmod: changed });
    // Category and area pages are listed only while they have something on them.
    for (const c of categories) {
      const latest = await listEvents({ cityId: city.id, categoryId: c.id, limit: 1 });
      if (latest.length) out.push({ path: `${base}/${c.slug}`, lastmod: changed });
    }
    for (const a of await areasWithEvents(city.id)) out.push({ path: `${base}/area/${a.slug}`, lastmod: changed });
  }
  return out;
}

async function pageEntries(): Promise<SitemapEntry[]> {
  const latest = new Date(`${changelog[0]?.date ?? "2026-11-18"}T00:00:00Z`);
  return [
    ...["/about", "/how-we-verify", "/corrections", "/changelog"].map((path) => ({ path, lastmod: latest, oneLanguage: true })),
    // The AI citation tracker (Prompt 8) is in both languages and changes weekly.
    { path: "/ai-citations", lastmod: (await getPool().query<{ at: Date | null }>("SELECT max(imported_at) AS at FROM citation_runs")).rows[0].at ?? latest },
  ];
}

export async function sitemapEntries(type: SitemapType, now = new Date()): Promise<SitemapEntry[]> {
  if (type === "hubs") return hubEntries(now);
  if (type === "pages") return pageEntries();
  return sitemapRows(type);
}
