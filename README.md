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
- `npm run job:ingest -- [--dry-run] [--batch] [--handles a,b --force] [--sources instagram,google,news] [--process-only]` — scrape due handles, fetch the other sources, then filter, extract, match and publish
- `npm run job:housekeeping -- [--dry-run]` — mark finished events as happened and print the daily report
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
