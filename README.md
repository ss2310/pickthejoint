# Pick the Joint

Events discovery site for Indian cities (pickthejoint.com). Project rules live in `CLAUDE.md`.

## Local setup
1. Postgres 16 running locally, with databases `ptj` and `ptj_test`.
2. `cp .env.example .env.local` and adjust.
3. `npm install`
4. `set -a && . ./.env.local && set +a`
5. `npm run db:migrate && npm run db:seed`
6. `npm run dev` and open http://localhost:3000/indore

## Commands
- `npm test` — migrations, seed, budget guard and handle import tests (uses `TEST_DATABASE_URL`, wipes it)
- `npm run import:handles -- data/handles.csv [--dry-run]` — CSV columns `handle,type,city,tier`
- `npm run job:ingest -- [--dry-run] [--batch] [--handles a,b --force] [--sources instagram,google,news,web,facebook,facebook-posts,discovery,artists] [--force] [--max-items 5] [--process-only]` — scrape due handles, fetch the other sources, then filter, extract, match and publish (`--force` without `--handles` ignores the weekly schedule of the Prompt 9 sources; `--max-items` caps new items per source, for checks)
- `npm run job:housekeeping -- [--dry-run] [--retier] [--coverage]` — mark finished events as happened, link the census and series, re-tier handles (first of the month), store the weekly coverage report (Mondays) and print the daily report
- `npm run census -- --city indore [--dry-run] [--csv places.csv]` — venue census from OpenStreetMap (free), plus places from a CSV
- `npm run job:enrich -- [--dry-run] [--types venue,artist,organiser] [--limit 5] [--slugs a,b]` — fill in venue, artist and organiser pages from public sources (weekly)
- `npm run translate:backfill -- [--dry-run] [--batch] [--limit 200]` — translate public text that has no Hindi yet, or whose English has changed
- `npm run typecheck`, `npm run lint`, `npm run build`

## Layout
- `src/config/index.ts` — models per tier, Apify actor IDs, budget caps, locales, AI crawler list
- `src/lib/budget-guard.ts` — every paid call goes through `guardedCall`
- `db/migrations/` — plain SQL, applied in order by `scripts/migrate.ts`
- `db/seed.ts` — cities, areas, categories (idempotent)
- `src/lib/pipeline/` — ingestion: `scrape` (Apify), `filter` (keyword rules, then fast model), `extract` (poster reading), `resolve` (matching, dedup, review queue), `write` (descriptions), `sources` (Google results, news roundups), `housekeeping`, `enrich` and `research` (entity pages)
- `scripts/jobs/` — entry points for the Railway cron services
- `docs/sources.md` — what each source costs and which are switched on

## Railway
Railway does not read a config file for this service. These are set on the `web` service itself: pre-deploy command `npm run railway:release` (migrations, seed, and a one-time load of `data/handles-indore.csv` while the handles table is empty), start command `npm start`, health check path `/indore`.
Set `DATABASE_URL` to the Railway Postgres reference variable on the web service.

Scheduled jobs run as separate Railway cron services from the same repo, with the same variables as `web` and no pre-deploy command:
- ingest, daily: start command `npm run job:ingest -- --batch`
- housekeeping, daily: start command `npm run job:housekeeping`
- enrich, weekly: start command `npm run job:enrich`

## Wider sourcing (Prompt 9)
What each source is, its cost, and its terms and robots.txt findings: `docs/sources.md`. Per-city source lists (census area, hashtags, web calendars): `data/sourcing.json`. Festival series: `data/series.json`.
- **Venue census** (`src/lib/pipeline/census.ts`, table `venue_census`, admin only): OpenStreetMap places, every listed venue, Instagram location tags from discovery, and places added by hand. A census row is linked to a venue with the same name; a place gets a public page only once it has a published event. `/admin/venues` lists places with no Instagram handle on record and places with no event in 60 days, and starts tracking a handle in one click.
- **Handle tiers** (`tiering.ts`): on the first of each month housekeeping makes a handle tier A when it produced 2 or more events in 30 days (up to the per-city cap) and tier B otherwise, and pauses one with no event in 90 days. Handles younger than 30 days and tiers set by hand in the last 30 days are left alone. Changes are logged in `handle_changes` and shown at `/admin/handles`. A suggested handle credited in 3 or more event posts is offered at tier A.
- **Snowball discovery** (`discovery.ts`): accounts tagged, mentioned or credited in event posts keep going to `suggested_handles` (with `event_posts` and `via`); a weekly, capped hashtag pull adds the accounts and location tags it sees. Nothing from it is published.
- **Web calendars** (`calendars.ts`): listings read from their schema.org Event data, sitemap-driven pages and single pages read as text, at most every few days, robots.txt checked each run. Items are stored as `raw_posts` with `source_kind = 'web'` and go through the same matching, dedup and confidence rules.
- **Facebook events** (`facebook.ts`): pages in `facebook_pages` (from Facebook links on venue and organiser pages, or added at `/admin/coverage`), read weekly, logged out, through Apify; `source_kind = 'facebook'`.
- **Facebook page posts** (`facebook-posts.ts`, added 19 Nov 2026): most pages announce events in ordinary posts and flyers, not through Facebook's Events feature, so the newest posts of the same pages are read too (`--sources facebook-posts`), logged out, through `apify/facebook-posts-scraper`. Tier A pages are read every two days, B weekly, C every two weeks, 2 to 3 posts a check, and only posts newer than the last check are asked for; a page with 12 posts read and no event among them drops to the tier C pace by itself. Posts from statewide or national pages are kept only when they name the city. New posts are stored as `source_kind = 'facebook'` with shortcode `fbp:<post id>` and go through the same filter, poster reading, dedup and publishing rules as Instagram posts. **Off until `FACEBOOK_POSTS=on` is set on the job service.** Monthly limit `FACEBOOK_POSTS_BUDGET_USD` (default $10, scrape budget); reaching it stops this source only, not the job. The starting list is `data/facebook-pages-indore.csv` (120 pages the owner supplied), loaded by `npm run import:facebook-pages` on every release without overwriting tiers or switches changed at `/admin/coverage`, where more pages can be pasted in, one link per line.
- **Two sources:** an event confirmed by a second, independent source gets +0.1 confidence and the event page lists every source.
- **Festival series** (`series.ts`): seeded from `data/series.json` with sources; an event attaches when its title has a series alias as whole words and it falls in one of the series' months.
- **Outreach** (`/admin/outreach`, CSV at `/admin/outreach/export`): organisers and venues with events, page URL, public contact on record, and a plain "Listed on Pick the Joint" link per row.
- **Coverage report** (`src/lib/coverage.ts`, `/admin/coverage`): per city and IST week, events published by the source that found them first, the share also found by a second source, new venues, census places and handles, and cost per published event by source (scraping from `cost_log`, model spend recorded per item in `raw_posts.model_usd`). Housekeeping stores last week's report every Monday.

## AI citation tracker (Prompt 8)
- **Questions:** `data/citation-queries.json` holds the fixed, owner-approved questions (15 English and 15 Hindi for Indore). The seed loads them into `citation_queries`; a question removed from the file is switched off, never deleted. Do not reword a question: a changed question is a new one and breaks the week-on-week comparison.
- **Weekly run (owner's computer):** the owner's GeoGrid tool asks the questions to ChatGPT and Perplexity (through DataForSEO), Gemini (OpenRouter) and Google AI Overviews, the same sources and routes as GeoGrid's probe. Nothing in GeoGrid changes and its keys stay in GeoGrid's `.env`. From this folder: `"<GeoGrid>\.venv\Scripts\python" scripts\citations\geogrid_run.py --geogrid "<GeoGrid>" --dry-run`, then the same with `--max-cost 3`. It writes `citation-runs/<run id>.json` (git-ignored). About $1.80 a run at most; GeoGrid reuses answers asked in the last 7 days. `/admin/citations` shows the exact commands with the remaining budget as `--max-cost`.
- **Import:** upload the file at `/admin/citations`. Each answer is judged there (`src/lib/citations.ts`): cited when a pickthejoint.com page is among its sources (or written into the text), named when the text names the site, and which listing sites (District, BookMyShow and others in `src/config/index.ts`) it cited. A check with no answer (no AI Overview shown, an error) is kept but left out of the share. Each run is imported once; its cost goes into `cost_log` under the `citations` sub-budget (`CITATIONS_BUDGET_USD`, default 10 a month, inside the scrape budget). A later run in the same week replaces that week's rows.
- **By hand:** the same page records a check for engines with no automated route (Copilot, Claude) with a screenshot link, and the weekly Bing Webmaster Tools AI Performance and Search Console figures, typed or from a CSV export with a Date column (summed into weeks).
- **Weekly figures:** weeks are IST Monday to Sunday. AI crawler visits come from `crawler_log`; live events, venues and artists are snapshotted into `weekly_snapshots` by housekeeping every day (and on import), since they cannot be worked out afterwards.
- **Public page:** `/ai-citations` and `/hi/ai-citations`, server-rendered, in the sitemap and the footer: the share cited per engine per week, crawler visits and listings per week, the method and the questions. Answer texts and screenshots stay in the admin area.

## Natural-language search (Prompt 7)
- **Where:** a search box on each city home and on `/{city}/search` (and `/hi/...`). It is a plain GET form (`?q=...`); the page shows the normal results for the filters the query was read into, a one-line restatement of how it was read, and the ordinary filter form set to that reading. Search pages with a query are `noindex`.
- **Reading a query** (`src/lib/search.ts`): rules first, for date words, category and area names, prices and filler in English, Hindi and Hinglish (with area and city names taken from the database, Hindi names from `translations`). Up to two unknown words are taken as search words. Anything else goes to the cache of earlier model readings (`search_parse_cache`, 30 days), then to one fast-tier call that sees only the query and the list of valid values and must answer with those values; search words it returns are kept only if they are words of the query. Dates are cached as relative words ("this saturday"), never as calendar dates.
- **Limits:** model readings per hashed address (20 an hour, 60 a day), the `search` sub-budget (`SEARCH_BUDGET_USD`, default 3 a month, inside the model budget) and a daily cap (`SEARCH_DAILY_BUDGET_USD`, default 0.25, per UTC day; the budget guard now supports daily caps for any sub-budget). Crawlers never trigger a model call. When a limit is hit, or the model fails, the search quietly uses what the rules understood plus the remaining words as search words (any of them may match).
- **Search words** use Postgres full-text search over the event's title and description and the names of its venue (with address), area, performers and organisers, matching word starts; Devanagari words are looked for in the Hindi text. When the words match nothing but the other filters do, those events are shown with a line saying so.
- **Log and admin view:** every query is written to `search_log` (the query, its normalised form, the page language, how it was read, the result count and the model cost; nothing about the visitor). `/admin/search` lists the most common queries, those whose last search found nothing, the latest searches with how each was read, and today's and the month's search spend.

## Submissions and the admin area (Prompt 6)
- **Add an event** (`/submit`, `/hi/submit`): a plain HTML form with a hidden honeypot field, Cloudflare Turnstile and per-address rate limits (`src/lib/security.ts`). Form state lives in a draft row reached by a random token, so errors come back with the fields filled. The submitter's name and contact are stored in `submissions.submitter` and never shown.
- **Snap a poster**: the photo is checked from its bytes (JPEG, PNG, WebP; 8 MB), turned upright, shrunk and re-encoded with sharp, which drops all metadata including location (`src/lib/posters.ts`). It is read by the same vision extraction as Instagram posters and prefills the form. Photos are stored privately in `poster_images` (Postgres), shown only in the admin area, and deleted by housekeeping the day after the event (unsent drafts after 2 days).
- **Pre-screening** (`src/lib/submissions.ts`): completeness, plausible date, duplicate of a listed event, spam signs by rule, and a fast-tier model check (escalated once to the mid tier when unsure). Everything goes to `review_queue` with the notes; nothing is published until approved. Public submissions are charged to the `submissions` sub-budget (`SUBMISSIONS_BUDGET_USD`, default 3).
- **Approval** creates the event with origin `submitted` through the ingestion pipeline's own venue, performer and organiser matching, writes the description and publishes it. The page names the source: "Submitted by the organiser" (form) or "Submitted poster" (no image).
- **Admin** (`/admin`, English only, `noindex`, never cached, outside the language middleware): review queue with approve, edit and reject; poster inbox (several photos at once, read after the response); suggested handles and the handle list; spend against each cap by service, model and job; last run of each job; cancel, take down or restore an event with a recorded reason (`event_actions`).
- **Admin login** (`src/lib/admin-auth.ts`): one account, scrypt hash in `admin_account`, sessions stored as SHA-256 hashes of a random cookie (HttpOnly, Secure, SameSite=Strict, 12 hours), failed sign-ins limited per address. The password is set once at `/admin/setup?token=…` with `ADMIN_SETUP_TOKEN`; the page locks itself afterwards.
- **Poster email**: Resend inbound posts `email.received` to `/api/inbound/poster-email`. The Svix signature is checked, only `POSTER_EMAIL_SENDERS` (default `CONTACT_EMAIL`) with SPF or DKIM passing are read, each email is handled once, and image attachments go into the poster inbox.

## Hindi (Prompt 5)
English lives at the plain paths; Hindi lives under `/hi/` with the same paths.
- **Routing:** every page sits under `src/app/[locale]/`. Middleware serves a plain path from `/en/...` without changing the address, sends a typed `/en/...` to the plain path, and leaves `/hi/...` alone. Sitemaps, `robots.txt` and files have no language.
- **Interface text:** `src/locales/en.ts` and `src/locales/hi.ts` hold every word the site itself says, including the sentences of hub summaries and FAQs. A page calls `setLocale` first; components read the language with `getLocale()` and `messages()` (`src/lib/locale.ts`). Use the `Link` from `src/components/ui.tsx` for links inside the site so they stay in the reader's language.
- **Stored text:** Hindi for events, venues, artists, organisers, series, areas and cities is in the `translations` table. Queries read it for Hindi pages and fall back to English, field by field, when a translation is missing or the English has changed since.
- **When text is translated:** never on page load. `src/lib/pipeline/translate.ts` runs at the end of the ingest and enrich jobs when `TRANSLATION=on` is set on those services, and on demand with `npm run translate:backfill`. Names are written in Devanagari as they sound and go first, so longer texts reuse the same spellings. Cost goes to the `translation` sub-budget (`TRANSLATION_BUDGET_USD`, default 5 a month).
- **Search engines:** each page names its other-language version (`hreflang` en-IN, hi-IN and x-default) in its head and in the sitemaps.
- **Not translated yet:** the about, how-we-verify, corrections and changelog pages are English only; their `/hi/` addresses redirect to the English page.
- **Fonts:** the three font files are in `src/fonts` and referenced from `globals.css`, so a build needs no network. `next/font/google` failed intermittently at build time and is not used.

## Entity enrichment (Prompt 4)
The weekly `enrich` job works through venues, artists and organisers flagged `needs_enrichment`, most-referenced first, until its per-run budget is used.
- **Where facts come from:** the entity's own Instagram bio (read through Apify, scrape budget), then research by the mid-tier model with Anthropic's web search and web fetch tools (`enrichment` sub-budget inside the model budget; `ENRICHMENT_BUDGET_USD`, default 20 a month, a quarter of it per run).
- **What is kept:** a fact is accepted only if its source is a page the research tools really returned. A fact resting on one weak source (listing sites, pages anyone can edit: the list is in `src/config/index.ts`) is left out; two weak sources that agree are accepted. Facts the model is unsure of go to `review_queue` as `entity_fact`. Private facts about people are dropped and never stored.
- **What is stored:** every accepted fact is a row in `entity_sources` with its source address, and the page lists its sources with what each was used for. The page text is written from the accepted facts only.
- **When there is too little:** an artist or organiser with fewer than two facts keeps its `noindex` stub page. An entity we cannot tell apart from a namesake goes to review and is not retried.
- **Maps:** a venue that gains an address is sent to the geocoder again.
- **One-off runs:** set `ENRICH_ARGS` on the service (for example `--types venue --limit 5`, or `--slugs ohlio` to redo one page) for a single run, then remove it.

## Indexing, trust and alerts (Prompt 3b)
- **IndexNow:** the key file is `public/d632b94e7b1106de3376c2c8b5b6b82b.txt`. Both jobs ping IndexNow with the pages that changed, when `INDEXNOW=on`.
- **Crawl access check:** housekeeping requests five page types as each AI crawler every Monday and alerts on any block. Run it at once with `npm run job:housekeeping -- --crawl-check`, or set `CRAWL_CHECK=now` on the service.
- **Event images:** `/{city}/events/{slug}/image/1x1`, `/4x3` and `/16x9` are generated on the server; posters are never rehosted.
- **Feeds:** `/{city}/feed.ics`, `/{city}/feed.json`, and `/{city}/events/{slug}/calendar.ics`.
- **Geocoding:** housekeeping looks up a few venues a day on OpenStreetMap's Nominatim; doubtful matches go to the review queue.
- **Alerts:** a failed job, a run that unexpectedly finds no events, or a blocked crawler sends an email through Resend (`RESEND_API_KEY`, `ALERT_FROM`, `ALERT_TO`). Without those the alert is written to the job log. To test, set `FAIL_ON_PURPOSE=housekeeping` (or `ingest`) on the service for one run.
- **Fallback actor:** if the Instagram actor fails twice in a row, the run uses `APIFY_IG_POSTS_FALLBACK_ACTOR_ID` when it is set.
- **Legal drafts:** `docs/legal/` holds an unpublished privacy policy and terms for review.

## Artist tracking and official video (Prompt 10)

- **Who is tracked:** artists with a published event in one of our cities in the next 30 days, until 7 days after their last one, plus artists pinned at `/admin/artists`. At most `ARTIST_TRACKING_MAX` (default 40), pinned first. Nothing is stored about who is tracked: it is worked out on each run (`trackedArtists` in `src/lib/pipeline/artist-tracking.ts`).
- **What tracking does** (`--sources artists`, part of the daily `ingest` job; each artist is due every 3 days): the artist's newest Instagram posts (3 at most, only those newer than the last check) are sorted by the fast model into *new show*, *change to a show*, *new release* or *other*. An unsure answer gets one second opinion from the mid tier; if still unsure the post is ignored.
  - A new show or a change goes into `raw_posts` as an event post, so extraction, the city check, confidence and dedup apply exactly as for any Instagram post. It is filed under the city of the artist's nearest event.
  - A new release gets one line in our own words from the mid tier (only when the post states the title), shown on the artist page with its date and a link to the post.
  - Everything else is ignored. General posts are never rewritten as news and nothing about private life is published. `artist_posts` keeps each post's link, label and reason, never the post itself.
  - An artist whose account is already read as a handle is not paid for twice; an artist with no Instagram account on record cannot be tracked until one is added on the admin page.
- **Official video** (`src/lib/pipeline/youtube.ts`): through the YouTube Data API (`YOUTUBE_API_KEY`, free quota), the artist's official channel is found from the YouTube link on their page, or by a name search that must match the artist's own name. Up to 5 of the channel's most-viewed public, embeddable videos (Shorts and live streams left out) are stored as *pending* with a one-sentence note written by the mid tier from YouTube's own facts. **Nothing shows until approved at `/admin/artists`.** At most 10 artists a run, 2 searches each, of the 100 searches a day the free quota allows.
- **Pages:** an artist page gains "Latest releases", "Official videos" (YouTube's own player in an iframe with `loading="lazy"`, no script of ours, title, year and the note as plain text beside it) and "Shows by city" (every listed event of theirs, city by city, with venue and date). An event page shows 1 to 2 of each performer's approved videos under "Get to know …". Release lines and video notes are translated into Hindi with the rest.
- **Limits:** `ARTIST_TRACKING_BUDGET_USD` (default $5 a month, scrape) and `ARTIST_TEXT_BUDGET_USD` (default $3, model). Reaching the first stops tracking only, not the job. `ARTIST_TRACKING=off` switches it all off.
