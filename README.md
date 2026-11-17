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
- `npm run typecheck`, `npm run lint`, `npm run build`

## Layout
- `src/config/index.ts` — models per tier, Apify actor IDs, budget caps, locales, AI crawler list
- `src/lib/budget-guard.ts` — every paid call goes through `guardedCall`
- `db/migrations/` — plain SQL, applied in order by `scripts/migrate.ts`
- `db/seed.ts` — cities, areas, categories (idempotent)

## Railway
`railway.json` runs migrations and the seed before each deploy, then `npm start`.
Set `DATABASE_URL` to the Railway Postgres reference variable on the web service.
