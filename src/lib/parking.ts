/**
 * Parked mode for the public site (PARKED.md, config `parking`).
 *
 * While parked nothing new is read, so listing pages (what is on today, this
 * weekend, in a category or an area) go stale. Those pages are sent with a
 * noindex header and left out of the sitemap, so search engines and AI
 * assistants stop showing them as current. Pages that stay true are left
 * indexable: an event, venue, artist, organiser or series page states dated
 * facts with their sources, and the archive of past events is history.
 *
 * robots.txt is not changed: a crawler that is disallowed never sees the
 * noindex header, and a disallowed address can stay listed without its text.
 */

/** First path segments that are not a city. */
const NOT_A_CITY = new Set([
  "about", "ai-citations", "artists", "changelog", "corrections", "how-we-verify", "organisers", "series", "submit",
  "sitemaps", "admin", "api",
]);

/** Pages under a city that stay indexable while parked. */
const STAYS_TRUE = new Set(["events", "venues", "past", "feed.ics", "feed.json"]);

/** The language prefixes that can lead a path ("/hi/indore/today"). */
const LOCALE_PREFIX = /^\/(?:en|hi)(?=\/|$)/;

/**
 * True for a public listing page that goes stale while parked: the home page,
 * a city home, today / this weekend / this week, a category, an area, search,
 * and the weekly guides. Paths may carry a language prefix.
 */
export function goesStale(pathname: string): boolean {
  const segs = pathname.replace(LOCALE_PREFIX, "").split("/").filter(Boolean);
  if (segs.length === 0) return true; // the home page sends visitors to the city home
  if (NOT_A_CITY.has(segs[0]) || segs[0].includes(".")) return false;
  if (segs.length === 1) return true; // city home
  const [, section] = segs;
  if (STAYS_TRUE.has(section)) return false;
  if (section === "area" || section === "guide" || section === "search") return true;
  return segs.length === 2; // today, this-weekend, this-week or a category
}

/** The header sent with a stale page while parked. */
export const PARKED_ROBOTS_HEADER = { name: "X-Robots-Tag", value: "noindex" } as const;
