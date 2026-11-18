import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { aiCrawlers } from "@/config";
import { CHECK_HEADER } from "@/lib/crawl-check";
import { getPool } from "@/lib/db";

/**
 * Records visits from the AI crawlers named in config: which agent, which
 * path, when. Nothing is recorded about anyone else, and nothing beyond those
 * three facts is recorded about the crawlers (no IP address, no headers).
 */
export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/|favicon.ico).*)"],
};

export function crawlerToken(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  // Longest token first, so "Applebot-Extended" is not recorded as "Applebot".
  const match = [...aiCrawlers].sort((a, b) => b.token.length - a.token.length).find((c) => ua.includes(c.token.toLowerCase()));
  return match?.token ?? null;
}

export function middleware(req: NextRequest, event: NextFetchEvent) {
  const agent = crawlerToken(req.headers.get("user-agent"));
  if (agent && !req.headers.has(CHECK_HEADER)) {
    event.waitUntil(
      getPool()
        .query("INSERT INTO crawler_log (agent, path) VALUES ($1, $2)", [agent, req.nextUrl.pathname.slice(0, 500)])
        .catch((err) => console.error(`[crawler-log] ${(err as Error).message}`)),
    );
  }
  return NextResponse.next();
}
