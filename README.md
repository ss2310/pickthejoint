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
- `npm run typecheck`, `npm run lint`, `npm run build`

## Layout
- `src/config/index.ts` — models per tier, Apify actor IDs, budget caps, locales, AI crawler list
- `src/lib/budget-guard.ts` — every paid call goes through `guardedCall`
- `db/migrations/` — plain SQL, applied in order by `scripts/migrate.ts`
- `db/seed.ts` — cities, areas, categories (idempotent)
- `src/lib/pipeline/` — ingestion: `scrape` (Apify), `filter` (keyword rules, then fast model), `extract` (poster reading), `resolve` (matching, dedup, review queue), `write` (descriptions), `sources` (Google results, news roundups), `housekeeping`
- `scripts/jobs/` — entry points for the Railway cron services
- `docs/sources.md` — what each source costs and which are switched on

## Railway
Railway does not read a config file for this service. These are set on the `web` service itself: pre-deploy command `npm run railway:release` (migrations, seed, and a one-time load of `data/handles-indore.csv` while the handles table is empty), start command `npm start`, health check path `/indore`.
Set `DATABASE_URL` to the Railway Postgres reference variable on the web service.

Scheduled jobs run as separate Railway cron services from the same repo, with the same variables as `web` and no pre-deploy command:
- ingest, daily: start command `npm run job:ingest -- --batch`
- housekeeping, daily: start command `npm run job:housekeeping`

## Indexing, trust and alerts (Prompt 3b)
- **IndexNow:** the key file is `public/d632b94e7b1106de3376c2c8b5b6b82b.txt`. Both jobs ping IndexNow with the pages that changed, when `INDEXNOW=on`.
- **Crawl access check:** housekeeping requests five page types as each AI crawler every Monday and alerts on any block. Run it at once with `npm run job:housekeeping -- --crawl-check`, or set `CRAWL_CHECK=now` on the service.
- **Event images:** `/{city}/events/{slug}/image/1x1`, `/4x3` and `/16x9` are generated on the server; posters are never rehosted.
- **Feeds:** `/{city}/feed.ics`, `/{city}/feed.json`, and `/{city}/events/{slug}/calendar.ics`.
- **Geocoding:** housekeeping looks up a few venues a day on OpenStreetMap's Nominatim; doubtful matches go to the review queue.
- **Alerts:** a failed job, a run that unexpectedly finds no events, or a blocked crawler sends an email through Resend (`RESEND_API_KEY`, `ALERT_FROM`, `ALERT_TO`). Without those the alert is written to the job log. To test, set `FAIL_ON_PURPOSE=housekeeping` (or `ingest`) on the service for one run.
- **Fallback actor:** if the Instagram actor fails twice in a row, the run uses `APIFY_IG_POSTS_FALLBACK_ACTOR_ID` when it is set.
- **Legal drafts:** `docs/legal/` holds an unpublished privacy policy and terms for review.
