# Handoff: where the build stands

Written 18 November 2026, at the end of the session that built Prompts 2, 3 and 3b, and updated the same day after Prompts 4 and 5 and a redesign. Read this with `CLAUDE.md` (project rules) and `README.md` (commands and layout). The owner works prompt by prompt from a numbered prompt file (Prompts 1 to 15). **The text of every prompt not yet built is in `docs/build-prompts.md`**, so there is no need to ask for it. Each prompt ends with checks that must be run and shown before moving on.

**Working rule from the owner (18 Nov):** at most two prompts per session. After the second prompt's checks, update this file and start a new session for the next prompt.

## Status

| Prompt | State |
|---|---|
| 1 Foundation and data model | Live |
| 2 Ingestion pipeline | Live. First production run on 18 Nov: 107 posts, 20 events published, about $0.97 |
| 3 Public pages | Live at pickthejoint.com |
| 3b Indexing, crawl access, trust | Live. One check outstanding: the job alert email (needs Resend settings, see below) |
| 4 Entity enrichment | Live. First production run on 18 Nov: see "Prompt 4 check results" below |
| Redesign (owner's request, not a numbered prompt) | Live. Colourful hero band, a colour per category, card listings, self-hosted fonts |
| 5 Hindi | Live under `/hi/`. Backfill run on 18 Nov: see "Prompt 5 check results" below |
| 6 Submissions and admin area | **Next** |
| 7 to 15 | Not started. Text in `docs/build-prompts.md` |

Production currently shows 13 Indore events.

## Production setup (Railway project "melodious-love")

- `web`: the Next.js site. Pre-deploy `npm run railway:release` (migrations, seed, one-time handle load). Deploys from `main`.
- `ingest`: cron `30 0 * * *` (06:00 IST), `npm run job:ingest -- --batch`.
- `housekeeping`: cron `0 19 * * *` (00:30 IST), `npm run job:housekeeping`.
- `enrich`: cron `30 20 * * 0` (Monday 02:00 IST), `npm run job:enrich`. Created for Prompt 4. Its variables are references to `web` (and to `ingest` for `APIFY_USD_PER_POST`), plus `ENRICHMENT_BUDGET_USD=20`, `INDEXNOW=on` and `TRANSLATION=on`. It is also the service used for one-off scripts (see below).
- `TRANSLATION=on` is set on `ingest` and `enrich`, so text they create or change is translated into Hindi at the end of each run.
- `Postgres`.
- All four services redeploy on every merge to `main`. Job services take their secrets by reference from `web`.
- Deploy settings and variables live on the services, not in a file.

**To run a job once:** change its cron schedule to a few minutes ahead, then make the service build again, wait for the run, read the service's deploy logs for the report JSON, then set the schedule back. Schedule and start-command changes only take effect on a new build: the Railway `redeploy` tool reuses the previous deployment's settings (on 18 Nov it ran the old start command and spent $1.21 on an enrichment run nobody asked for). Use `connect-service-source` with the same repo and branch to force a fresh build. Runs start a minute or two after the scheduled minute.

**To run a one-off script on production** (for example `npm run translate:backfill -- --dry-run`): set it as the `enrich` service's start command with a schedule a few minutes ahead, force a fresh build as above, read the logs, then put back `npm run job:enrich` and `30 20 * * 0`.

**To run enrichment once on chosen pages:** set `ENRICH_ARGS` on the `enrich` service (for example `--types venue --limit 5`, or `--slugs ohlio,fabric` to redo pages that were already enriched), run it once as above, then delete `ENRICH_ARGS` so the weekly run goes back to its defaults.

**Do not read Railway variable values** (they include API keys). Variable names are safe to list.

## This machine

- Repo: `C:\Users\Utsav Goyal\Documents\Pick The Joint` (`ss2310/pickthejoint`).
- No Postgres, Docker or Railway CLI is installed. Tests need a Postgres at `TEST_DATABASE_URL`. A throwaway one can be run with the `embedded-postgres` npm package from a scratch folder; create its databases with `ENCODING 'UTF8' TEMPLATE template0` (the Windows default encoding rejects the rupee sign). The previous session ran one on port 54329 with databases `ptj` and `ptj_test` (user and password both `ptj`); it does not survive a reboot. The `TEST_DATABASE_URL` in `.env.local` points at port 5432 and does not work: pass `TEST_DATABASE_URL=postgres://ptj:ptj@localhost:54329/ptj_test` in the shell when running `npx vitest run`.
- `.env.local` (git-ignored) holds real keys for local paid runs. Run jobs locally with `npx tsx --env-file=.env.local scripts/jobs/ingest.ts ...` and set `DATABASE_URL` in the shell first, because the file's own `DATABASE_URL` is not usable locally.
- `npm run db:dev-seed` loads made-up demo listings into a local database for page work.
- Shell heredocs mangle backslashes and can break on quotes and backticks on this machine. Write files with the editor tools, or put edit scripts in a file and run them.

## Decisions the owner has made

- **Handles:** 34 active Indore handles (14 tier A). Switched off: 7 the scraping actor cannot read (restricted venue accounts), 4 stale, and 5 national listing accounts. The owner will add more later.
- **Scraping actor:** `apify/instagram-scraper`, billed at $0.0023 per result on their plan. Failed lookups are charged too.
- **Reel transcripts:** off (14 requested in the first run, none filled a missing fact). The actor `steadyfetch/instagram-reel-transcript-scraper` is mapped if they are turned back on.
- **Google event results:** off. Google removed its Events tab; the one test returned nothing.
- **News:** Free Press Journal and Patrika are on. Dainik Bhaskar and Naidunia forbid automated collection and must not be added.
- **Design:** replaced on 18 Nov at the owner's request ("the website looks very dated"). Still one stylesheet and no client scripts of our own. Fonts are Bricolage Grotesque (headings), DM Sans (text) and Noto Sans Devanagari (Hindi), stored as files in `src/fonts` because fetching them from Google at build time failed intermittently. The generated event share images (`/image/1x1` and so on) still use the old colours.
- **Contact address:** utsav@themaskedmarketers.us (set as `CONTACT_EMAIL` on `web`).
- **About page:** the site "does not currently take payment for listings".
- **Email service:** Resend.
- **Old site URLs:** none to redirect. Sitemaps are already submitted to Bing and Google.
- **Hindi (Prompt 5):** English at plain paths, Hindi under `/hi/`. Translation by the mid-tier model into the `translations` table when text is created or changed, never on page load. Monthly limit $5 (`TRANSLATION_BUDGET_USD`) inside the model budget. The about, how-we-verify, corrections and changelog pages are English only for now; their `/hi/` addresses redirect.
- **Enrichment (Prompt 4):** facts come from the entity's own Instagram bio (Apify) and from the mid-tier model with Anthropic's web search and web fetch tools. Monthly limit $20 inside the model budget, a quarter of it per weekly run. The owner approved the new `enrich` Railway service.

## Things learned the hard way

- **City check:** listing accounts post about every city. Extraction now returns each event's city and only events in the handle's city are published. Six out-of-city events had been published before this existed; an audit unpublished them.
- **Duplicate venues:** "Ohlio" and "Ohlio Gourmet Cafebar" were stored as two venues. A name that is another name plus trailing words now matches, and housekeeping merges duplicates daily.
- **Collab posts:** a post on a handle's profile can be owned by another account. It is filed under the profile it was fetched from.
- **Description writer** sometimes says a fact is missing ("No ticket price has been provided") despite being told not to. Worth tightening in `src/lib/pipeline/write.ts`.

- **Enrichment, paused turns:** a research request with web search can stop with `pause_turn` and continue in the next response. The notes are everything written after the last tool call across all of those responses; keeping only the last response loses most of them and makes every entity look unidentifiable.
- **Enrichment, identity:** the researcher was at first too ready to call an identity uncertain (for instance when two listing sites gave different addresses). The prompts now separate "which venue or performer is this" from doubt about one detail.
- **Enrichment, venues without a website:** a venue known only from listing sites (Zomato, Justdial, Tripadvisor, magicpin) yields little: those are weak sources, so a fact needs two of them to agree, and conflicting addresses go to review.

## Prompt 3b check results (18 Nov, live site)

- **Crawl access:** 17 crawler agents, 85 requests, none blocked.
- **IndexNow:** first ping sent 55 URLs and was accepted. Key file: `public/d632b94e7b1106de3376c2c8b5b6b82b.txt`.
- **Rich Results Test:** three event pages tested in Google's tool; each showed valid Events, Breadcrumbs and Organisation items. Remaining warnings are optional fields the source did not state (`offers`, `endDate`, `organizer`).
- **Geocoding:** 11 venues tried, 1 located, 10 not found. OpenStreetMap has thin coverage of Indore venues by name. Since Prompt 4, a venue that gains an address is tried again (enrichment clears `geocoded_at`), by name and then by address; a match on the address alone goes to the review queue, never straight to the page.
- **Alert email: not yet proven.** Needs `RESEND_API_KEY` and `ALERT_FROM` (an address on a domain verified in Resend) on the `ingest` and `housekeeping` services. Then set `FAIL_ON_PURPOSE=housekeeping` for one run to confirm the email arrives, and remove it.

## Waiting on the owner

- Resend key and sending address (above).
- `SITE_PROFILES`: URLs of Pick the Joint's own Instagram, YouTube, X and Facebook profiles, for `sameAs`.
- Who runs the site (name or company) for the about page, and whose name to use as editor on roundups and guides.
- Approval of the draft privacy policy and terms in `docs/legal/` before they are published.

## Not built yet that later prompts assume

- No admin area. 19 review-queue items and about 108 suggested handles are waiting, visible only in the database (Prompt 6). Enrichment adds `entity_fact` items (unsure facts, identities it could not confirm, text it could not write).
- Enrichment is tried once per entity. Nothing yet re-flags an entity for a fresh look (for example after a year, or when it gains more events); set `needs_enrichment = true` or use `--slugs`.
- Enriched text is English only; Hindi comes with the translation prompt.
- No read access to the production database from this machine. Checks so far used job reports in Railway logs and the public site.

## Prompt 4 check results (18 Nov, live site)

Two runs of the `enrich` job on production, 22 entity runs in all (Ohlio was run twice).

| Run | Entities | Cost | Per entity |
|---|---|---|---|
| 1 (5 venues, 5 artists) | 10 | $1.74 | $0.17 |
| 2 (6 venues, 6 artists) | 12 | $2.01 | $0.17 |

Per entity the cost ranged from $0.09 to $0.27: research with web search is about 90% of it, reading the notes into facts about $0.01 to $0.02, writing the text under $0.01, the Instagram bio $0.0023.

- **Venues (11 tried): 9 filled in, 2 sent to review.** Filled in: MARQ Indore, Skydeck (Berlin Haus de Gourmet), Ohlio, Atelier V, Brilliant Convention Centre, The Piano Project (area and Facebook link only), Labhganga Exhibition Centre, Romeo Lane Indore. Saket Club and Fabric could not be told apart from namesakes and are in the review queue.
- **Artists (11 tried): 4 filled in, 2 sent to review, 5 not found.** Filled in: Major Minor, The Yellow Diary, Esani Dey, Sumit Gupta. Chitralekha and one other are in review. Tanisha, U4ria and three of Kvanh, Gopa Kumar, Lobo Miro and DANIQ returned nothing reliable and stay `noindex` stubs. Single-name DJs and local acts with no press are the usual misses.
- No artist page got a "Notable work" list yet: the researcher named works but rarely gave a direct link on an official platform, so they went into the text instead.
- Fixed after run 1: `tripadvisor.in` and `tripadvisor.com` were counted as two sources; text hedged and padded.
- Worth a look in a later pass: Ohlio's text gives the venue's phone numbers (from its own Instagram bio); Brilliant Convention Centre's text mentions one dated event; "Sumit Gupta" is a business speaker filed as an artist because the pipeline files every named participant as one.
- The identities and facts in review cannot be read from this machine (no production database access); they wait for the admin area.
- `ENRICH_ARGS` on the service is set to an empty value (the tools here cannot delete a variable); it has no effect and can be deleted in the Railway dashboard.

## Prompt 5 check results (18 Nov, live site)

RESULTS_PLACEHOLDER

## Next: Prompt 6

The text is in `docs/build-prompts.md`. It needs, before building: a Cloudflare Turnstile site key and secret (the owner created them in Section B setup; check the variable names on `web`), and a decision on where submitted poster images are stored privately (Railway has no object storage in this project yet; ask the owner before adding a paid service). Prompt 6 is the first to add an admin login, which later prompts (7 to 15) all build on.
