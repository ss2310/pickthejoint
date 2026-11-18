import { aiCrawlers, site } from "@/config";

// Everything is open to every crawler. The AI crawlers are also named one by
// one, so their access never depends on how a vendor reads the "*" group.
export const dynamic = "force-static";

export function GET(): Response {
  const lines = [
    "User-agent: *",
    "Allow: /",
    "",
    ...aiCrawlers.flatMap((c) => [`User-agent: ${c.token}`, "Allow: /", ""]),
    `Sitemap: ${site.url}/sitemap.xml`,
    "",
  ];
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
