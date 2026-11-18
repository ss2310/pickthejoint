import { SITEMAP_TYPES, indexXml, sitemapEntries } from "@/lib/sitemap";

// Sitemap index: one child sitemap per page type, each dated by its newest entry.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const now = new Date();
  const entries = [];
  for (const type of SITEMAP_TYPES) {
    const rows = await sitemapEntries(type, now);
    if (rows.length === 0) continue;
    entries.push({ path: `/sitemaps/${type}.xml`, lastmod: rows.reduce((max, r) => (r.lastmod > max ? r.lastmod : max), rows[0].lastmod) });
  }
  return new Response(indexXml(entries), { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600" } });
}
