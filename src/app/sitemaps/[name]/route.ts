import { SITEMAP_TYPES, sitemapEntries, urlsetXml, type SitemapType } from "@/lib/sitemap";

// /sitemaps/events.xml, /sitemaps/venues.xml and so on.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  const type = (await params).name.replace(/\.xml$/, "") as SitemapType;
  if (!SITEMAP_TYPES.includes(type)) return new Response("Not found", { status: 404 });
  return new Response(urlsetXml(await sitemapEntries(type)), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600" },
  });
}
