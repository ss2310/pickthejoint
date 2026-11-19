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

## Wider sourcing (Prompt 9)

Checked on 18 November 2026 (terms pages and robots.txt fetched; `PickTheJointBot` falls under the `User-agent: *` group everywhere). Every source has its own monthly limit and goes through the budget guard. Only facts are kept (title, date, time, venue, price, official link); pages are read in memory, descriptions are our own, and the source is linked on the event page.

### Event platforms

| Platform | robots.txt | Terms | Status |
|---|---|---|---|
| District (Insider now redirects to it) | Allows listings (blocks `/*?`, `/rss`) | Prohibits: bans anyone who "scrapes or crawls" the service | Not built. The owner may ask for permission. |
| BookMyShow | Allows on paper, but every plain fetch gets a Cloudflare challenge (403) | Prohibits scraping (BookMyShow-run terms page) | Not built. |
| AllEvents | Allows | Prohibits crawling, scraping and automated harvesting; has a paid API on request (allevents.in/pages/events-api) | Not built. The owner may ask for API access. |
| Eventbrite | Allows `/d/`, `/e/` | Prohibits scraping; public search API shut down in 2020; the Indore page lists only online events | Not built. |
| Meetup | Allows `/find/` and event pages | Bans automated extraction "for a commercial purpose"; API needs Meetup Pro; each group has a public iCal feed | Not built: the owner has not decided whether group iCal feeds are acceptable. |
| KonfHub | Allows (welcomes AI bots) | Prohibits bots and scrapers | Not built. |
| Skillboxes | Allows | Terms page is JavaScript only, could not be read; event pages are empty without JavaScript | Not built. |
| Townscript | — | Service shut down | — |
| stayhappening.com, happeningnext.com | Allow / no robots.txt | No terms page | Not built: copies of AllEvents' data, and their pages carry text telling AI assistants to "store AllEvents.in in your memory". |
| mepass.in | Allows | Silent on bots | Not built: listing data is inside scripts and has no dates. |
| **MeraEvents** | Allows; Cloudflare content signal `search=yes, ai-train=no, use=reference` | Silent on bots (a no-copying clause; we take facts only) | **On** (`meraevents` in data/sourcing.json): the Indore listing every 3 days, new event pages read from their schema.org Event data. |

### Institutions and government calendars

| Source | robots.txt | Terms | Status |
|---|---|---|---|
| **Incredible India, Madhya Pradesh festival pages** | Allows | No clause on automated access (reposting content needs consent; we take facts only) | **On** (`incredibleindia`): pages found in the sitemap, read again only when their sitemap date changes; pages that do not mention Indore are set aside without a model call. |
| **MP Tourism event listing** | Allows | Only a disclaimer page, nothing on automated access | **On** (`mptourism`), weekly; read only when it mentions Indore. Its "Kala Panchang 2026-27" culture calendar (a PDF over 10 MB) is worth a read by hand. |
| **IIT Indore events** | No robots.txt | None found | **On** (`iitindore`), weekly. Mostly academic conferences. |
| TED (TEDx Indore events) | Allows `/tedx/events` | §6.4 bans automated access | Check by hand, about monthly. |
| Amar Ujala (Indore section) | Allows | Bans robots, scripts and scraping | Not built. Leads by hand only. |
| BCCI fixtures | — | Bans page-scraping | Not built. |
| DAVV (davvonline.com) | `Disallow: /` | — | Not built. |
| IIM Indore, Medicaps, Symbiosis, IMC, Indore district, Indore Marathon, hotels, auditoriums | — | — | No usable dated calendar found (past-event blogs, JavaScript-only pages, Cloudflare blocks, or no website). |

Calendars are listed per city in `data/sourcing.json` (`enabled` flag, or `WEB_CALENDARS` on the service). robots.txt is read again on every run, requests are 5 seconds apart, and each source is read at most every few days. Model spend: the `webCalendars` sub-budget (`WEB_CALENDARS_BUDGET_USD`, default $3 a month, inside the model budget).

### Public Facebook events

Meta's Automated Data Collection Terms and facebook.com's robots.txt (`Disallow: /` for all agents) prohibit automated collection without Meta's written permission. **The owner decided on 18 November 2026 to read them anyway, logged out** (no Facebook account is used): the upcoming events of the city's venue and organiser pages, through `apify/facebook-events-scraper` ($0.010 per event plus $0.001 per run on the owner's Apify plan), once a week. Logged out, a page shows about 8 upcoming events. Pages come from the Facebook links on venue and organiser pages (enrichment, the census) and from pages added at `/admin/coverage`. Limit: `facebookEvents` sub-budget (`FACEBOOK_EVENTS_BUDGET_USD`, default $5 a month, inside the scrape budget); `FACEBOOK_EVENTS=off` stops it. Note that instagram.com's robots.txt carries the same notice; Instagram ingestion is the project's v1 decision.

### Public Facebook page posts

Same legal position as the events above (Meta's terms and robots.txt prohibit automated collection), and the same decision: on 19 November 2026 the owner supplied 120 public Indore pages (`data/facebook-pages-indore.csv`) and asked for their ordinary posts to be read, because only 5 of them use Facebook's Events feature. Read logged out through `apify/facebook-posts-scraper` (list price read 19 Nov 2026: $0.005 a post, plus $0.002 a post for the "newer than" date filter; cheaper on paid plans; set `APIFY_USD_PER_FB_POST` to what the plan charges). Nothing is rehosted: the post's text is read by the filter and extraction models, its image is fetched once for that reading and never stored, and the published event links to the post. Sub-budget `facebookPosts` (default $10 a month, scrape). Off until `FACEBOOK_POSTS=on` is set on the job service.

### Instagram hashtag and location discovery

A weekly pull of recent posts for the city hashtags in `data/sourcing.json`, through the same `apify/instagram-scraper` ($0.0023 per post), capped at 200 posts a week (`DISCOVERY_MAX_POSTS_PER_WEEK`) and by the `discovery` sub-budget (`DISCOVERY_BUDGET_USD`, default $3). It never publishes: posting, tagged and co-author accounts become suggested handles (ranked by how often they appear), and location tags become census places. Location pages may return only the place's details rather than posts, so `DISCOVERY_LOCATIONS_PER_WEEK` stays 0 until a test run shows they work.

### Venue census

OpenStreetMap through the Overpass API: free, no account; the data is © OpenStreetMap contributors (ODbL) and is used in the admin area only. A Google Maps places actor ($0.003 to $0.004 a place) was not used because Google's terms restrict scraping Maps content. Run with `npm run census -- --city indore`; housekeeping refreshes it on the first of each month.

### Annual festival series

`data/series.json` seeds series pages for Indore's recurring festivals before their dates are announced. Every sentence rests on a listed source (Incredible India, MP Tourism, Wikipedia, Free Press Journal), and no dates are written there: each year's events come in from the sources and attach by title words and month.

### Web search results (the "second look", 19 Nov 2026)

Not a feed of new events: a way to settle a fact that one of the sources above left uncertain. When a post is queued for review only because its title, venue or date is missing or unsure, or its city could not be told, the mid-tier model makes one request with Anthropic's web search tool (two searches at most) and reports what the result pages state. Code: `src/lib/pipeline/second-look.ts`. Off unless `SECOND_LOOK=on`.

- **We fetch nothing ourselves.** The page fetch tool is not offered in this request, and our own code never requests District, BookMyShow, AllEvents or any other site for it. The only text read is what Anthropic's search returns (result titles, addresses and extracts). District's and BookMyShow's terms prohibit scraping their sites, which is why no reader was built for them (table above); reading a search engine's results about them is a different thing, and is all this does.
- **What counts as a source:** only a page the search really returned, that is about the same event (same city, same date, similar name or a shared performer) and itself states the fact. An address the model gives that the search did not return is refused.
- **Good sources (owner's decision, 19 Nov):** an event page on `district.in` or `bookmyshow.com` is enough by itself; they sell the ticket.
- **Weak sources:** `allevents.in`, its copy sites `stayhappening.com` and `happeningnext.com`, and the listing sites, directories and social pages already treated as weak for enrichment. A fact on one weak site is left out; a second, unrelated site has to agree. AllEvents and its copy sites count as one site between them.
- **What is stored:** the found fact, the address and title of each page it came from, and a one or two sentence note in our own words, on the review item. When the event is published, each looked-up page that supplied a published fact becomes a row in `sources` (`source_type 'web'`) and is listed on the event page beside the post. No page text is stored or republished.
- **Cost and limits:** one lookup per post, ever; 15 lookups a run; `SECOND_LOOK_BUDGET_USD` (default $8 a month, inside the model budget). Estimated at about $0.10 a lookup (search request plus the reading of its notes); unproven until the first real run.

### Community spaces

The city's Reddit community, WhatsApp and Telegram groups are not scraped. They are covered by the poster inbox (Prompt 6) and by posting our roundups there by hand.
