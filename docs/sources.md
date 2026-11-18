# Event sources: what was checked and what is switched on

Checked on 18 November 2026. Re-check before switching a source on or adding a city.

## Instagram (Apify)
- Handles come from `handles` (loaded once from `data/handles-indore.csv`). Tier A is checked daily, tier B weekly, 3 latest posts each.
- Actor: set `APIFY_IG_POSTS_ACTOR_ID` (or `APIFY_ACTOR_ID`). Input and output are mapped for `apify/instagram-post-scraper` and `apify/instagram-scraper`.
- List price on Apify's free plan: $0.0017 per post (post scraper, basic data) or $0.0027 per result (instagram-scraper). Config assumes $0.0027; set `APIFY_USD_PER_POST` to match your actor and plan.
- Reel transcripts: set `APIFY_REEL_TRANSCRIPT_ACTOR_ID` (or `APIFY_TRANSCRIPT_ACTOR_ID`). In use: `steadyfetch/instagram-reel-transcript-scraper`, about $0.015 per reel delivered (nothing charged for a reel with no speech and no on-screen text); it also returns text shown on screen, which is passed to extraction with the speech. Inputs are also mapped for `apify/instagram-reel-scraper` and for actors that take `bulkUrls`. Set `APIFY_USD_PER_TRANSCRIPT` if the price changes.
- Five national listing accounts (BookMyShow, AllEvents, SortMyScene, Skillbox, District) were switched off on 18 November 2026 (migration 005): they post about every city, and six events from elsewhere had been published as Indore events before the city check existed.
- Eleven handles from the starting list were switched off on 18 November 2026 (migration 003): seven the actor cannot read (restricted or not found) and four that had not posted for months.

## Google event results
- Google removed its separate Events tab, and DataForSEO retired its Google Events API on 15 September 2026. What remains is the "events" block inside a normal Google results page.
- The job reads that block through DataForSEO's Google organic live endpoint: $0.002 per query, 5 queries per city per day (about $0.30 a month per city). Needs `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`; without them the source is skipped.
- The block carries a title, a one-line snippet (date, time, venue) and a link. How often Google shows it for Indore queries is not yet measured.
- Serper has no events endpoint and its sample responses show no events block, so it is not used.

## Local news roundups
robots.txt allows a generic bot on the Indore section of all four papers. Their terms differ:

| Paper | Terms | Status |
|---|---|---|
| Dainik Bhaskar | Explicitly bans robots, scripts and automated collection | Not built. Do not add. |
| Naidunia | Bans extraction tools and systematically building a database | Not built. Do not add. |
| Free Press Journal | No scraping clause; a blanket notice against downloading or storing the site without permission | On in production since 18 November 2026 (owner's decision). |
| Patrika | No scraping clause; content for personal, non-commercial use | On in production since 18 November 2026 (owner's decision). Its section page lists few articles without JavaScript, so expect little. |

- Switched on with `NEWS_SOURCES=fpj,patrika` on the `ingest` service; remove a key to switch that paper off. robots.txt is re-read on every run and a disallowed page is skipped.
- Behaviour when on: one section page and at most 3 roundup articles per paper per day, 5 seconds between requests, identified as `PickTheJointBot`. Article text is read in memory for fact extraction and is never stored or published; only the headline, link and extracted facts are kept.
