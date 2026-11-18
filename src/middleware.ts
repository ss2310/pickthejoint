import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { aiCrawlers, defaultLocale, locales } from "@/config";
import { CHECK_HEADER } from "@/lib/crawl-check";
import { getPool } from "@/lib/db";

/**
 * Two jobs.
 *
 * 1. Languages. English lives at the plain paths and Hindi under /hi/. Inside
 *    the app every page sits under a [locale] segment, so a plain path is
 *    served from /en/... without the address changing, and a typed /en/...
 *    address is sent to the plain one so no page has two English addresses.
 *
 * 2. Records visits from the AI crawlers named in config: which agent, which
 *    path, when. Nothing is recorded about anyone else, and nothing beyond those
 *    three facts is recorded about the crawlers (no IP address, no headers).
 */
export const config = {
  runtime: "nodejs",
  // The admin area and the API are English-only and private: no language handling, no crawler log, and
  // large uploads to them are not buffered by middleware.
  matcher: ["/((?!_next/|favicon.ico|admin(?:/|$)|api/).*)"],
};

/** Addresses that have no language: sitemaps, robots.txt and files served from the public folder. */
const NO_LOCALE = /^\/(admin(?:\/|$)|api\/|robots\.txt|sitemap\.xml|sitemaps\/|[^/]+\.(?:txt|svg|png|ico|xml|webmanifest)$)/;
/** Pages written in English only. Their /hi/ addresses go to the English page. */
const ENGLISH_ONLY = /^\/(about|how-we-verify|corrections|changelog)\/?$/;

export function crawlerToken(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  // Longest token first, so "Applebot-Extended" is not recorded as "Applebot".
  const match = [...aiCrawlers].sort((a, b) => b.token.length - a.token.length).find((c) => ua.includes(c.token.toLowerCase()));
  return match?.token ?? null;
}

/** What to do with a path: serve as is, serve from another internal path, or send the visitor elsewhere. */
export function route(pathname: string): { action: "next" } | { action: "rewrite" | "redirect"; to: string } {
  if (NO_LOCALE.test(pathname)) return { action: "next" };
  const first = pathname.split("/")[1] ?? "";
  if (first === defaultLocale) return { action: "redirect", to: pathname.slice(defaultLocale.length + 1) || "/" };
  if ((locales as readonly string[]).includes(first)) {
    const rest = pathname.slice(first.length + 1) || "/";
    return ENGLISH_ONLY.test(rest) ? { action: "redirect", to: rest } : { action: "next" };
  }
  return { action: "rewrite", to: `/${defaultLocale}${pathname === "/" ? "" : pathname}` };
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
  const r = route(req.nextUrl.pathname);
  if (r.action === "next") return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = r.to;
  return r.action === "redirect" ? NextResponse.redirect(url, 308) : NextResponse.rewrite(url);
}
