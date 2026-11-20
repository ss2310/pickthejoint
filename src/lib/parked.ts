/**
 * Which public pages go stale while the project is parked (PARKED=true, see
 * PARKED.md). Those carry `X-Robots-Tag: noindex` so search engines and AI
 * assistants stop showing listings that are no longer kept up to date.
 *
 * Pages that stay true without fresh listings (venues, artists, organisers,
 * series, the past-events archive, published weekly guides and the editorial
 * pages) stay indexable, so a restart does not begin from nothing. robots.txt
 * keeps allowing crawlers on purpose: a crawler that robots.txt turns away
 * never fetches the page, so it would never see the noindex.
 *
 * Event pages are decided by the page itself (only events not yet over get
 * noindex), because the path alone does not say when the event is.
 */
import { locales } from "@/config";

/** First path segments that are not a city. */
const NOT_A_CITY = new Set(["about", "how-we-verify", "corrections", "changelog", "ai-citations", "submit", "artists", "organisers", "series"]);

export function staleWhileParked(pathname: string): boolean {
  let parts = pathname.split("/").filter(Boolean);
  if (parts.length && (locales as readonly string[]).includes(parts[0])) parts = parts.slice(1);
  if (parts.length === 0) return true; // site home: lists what is on
  if (parts[0] === "submit") return true; // the form is closed while parked
  if (NOT_A_CITY.has(parts[0])) return false;
  // From here the first segment is a city.
  if (parts.length === 1) return true; // city home
  const [, second] = parts;
  if (second === "past") return false;
  if (second === "venues") return false;
  if (second === "events") return false; // decided on the page
  if (second === "guide") return parts.length === 2; // the guide index points at "this week"; published guides are an archive
  // Date hubs, categories, areas, search and feeds.
  return true;
}
