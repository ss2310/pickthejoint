# Handoff: where the build stands

Written 18 November 2026, at the end of the session that built Prompts 2, 3 and 3b. Read this with `CLAUDE.md` (project rules) and `README.md` (commands and layout). The owner works prompt by prompt from a numbered prompt file (Prompts 1 to 12) and pastes each prompt into chat; each prompt ends with checks that must be run before moving on.

## Status

| Prompt | State |
|---|---|
| 1 Foundation and data model | Live |
| 2 Ingestion pipeline | Live. First production run on 18 Nov: 107 posts, 20 events published, about $0.97 |
| 3 Public pages | Live at pickthejoint.com |
| 3b Indexing, crawl access, trust | Live. One check outstanding: the job alert email (needs Resend settings, see below) |
| 4 Entity enrichment | **Next** |
| 5 to 12 | Not started |

Production currently shows 13 Indore events.

## Production setup (Railway project "melodious-love")

- `web`: the Next.js site. Pre-deploy `npm run railway:release` (migrations, seed, one-time handle load). Deploys from `main`.
- `ingest`: cron `30 0 * * *` (06:00 IST), `npm run job:ingest -- --batch`.
- `housekeeping`: cron `0 19 * * *` (00:30 IST), `npm run job:housekeeping`.
- `Postgres`.
- All three services redeploy on every merge to `main`. Job services take their secrets by reference from `web`.
- Deploy settings and variables live on the services, not in a file.

**To run a job once:** change its cron schedule to a few minutes ahead, redeploy the service, wait for the run, read the service's deploy logs for the report JSON, then set the schedule back and redeploy. Schedule changes only take effect after a redeploy. Runs start a minute or two after the scheduled minute.

**Do not read Railway variable values** (they include API keys). Variable names are safe to list.

## This machine

- Repo: `C:\Users\Utsav Goyal\Documents\Pick The Joint` (`ss2310/pickthejoint`).
- No Postgres, Docker or Railway CLI is installed. Tests need a Postgres at `TEST_DATABASE_URL`. A throwaway one can be run with the `embedded-postgres` npm package from a scratch folder; create its databases with `ENCODING 'UTF8' TEMPLATE template0` (the Windows default encoding rejects the rupee sign). The previous session ran one on port 54329 with databases `ptj` and `ptj_test`; it does not survive a reboot.
- `.env.local` (git-ignored) holds real keys for local paid runs. Run jobs locally with `npx tsx --env-file=.env.local scripts/jobs/ingest.ts ...` and set `DATABASE_URL` in the shell first, because the file's own `DATABASE_URL` is not usable locally.
- `npm run db:dev-seed` loads made-up demo listings into a local database for page work.
- Shell heredocs mangle backslashes on this machine. Write files with the editor tools, or put edit scripts in a file and run them.

## Decisions the owner has made

- **Handles:** 34 active Indore handles (14 tier A). Switched off: 7 the scraping actor cannot read (restricted venue accounts), 4 stale, and 5 national listing accounts. The owner will add more later.
- **Scraping actor:** `apify/instagram-scraper`, billed at $0.0023 per result on their plan. Failed lookups are charged too.
- **Reel transcripts:** off (14 requested in the first run, none filled a missing fact). The actor `steadyfetch/instagram-reel-transcript-scraper` is mapped if they are turned back on.
- **Google event results:** off. Google removed its Events tab; the one test returned nothing.
- **News:** Free Press Journal and Patrika are on. Dainik Bhaskar and Naidunia forbid automated collection and must not be added.
- **Design:** approved. One stylesheet, system fonts, no client scripts of our own.
- **Contact address:** utsav@themaskedmarketers.us (set as `CONTACT_EMAIL` on `web`).
- **About page:** the site "does not currently take payment for listings".
- **Email service:** Resend.
- **Old site URLs:** none to redirect. Sitemaps are already submitted to Bing and Google.

## Things learned the hard way

- **City check:** listing accounts post about every city. Extraction now returns each event's city and only events in the handle's city are published. Six out-of-city events had been published before this existed; an audit unpublished them.
- **Duplicate venues:** "Ohlio" and "Ohlio Gourmet Cafebar" were stored as two venues. A name that is another name plus trailing words now matches, and housekeeping merges duplicates daily.
- **Collab posts:** a post on a handle's profile can be owned by another account. It is filed under the profile it was fetched from.
- **Description writer** sometimes says a fact is missing ("No ticket price has been provided") despite being told not to. Worth tightening in `src/lib/pipeline/write.ts`.

## Prompt 3b check results (18 Nov, live site)

- **Crawl access:** 17 crawler agents, 85 requests, none blocked.
- **IndexNow:** first ping sent 55 URLs and was accepted. Key file: `public/d632b94e7b1106de3376c2c8b5b6b82b.txt`.
- **Rich Results Test:** three event pages tested in Google's tool; each showed valid Events, Breadcrumbs and Organisation items. Remaining warnings are optional fields the source did not state (`offers`, `endDate`, `organizer`).
- **Geocoding:** 11 venues tried, 1 located, 10 not found. OpenStreetMap has thin coverage of Indore venues by name. Prompt 4 enrichment should supply addresses, which geocode far better than names; consider retrying a venue once it has an address (`geocoded_at` currently stops any retry).
- **Alert email: not yet proven.** Needs `RESEND_API_KEY` and `ALERT_FROM` (an address on a domain verified in Resend) on the `ingest` and `housekeeping` services. Then set `FAIL_ON_PURPOSE=housekeeping` for one run to confirm the email arrives, and remove it.

## Waiting on the owner

- Resend key and sending address (above).
- `SITE_PROFILES`: URLs of Pick the Joint's own Instagram, YouTube, X and Facebook profiles, for `sameAs`.
- Who runs the site (name or company) for the about page, and whose name to use as editor on roundups and guides.
- Approval of the draft privacy policy and terms in `docs/legal/` before they are published.

## Not built yet that later prompts assume

- No admin area. 19 review-queue items and about 108 suggested handles are waiting, visible only in the database (Prompt 6).
- No read access to the production database from this machine. Checks so far used job reports in Railway logs and the public site.

## Next: Prompt 4 (entity enrichment)

Ask the owner to paste Prompt 4 if it is not in the chat. In outline: a weekly job that fills in venue, artist and organiser pages from public sources, within a per-run budget through the budget guard, with every fact stored against its source URL in `entity_sources`, own-words writing, professional public facts only, doubtful items to the review queue. Its checks: enrich 5 venues and 5 artists from live data, show the pages and sources, report cost per entity.

Before building, tell the owner the plan for where facts come from. The mid-tier Claude model with the web search tool is the obvious route, and its per-search cost must go through the budget guard under a new sub-budget.
