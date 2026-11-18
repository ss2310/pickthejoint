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
