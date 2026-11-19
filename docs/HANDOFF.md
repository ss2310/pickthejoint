# Handoff: where the build stands

Written 18 November 2026, at the end of the session that built Prompts 2, 3 and 3b, and updated the same day after Prompts 4 and 5, a redesign, Prompts 6, 7 and 8, and Prompt 9. Read this with `CLAUDE.md` (project rules) and `README.md` (commands and layout). The owner works prompt by prompt from a numbered prompt file (Prompts 1 to 15). **The text of every prompt not yet built is in `docs/build-prompts.md`**, so there is no need to ask for it. Each prompt ends with checks that must be run and shown before moving on.

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
| 6 Submissions and admin area | Live. Checks run on 18 Nov: see "Prompt 6 check results" below. Poster email built but waits on the owner's Resend setup |
| 7 Natural-language search | Live. Checks run on 18 Nov: see "Prompt 7 check results" below |
| 8 Citation tracker | Live. Baseline week recorded on 18 Nov: see "Prompt 8 check results" below |
| Second look (owner's decisions of 19 Nov, not a numbered prompt) | Live but **switched off**. Run once on production on 19 Nov (1 merged, 3 lookups found nothing, $0.39). Daily running (`SECOND_LOOK=on` on `ingest`) is the owner's later call. See "Second look" below |
| 9 Wider sourcing | Live. Built on 18 Nov at the owner's request before the week of cost data ("start now anyway"). See "Prompt 9 check results" below |
| Facebook page posts (owner's request of 19 Nov, not a numbered prompt) | Live (PR #34). The owner saw the dry-run cost and had it switched on: `FACEBOOK_POSTS=on` was set on `ingest` on 19 Nov, so the first real run is the 06:00 IST job of 20 Nov (00:30 UTC). Not yet confirmed: notes written later on 19 Nov still called it off, and its month spend was $0 before that run; that run's report shows a \`facebookPosts\` section if it is on. See "Facebook page posts" below |
| 10 Artist tracking and official video | Live: PR #35 merged and deployed on 20 Nov (migration 013 ran on `web`). The owner has decided to build 10 to 15 now without waiting for cost data. See "Prompt 10" below for what is checked and what waits |
| 11 Practical facts and weekly roundups | Live: PR #38 merged on 20 Nov (migration 016 ran on `web`), with the urgent extraction fix PR #39 the same night. Checks run on production. See "Prompt 11" below |
| 12 to 15 | Not started; to be built next, two per session. Text in `docs/build-prompts.md` |

Production showed 13 Indore events before Prompt 6; one approved submission has been added since.

## Production setup (Railway project "melodious-love")

- `web`: the Next.js site. Pre-deploy `npm run railway:release` (migrations, seed, one-time handle load). Deploys from `main`.
- `ingest`: cron `30 0 * * *` (06:00 IST), `npm run job:ingest -- --batch`. Since Prompt 9 its default sources also include the web calendars (every 3 to 7 days), public Facebook events and the hashtag discovery pull (weekly); each skips itself when not due.
- `housekeeping` also links the venue census and festival series daily, re-tiers handles and refreshes the OpenStreetMap census on the 1st of each month, and stores the weekly coverage report on Mondays.
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

**The admin area** is at `https://pickthejoint.com/admin` (one account, the owner's). Since Prompt 6 the review queue, suggested handles, spend and job reports can be read there instead of in the database or job logs: ask the owner to sign in in the app's built-in browser pane and drive it there. The password was set on 18 Nov through `/admin/setup` with `ADMIN_SETUP_TOKEN`; to replace it, set `ADMIN_SETUP_TOKEN` again plus `ADMIN_RESET=on` on `web`, use the setup page, then delete both.

**Cloudflare Turnstile and the browsers:** the check never passes in the app's built-in browser (it keeps asking for a tick that does not take). In the owner's own Chrome (Claude in Chrome) it usually passes on its own and sometimes needs the owner to tick it; Claude must not tick it. Public form checks therefore run in Chrome, and admin work in the built-in pane where the owner is signed in.

## This machine

- Repo: `C:\Users\Utsav Goyal\Documents\Pick The Joint` (`ss2310/pickthejoint`).
- No Postgres, Docker or Railway CLI is installed. Tests need a Postgres at `TEST_DATABASE_URL`. A throwaway one can be run with the `embedded-postgres` npm package from a scratch folder; create its databases with `ENCODING 'UTF8' TEMPLATE template0` (the Windows default encoding rejects the rupee sign). The previous session ran one on port 54329 with databases `ptj` and `ptj_test` (user and password both `ptj`); it does not survive a reboot. The `TEST_DATABASE_URL` in `.env.local` points at port 5432 and does not work: pass `TEST_DATABASE_URL=postgres://ptj:ptj@localhost:54329/ptj_test` in the shell when running `npx vitest run`.
- `.env.local` (git-ignored) holds real keys for local paid runs. Run jobs locally with `npx tsx --env-file=.env.local scripts/jobs/ingest.ts ...` and set `DATABASE_URL` in the shell first, because the file's own `DATABASE_URL` is not usable locally.
- `npm run db:dev-seed` loads made-up demo listings into a local database for page work.
- Shell heredocs mangle backslashes and can break on quotes and backticks on this machine. Write files with the editor tools, or put edit scripts in a file and run them.
- Model calls fail locally unless `ANTHROPIC_API_KEY` is set; the submission code is built to carry on without them (the submission still reaches the queue, a poster that cannot be read leaves the form for the sender to fill in), which is also how a local run of the admin area behaves.
- When a command chains tests and a merge, gate the merge on the test command's exit code, not on grepping its summary: on 18 Nov a run with 4 failed tests (a one-off under machine load; three later runs passed) went on to merge PR #21.

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
- **Submissions (Prompt 6), decided 18 Nov:** poster photos are stored privately in Postgres (`poster_images`, as cleaned JPEG bytes; no new service) and deleted the day after the event, or within 2 to 7 days when unused. The owner wants the poster email address through Resend inbound (built; waits on setup, below). The admin password is set by the owner on `/admin/setup` with a token from a Railway variable, never in chat. Public poster reading and screening have their own monthly limit, `SUBMISSIONS_BUDGET_USD` (default $3), inside the model budget. `sharp` became a direct dependency (it was already installed through Next.js; no account).
- **AI citation checks (Prompt 8), decided 18 Nov:** the owner chose to reuse their GeoGrid tool (`C:\Users\Utsav Goyal\Documents\Joe Roofer Enrichment`), run from their own computer, with all four engines (ChatGPT and Perplexity through DataForSEO, Gemini through OpenRouter, Google AI Overviews: the same sources and routes as GeoGrid's probe), and approved the 30 questions in `data/citation-queries.json`. About $1.35 to $1.80 a run from GeoGrid's existing balances, logged under `CITATIONS_BUDGET_USD` (default $10 a month, scrape budget). GeoGrid itself is not changed and its keys never reach Pick the Joint. The geo-service "probe" (Railway project "Dashboard") could not be reused as is: it asks niche questions about one business and checks for a business name, not our questions and cited domains.
- **Search (Prompt 7), built 18 Nov:** rules first, the fast tier only for queries the rules cannot read. Limits: 20 model readings an hour and 60 a day per hashed address; `SEARCH_BUDGET_USD` (default $3 a month) and `SEARCH_DAILY_BUDGET_USD` (default $0.25 a UTC day), both inside the model budget and both unset on `web` (defaults apply). Crawlers never trigger a model call. Past a limit the search quietly uses keywords.
- **Wider sourcing (Prompt 9), decided 18 Nov:** the owner approved the plan (venue census from OpenStreetMap rather than Google Maps; web calendars only where terms and robots.txt allow: MeraEvents, Incredible India, MP Tourism, IIT Indore; Meetup off until decided) and added **public Facebook events, read logged out through Apify**, although Meta's terms and robots.txt prohibit automated collection (owner: "If my facebook profile does not gets logged in i think facebook events can be added"). Monthly limits: discovery $3 and Facebook $5 (scrape), web calendars and Facebook reading $3 (model). District, BookMyShow, AllEvents, Eventbrite, KonfHub, TED, Amar Ujala and BCCI forbid automated collection and are not built; the terms findings for every source are in `docs/sources.md`.
- **Second look, decided 19 Nov ("Yes, all four"):** (1) a fact found on a District or BookMyShow page counts as well sourced; AllEvents and its copy sites (stayhappening.com, happeningnext.com) are weak, so a fact from them needs a second site to agree; we never fetch any of these sites, the text comes only from Anthropic's web search results. (2) $8 a month inside the model budget (`SECOND_LOOK_BUDGET_USD`), at most 15 lookups a run, one lookup per post ever; the owner was told $0.05 to $0.10 a lookup, unproven until a real run. (3) "Click first": a found fact waits in the review queue for one click and does not publish by itself; `SECOND_LOOK_PUBLISH=on` (off) allows that later. (4) The lookup may settle an unsure title as well as the venue, the date and "could not tell whether the event is in the city". Also agreed: the free check against our own listings comes first; past events, possible duplicates, unmatched cancellations and failed extractions are skipped; the whole feature is off by default; there is a dry-run mode; nothing paid runs and nothing is switched on in production without the owner's yes.
- **Enrichment (Prompt 4):** facts come from the entity's own Instagram bio (Apify) and from the mid-tier model with Anthropic's web search and web fetch tools. Monthly limit $20 inside the model budget, a quarter of it per weekly run. The owner approved the new `enrich` Railway service.

## Things learned the hard way

- **City check:** listing accounts post about every city. Extraction now returns each event's city and only events in the handle's city are published. Six out-of-city events had been published before this existed; an audit unpublished them.
- **Duplicate venues:** "Ohlio" and "Ohlio Gourmet Cafebar" were stored as two venues. A name that is another name plus trailing words now matches, and housekeeping merges duplicates daily.
- **Collab posts:** a post on a handle's profile can be owned by another account. It is filed under the profile it was fetched from.
- **Description writer** sometimes says a fact is missing ("No ticket price has been provided") despite being told not to. Since PR #32 such sentences are dropped before publishing (`dropMissingFactSentences` in `src/lib/pipeline/write.ts`); older descriptions keep them.

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

- **Prompt 9:** (1) approve or dismiss the suggested handles at `/admin/handles` (now with how often and where each was seen), and start tracking venue handles at `/admin/venues`; the handle list is still the main limit on coverage. (2) Facebook pages: done on 19 Nov (120 supplied; see "Facebook page posts" below). (3) Decide whether Meetup group iCal feeds are acceptable. District has been written to; the AllEvents API request is drafted but not known to be sent. (4) Review the 8 IIT Indore conferences and the MeraEvents possible duplicate in the review queue.
- **Facebook page posts:** after the first real run (20 Nov), compare its cost with the Apify console and set `APIFY_USD_PER_FB_POST` if the plan charges less than $0.007 a post; look at `pagesWithNothing` in the run report for pages the scraper could not read.
- **Prompt 11:** (1) read the Indore guide draft for week 47 at `/admin/roundups` (both languages) and publish it if it reads well. (2) Each Thursday from then on: read that week's draft there and publish it.
- **Prompt 10:** (1) add `YOUTUBE_API_KEY` on `web` in Railway (steps were given on 19 Nov), then a reference to it on `ingest`. (2) At `/admin/artists`: add Instagram accounts for tracked artists that have none, check each suggested YouTube channel is the artist's own, and approve or reject the videos.

- Resend key and sending address (above).
- `SITE_PROFILES`: URLs of Pick the Joint's own Instagram, YouTube, X and Facebook profiles, for `sameAs`.
- Who runs the site (name or company) for the about page, and whose name to use as editor on roundups and guides.
- Approval of the draft privacy policy and terms in `docs/legal/` before they are published. They should now mention submissions: the submitter's name and contact are kept privately, and poster photos are stored privately and deleted after the event.
- **Poster email (Prompt 6):** in Resend, turn on receiving (the ready-made `…resend.app` address works without DNS, or add the MX record for a subdomain such as `posters.pickthejoint.com`), create a webhook for `email.received` pointing at `https://pickthejoint.com/api/inbound/poster-email`, and set on `web`: `RESEND_INBOUND_WEBHOOK_SECRET` (the webhook's signing secret), `RESEND_API_KEY`, and optionally `POSTER_EMAIL_SENDERS` (default: `CONTACT_EMAIL` only). Then forward one poster to test it.
- **Who sent it:** an approved form submission always shows "Submitted by the organiser", but the form does not ask whether the sender is the organiser (the live check event was sent by us). Decide whether to add an "I am the organiser" box, with "Submitted by a reader" otherwise.
- **Delete `ADMIN_SETUP_TOKEN`** from `web` if it is still there (the setup page is locked once a password exists, but the variable is no longer needed).

## Not built yet that later prompts assume

- The admin area (Prompt 6) shows `entity_fact` items from enrichment, but approving one only marks it reviewed: nothing yet writes an approved fact onto the page or re-runs the entity. Geocoder matches, queued posts, events and submissions are fully handled from the queue.
- Approved submissions are translated into Hindi by the next `ingest` run (06:00 IST); until then their Hindi page shows the English text.
- Cancelling or taking down an event in the admin area rebuilds the site's own pages at once, but does not purge Cloudflare's cache or ping IndexNow.
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

- **Backfill dry run on production:** 131 items waiting (35 areas, 37 venue fields, 27 event fields, 22 artist fields, 8 organiser fields, the city name and state), 7 requests, estimated $0.14. The owner approved the real run.
- **Backfill run:** 131 translated, 0 failed, $0.13 (translation sub-budget, $5 a month). `TRANSLATION=on` is now set on `ingest` and `enrich`, so new text is translated at the end of each run.
- **Pages checked on the live site:** three event pages (`/hi/indore/events/stylista-winter-and-wedding-exhibition-2026-12-19`, `.../tie-global-summit-2026-indore-2026-12-14`, `.../the-bar-takeover-2026-11-28`), the Hindi city home `/hi/indore`, a venue and an artist page. Titles, venues, areas, descriptions, interface text and dates are in Hindi; hreflang links both ways; sitemaps list both languages.
- **One bad translation found and fixed:** an event title came back as "...इंडिया टour" (a word half in Latin letters). Since PR #17 such translations are refused and any stored one is redone by the next run.
- **Not Hindi's fault:** the English description writer sometimes says a fact is missing ("No ticket price has been provided"), and the Hindi carries that over. Fixed for new text in PR #32 (see "Things learned the hard way").
- **Times** show as "8:00 pm" on Hindi pages (the platform's Hindi formatting); acceptable, but could become "रात 8:00 बजे" later.
- **Unplanned spend on 18 Nov:** a Railway `redeploy` reused the old start command and ran a full enrichment for 8 entities ($1.21). See "To run a job once" above for the safe way.

## Prompt 6 check results (18 Nov, live site)

Built in PR #19, with follow-ups #20 (setup page takes the token in a field: a token in the address did not survive), #21 (prefilled category and free box were lost after the redirect) and #22 (logs Cloudflare's reason when Turnstile refuses). See the README section "Submissions and the admin area" for how it works.

- **Real submission:** "AIR 1 - A Standup Comedy Show by Harshit Mahawar", Coffeenism, Vijay Nagar, 5 Dec 2026 7:30 to 9:00 PM, ₹499 onwards. Every fact was taken from the show's own District page (https://www.district.in/events/air-1-a-standup-comedy-show-by-harshit-mahawar-dec5-2026-buy-tickets), checked 18 Nov. Screening: complete, date plausible, no duplicate, model (fast tier) "not spam, plausible" (0.85). Not on any public page, sitemap or feed before approval (its address returned 404).
- **Spam-like submission** (sent from the Hindi form): flagged "likely spam" by the rules (spam word, link shortener, two links, title in capitals) and by the model (0.98). Never public; rejected.
- **Approval:** one click in `/admin/queue` published `/indore/events/air-1-a-standup-comedy-show-by-harshit-mahawar-2026-12-05` with origin `submitted`, source line "Submitted by the organiser", a written description, and new venue (Coffeenism), artist and organiser pages. Its structured data is a `ComedyEvent` with `startDate` 2026-12-05T19:30+05:30, `endDate` 21:00, the venue's address, performer and organiser, and an `Offer` of ₹499 INR linking to District. The submitter's name and contact appear nowhere on the page. The event stays listed (it is real).
- **Poster photos** (made for the check, uploaded through "snap a poster" in Chrome):
  1. *Clear* ("Shaam-e-Ghazal", a made-up evening at Preetamlal Dua Sabhagrah): every fact read at 0.90 to 0.97: title, 5 Dec 2026, 19:00, venue, Race Course Road, Indore, Meera Saxena, Indore Ghazal Circle, "Entry free", music. After PR #21 the prefilled form shows all of them.
  2. *Blurry* (tilted, dim, heavily blurred "Jazz at the Lake"): title read (0.95); date 13 Dec (0.75), time 18:30 (0.50) and venue "Lakeside Lawn" (0.60) filled in but listed for the sender to check; performers, price and area left empty. The model's note: the poster is very blurry and those lines are unreadable.
  3. *Not an event* (a cafe menu): "We could not find event details"; the photo was deleted at once.
  The drafts from 1 and 2 were never sent; housekeeping deletes them and their photos after 2 days. Nothing was approved from them.
- **Not checked live:** the admin poster inbox (multi-upload) and the poster email (waits on Resend setup). Both share the poster reader that was checked above and are covered by tests with stand-ins.
- **Cost of the checks:** a few cents of model spend (screening at the fast tier, poster reading and one description at the mid tier), shown on the admin overview under "inside model: public submissions" and job `admin`.
- **Turnstile in practice:** see "Cloudflare Turnstile and the browsers" above. Two poster uploads were refused although the widget showed success; PR #22 logs the reason, so check `web`'s logs for `[turnstile]` if visitors report it.

## Prompt 7 check results (18 Nov, live site)

Built in PR #24, with follow-ups #25 (three model readings) and #26 (the restatement sentence, and this file). See the README section "Natural-language search" for how it works; `/admin/search` shows every query, how it was read and what it cost.

**The 20 test queries** (run from this machine against pickthejoint.com, 7 English, 8 Hinglish, 5 Hindi on `/hi/`):

| Query | Read by | Understood as | Results |
|---|---|---|---|
| comedy show this Saturday near Vijay Nagar | rules | comedy, Sat 21 Nov, Vijay Nagar | 0 |
| what's on tonight | rules | tonight | 0 |
| free events this weekend | rules | 20 to 22 Nov, free | 0 |
| live music in Indore this week | rules | music, 18 to 24 Nov | 1 |
| events on 5 December | rules | 5 Dec | 1 |
| something fun to do with my parents on Sunday evening, maybe ghazal or sufi music | model | music, words "ghazal sufi" (missed Sunday: fixed in #25) | 0 (music shown without the words) |
| places to dance salsa or bollywood this friday night near palasia | model | dance, Fri 20 Nov, New Palasia, words "salsa bollywood" (picked one of two Palasias: fixed in #25) | 0 |
| aaj Indore mein kya hai | rules | today | 0 |
| standup comedy kal | rules | comedy, tomorrow | 0 |
| is weekend kya chal raha hai | rules | 20 to 22 Nov | 6 |
| bachon ke liye kuch is Sunday | rules | kids, Sun 22 Nov | 0 |
| aaj raat party kahan hai | rules | nightlife, tonight | 0 |
| Harshit Mahawar show December mein | rules | December, words "harshit mahawar" | 1 |
| dost ke saath weekend pe koi achha standup ya open mic dekhna hai | model | comedy, 20 to 22 Nov, words "open mic" | 0 |
| koi sasta comedy show jo 500 se kam ho | model | comedy, paid, words "sasta 500 kam" (fixed in #25) | 0 (comedy shown without the words) |
| इस शनिवार संगीत | rules | music, Sat 21 Nov | 0 |
| आज इंदौर में क्या है | rules | today | 0 |
| विजय नगर में फ्री इवेंट | rules | Vijay Nagar, free | 0 |
| अगले हफ्ते कॉमेडी शो | rules | comedy, 23 to 29 Nov | 0 |
| घर वालों के साथ अगले रविवार भजन संध्या या कवि सम्मेलन | model | religious and cultural, Sun 29 Nov, words "कवि सम्मेलन" | 0 |

- **Cost:** 15 read by rules (free), 5 by the fast tier at $0.0003 each: **$0.0015 for the 20**. After #25 the three faulty ones were run again: Sunday kept, "Palasia" left as a word, "sasta 500 kam" dropped and price left empty ($0.0009). Search spend on 18 Nov: $0.0024 of the $0.25 daily cap.
- **Many zero results are real:** the listing is still small (14 Indore events at the last count) and nothing is listed for today. The zero-result list in `/admin/search` is the intended signal for missing hub pages and handles.
- Before #26, a reading with only a category ("comedy") wrongly said "We could not pick out a date, category or place"; the results were right.
- The deploy check also logged one query ("comedy"), so the admin view shows 21 searches from the first run.
- **Not checked live:** the per-address limit and the daily cap (covered by tests with a stand-in model; the check used 8 of the 20 model readings allowed per hour).

## Prompt 8 check results (18 Nov, live site)

Built in PR #27, with #28 (three listing sites added to the competitor list after the baseline showed them). See the README section "AI citation tracker" for the weekly routine.

- **Baseline recorded (week of Monday 16 Nov):** two GeoGrid runs, both imported by the owner at `/admin/citations`. The first asked all 120 checks (30 questions x 4 engines; $1.33). The second re-asked only what had failed, the rest coming from GeoGrid's 7-day cache ($0.024), and replaced the week's rows. **$1.35 in all.**
- **Result: cited in 0 of 111 answered checks** (ChatGPT 0 of 30, Gemini 0 of 30, Perplexity 0 of 30, Google AI Overviews 0 of 21). Named in the text: 0. Google AI Overviews left 9 unanswered: 2 searches showed no Overview, 7 failed at DataForSEO (server errors and timeouts); those are left out of the share.
- **Who is cited instead** (answers citing each, of 111): allevents.in 39, District 37, BookMyShow 33, google.com 25, Amar Ujala 24, stayhappening.com 21, Dainik Bhaskar 13, happeningnext.com 12, then Free Press Journal, Justdial, mepass.in, MeraEvents, Eventbrite.
- **Same week:** 13 AI crawler visits (Monday to Wednesday), 11 upcoming events, 12 venues, 15 artists.
- **Public page:** https://pickthejoint.com/ai-citations and `/hi/ai-citations` show the baseline row, server-rendered with `Dataset` structured data, in the pages sitemap and the footer.
- **Not entered yet:** Bing Webmaster Tools AI Performance and Search Console figures (owner, weekly, at `/admin/citations`), and any Copilot or Claude checks by hand (optional).
- The results files are kept in `citation-runs/` (git-ignored on `main`; the owner's main checkout ignores the folder once it pulls `main`).

## Weekly routine for the owner (from Prompt 8)

1. Run the two commands shown at `/admin/citations` from the Pick the Joint folder (dry run, then the run with the `--max-cost` the page suggests).
2. Upload the file it names at `/admin/citations`.
3. Type or upload that week's Bing AI Performance and Search Console figures on the same page.

## Prompt 9 check results (18 Nov, live site)

Built in PR #30, with #31 (Overpass retries; forced runs record the read time; Facebook skip reasons), #32 (description writer, below; Facebook cost counts only real events) and #33 (the census keeps only venues with a published event; this section). See the README section "Wider sourcing (Prompt 9)" and `docs/sources.md`.

**Cost basis for the plan:** the one production ingest so far (18 Nov): 107 posts, 20 events published, $0.97 ($0.0023 a post to scrape, about $0.0048 a post in model spend, about $0.04 a published event).

Each new source was run once on production (on the `enrich` service) as a dry run, then for real with small limits (`--force --max-items 3`). Model calls in this check were not batched; the daily ingest runs with `--batch` at half price.

| Source | Read | New events published | Already known | To review | Cost | Cost per new event |
|---|---|---|---|---|---|---|
| MeraEvents (Indore listing, 14 events seen) | 3 events | 2 | 0 | 1 (possible duplicate: three meet-ups at one café on one afternoon) | $0.047 | $0.024 |
| Incredible India (101 MP festival pages, 99 set aside without a model call) | 2 pages | 2 (Raag Ameer 3 to 5 Jan, Rangpanchami Ger 27 Mar 2027) | 0 | 0 | $0.032 | $0.016 |
| MP Tourism (statewide listing) | 1 page | 0 (no upcoming Indore event) | 0 | 0 | $0.017 | – |
| IIT Indore | 1 page, 8 events | 0 | 0 | 8 (venue "IIT Indore" inferred at 0.70) | $0.039 | – |
| Facebook (4 pages known: 3 from page links, 1 from the census) | 3 pages, twice | 0 (every page answered `no_results`: no upcoming events) | 0 | 0 | logged $0.062 (counted the empty rows; fixed in #32) | – |
| Hashtag discovery | 6 posts | never publishes | – | 6 new suggested handles, 0 places | $0.014 | $0.002 a new handle |
| Venue census (OpenStreetMap) | 226 places | – | 1 linked to a listed venue | – | free | – |

- **New versus known:** all 4 published events were new (none was already listed from Instagram), so none was confirmed by a second source yet. Duplicates are caught: the third MeraEvents meet-up went to review instead of being published twice.
- **Census by type (Indore):** 89 religious, 55 hotels and banquet halls, 49 colleges, 13 malls, 9 community, 4 grounds, 3 cultural centres, 3 clubs and bars, 1 auditorium, plus the venues we list. OpenStreetMap is thin on clubs, cafés and auditoriums; those come from `/admin/venues` and discovery.
- **The Ger event attached to its series** (`/series/indore-rangpanchami-ger`), which existed before the date was published.
- **Found and fixed:** the description writer said the Ger "ends at 11:59 PM" (how an end date with no end time is stored) and that no performers or price "have been provided". Since #32 the writer gets only the end date, and sentences that only report a missing fact are dropped before publishing (this also settles the old note about `write.ts`). The four events published in this check keep their first text: the Ger page still has both sentences, to correct by hand.
- **Not checked live:** location-tag discovery (`DISCOVERY_LOCATIONS_PER_WEEK` stays 0: no location tags came in the 6 posts, and it is unproven that the actor returns posts for location pages; test it with one location once there are some), the monthly re-tier (first run 1 Dec; handles younger than 30 days are left alone, so the first changes come on 1 Jan), and the stored Monday coverage report (first on 23 Nov).
- **Coverage page** (`/admin/coverage`) reports cost per published event by source. Model spend is recorded per item only from 18 Nov evening, so Instagram's model share before then shows as $0.
- The `enrich` service is back on `npm run job:enrich` and `30 20 * * 0`.

## Second look (19 Nov, built over two sessions)

On 19 Nov the review queue held 10 scraped posts waiting for a hand lookup, most of them for one missing fact (usually the venue). The second look tries to settle such an item before a person has to. The owner's decisions are under "Decisions the owner has made"; how it works is in `README.md` ("Second look") and at the top of `src/lib/pipeline/second-look.ts`.

- **State:** built, tested with stand-ins (`tests/second-look.test.ts`), and run once on production (below). The cost per lookup is now estimated at about $0.13 ($0.12 reserved for the search request in `secondLook.estResearchUsd`, about $0.01 for reading its notes); the hit rate is not known yet.
- **Production runs on 19 Nov (owner's yes for each), on the `enrich` service by the one-off method:**
  - Dry run (free): 10 open items, 6 past, 4 eligible; 1 would merge into a listing, 3 would be looked up, estimated $0.31.
  - Real run, once: "TiE Global Summit 2026" was merged into `/indore/events/tie-global-summit-2026-indore-2026-12-14` (free). The 3 lookups ("After Hours by NYUP", "PAN-POT Live", "Stylista Winter & Wedding Exhibition") all came back "Nothing found", so nothing was published or made ready to approve. They cost $0.391 in all, so the estimate was raised from $0.09 to $0.12. The same run also translated pending Hindi text ($0.04), because `TRANSLATION=on` is set on `enrich`.
  - Afterwards `SECOND_LOOK` on `enrich` was set to `off` (the Railway tool cannot delete a variable; anything but `on` counts as off), and `enrich` was put back on `npm run job:enrich` and `30 20 * * 0` with a fresh build.
  - Not switched on for `ingest`: three misses out of three is too little to judge, and two of them lacked even the city. Try again once newer items missing only the venue are waiting.
- **Forcing the fresh build** (`connect-service-source`) is refused by this app's auto mode until the owner approves it in chat.
- **Switched off by default.** `SECOND_LOOK=on` on the `ingest` service makes the daily run finish with it (after new posts are processed, before translation). `SECOND_LOOK_PUBLISH=on` is a second, separate switch for publishing without the click; leave it unset.
- **Where the result shows:** `/admin/queue`. An item the lookup settled has a "Second look" box with the fact, the page it came from and a note, and its button reads "Approve with the found facts". An item it could not settle says "Nothing found" with the note and anything left out, and stays as it was.
- **One lookup is per post, not per event:** of a line-up post's several queued events, only the first gets it (`skipped.samePost` in the report).
- **Migration 014** adds `raw_posts.second_look_at` (the once-per-post marker). 013 is Prompt 10's; migrations are tracked by name, so the order does not matter.
- **Local dry run:** with a local database in `DATABASE_URL`, `npx tsx scripts/jobs/second-look.ts --dry-run` (no API key needed; it stops at the budget guard). On 19 Nov, against 10 made-up queue items: 6 eligible, 1 would be merged into an existing listing for free, 4 would be looked up, estimated $0.41, nothing sent, nothing changed.
- **Production dry run (free; needs the owner's yes because it changes a start command for a few minutes):** after the pull request is merged and `web` has deployed (that runs migration 014), follow "To run a one-off script on production" with `npm run job:second-look -- --dry-run` as the `enrich` service's start command, read the report in the deploy logs (`eligible`, `estimate.wouldMergeIntoListed`, `estimate.wouldLookUp`, `estimate.usd`), then put back `npm run job:enrich` and `30 20 * * 0`. The dry run needs no variable set. Expected on the queue as it stood on 19 Nov: 10 open posts, 6 already past, about 4 to try, roughly $0.40 if later run for real.
- **To switch it on (owner's yes needed; this is the paid step):** set `SECOND_LOOK=on` on `ingest`. The next 06:00 IST run then works through the queue: at most 15 lookups a run and $8 a month. To run it once by itself instead, use the one-off method above with `npm run job:second-look` (no `--dry-run`) and `SECOND_LOOK=on` set on `enrich` for that run, then remove it.
- **To switch it off:** delete `SECOND_LOOK` from the service. Results already written on review items stay there.

## Correcting a published event (19 Nov, owner's request)

The owner published "Shreya Ghoshal Live – The Unstoppable Tour" with the wrong date and found the admin area could only cancel, take down or restore an event. `/admin/events` now has "Edit the facts" on every event (find a past-dated one with the search box; the list shows upcoming events only).

- **What can be corrected:** title, date, start and end time, last day, venue, category, price, free entry, booking link, and the description. Performers, organisers and sources cannot be edited there yet.
- **The reason is required** and is kept with what changed (`event_actions`, action `edited`); the edit page lists earlier changes.
- **Description:** written again from the corrected facts by default (one mid-tier model call, about half a cent, logged like any other). Text the admin types is used as it is, with no model call. If the rewrite fails, the facts are still saved and the message says the description still has the old wording.
- **Address:** a corrected title or date changes the page's address; the old address redirects permanently (`event_redirects`, migration 015), including its "add to calendar" link. The old share-image address is not redirected.
- **Hindi:** the Hindi page shows the corrected date at once (dates come from the data); a rewritten description appears in English there until the next `ingest` run translates it.
- **Checked** with `tests/event-edit.test.ts` and by hand in a local copy of the site; not yet used on production.

## Facebook page posts (19 Nov, built in the session after Prompt 9)

The owner supplied 120 public Indore Facebook pages (found with Perplexity; now `data/facebook-pages-indore.csv`: 19 tier A, 70 tier B, 31 tier C; 19 are statewide or national pages whose posts are kept only when they name Indore). Only 5 of the 120 use Facebook's Events feature, which was all the Prompt 9 reader read, so the owner chose to have their ordinary posts read as well.

- **How it works:** `src/lib/pipeline/facebook-posts.ts` reads the newest posts of pages that are due (A every two days, B weekly, C every two weeks; 3, 3 and 2 posts a check; only posts newer than the last check), through `apify/facebook-posts-scraper`, and stores them in `raw_posts` (`source_kind 'facebook'`, shortcode `fbp:<post id>`). The normal pipeline does the rest, including reading the flyer image. A page with 12 posts read and no event among them drops to the tier C pace by itself. Run it alone with `--sources facebook-posts`.
- **Off unless `FACEBOOK_POSTS=on` is set**, which it now is on `ingest` (19 Nov, at the owner's word after seeing the dry run: first run 60 pages, up to 180 posts, at most $1.26 to scrape and about $0.87 in batched model spend; production loaded 119 pages, 1 was already there).
- **Cost:** `FACEBOOK_POSTS_BUDGET_USD` (default $10 a month, inside the scrape budget); reaching it stops this source only. Priced at $0.007 a post (Apify's list price with the date filter); the owner's plan may be cheaper, so compare the first real run with the Apify console and set `APIFY_USD_PER_FB_POST`. Worst case with all 120 pages at their caps is about 1,900 posts a month ($13 at list price, so the $10 limit would bite); model spend on those posts is roughly $0.005 a post unbatched, half that in the daily batch run.
- **Not known until the first real run:** whether the actor reads pages given by number (16 of the 120, including the 5 `/p/Name-number/` addresses), whether it charges for error rows (the code counts every returned item as charged), and how many posts survive the free rules filter. The run report lists `pagesWithNothing` and the first few skip reasons.
- **Also changed:** the Events-tab reader now takes 30 pages a run (pages that have shown an event first, the rest in turn) so its worst-case estimate stays under its $5 limit with 120 pages on record. `/admin/coverage` takes several page links at once, shows posts read, posts kept and posts that led to an event per page, and lets the tier be changed.
- The page list is loaded by the release command on every deploy; it never changes a tier or an on/off switch set in the admin area.

## Prompt 10 (19 Nov): artist tracking and official video

Built in the same session as the Facebook posts reader (that session's second build) as PR #35, which then waited unmerged while the second look and the event editor were built. On 20 Nov it was brought up to date with main (one import clash on the event page; 245 tests pass). See the README section "Artist tracking and official video (Prompt 10)" for how it works.

- **Tracking** runs inside the daily `ingest` job (`--sources artists`): artists with an event in the next 30 days (until 7 days after), plus pinned ones; newest 3 Instagram posts every 3 days; fast model sorts them, mid tier writes release lines. Limits: `ARTIST_TRACKING_BUDGET_USD` $5 (scrape), `ARTIST_TEXT_BUDGET_USD` $3 (model).
- **Video** needs `YOUTUBE_API_KEY` on `web` (the owner was given the steps on 19 Nov) and a reference to it on `ingest`. Without it the run reports "YOUTUBE_API_KEY is not set" and carries on.
- **Admin:** `/admin/artists` (tracked artists, pinning, Instagram and YouTube links, videos waiting for approval, release lines, posts read and why each was ignored).
- **Known limits:** an artist needs an Instagram account in `official_links` to be tracked (many artist stubs have none: add them on the admin page). A show post is filed under the city of the artist's nearest event; multi-city tour posts are Prompt 13's job. No `VideoObject` structured data yet, because only the year of publication is stored and Google wants a full date.
- **Checks still to run on production** (the prompt's own): tracking for 5 artists with upcoming events, showing updates produced and ignored, the video selections awaiting approval, and the cost per tracked artist per month. Expected cost per artist: at most 3 posts every 3 days at $0.0023, so about $0.07 a month to scrape, plus under $0.01 in model spend.

## Prompt 11 (20 Nov): practical facts and weekly roundups

Built in the session that merged Prompt 10. How it works is in the README section "Practical facts and weekly guides (Prompt 11)".

- **Practical facts:** asked for in the same extraction call (no second call; about 100 more output tokens per post at most, roughly $0.001), stored in `practical_facts` with their source, shown as "Before you go" with `FAQPage` data. Organisers send details through `/submit?event=<id>`, which goes to the review queue; the admin edits them at `/admin/events/<id>`. Duplicate merges move them. Translated into Hindi with the rest.
- **Weekly guide:** drafted by the Thursday `ingest` run (`ROUNDUPS=off` stops it), published from `/admin/roundups`. About a cent per city per week, inside `ROUNDUPS_BUDGET_USD` ($2).
- **Urgent fix the same night (PR #39):** the first version asked the model for practical facts as a nested list inside each event. The Claude API refused every extraction request with that shape ("The compiled grammar is too large, which would cause performance issues"), at no cost. The tests could not see it because they use a stand-in model. It was found by the facts backfill on production (20 calls, all refused). Now the model writes `key | confidence | answer` lines in one text field, which `parsePractical` / `practicalOf` read. A test keeps the structured-output schema below its old size. The fix was tested live (3 posts, 0 refused, $0.07) and merged at about 23:08 UTC on 20 Nov; `ingest` rebuilt on it at 23:10 UTC, before the 00:30 UTC run. **Lesson: any change to a structured-output schema must be tried against the real API once (a 3-post backfill or a one-off run) before it is merged.**
- **Checked:** `tests/practical-roundups.test.ts` (16 tests: storing and ranking answers, the form and its review, admin edits, merges, the page block and its FAQ data, Hindi, the backfill, week and section choice, drafting rules, the article page, sitemap and IndexNow). 261 tests pass in all; type-check, lint and build clean.
- **Production checks (20 Nov, owner's yes):**
  - **Facts backfill:** 20 upcoming events' source posts read again, 0 refused, $0.32. Only one answer was confident enough to store: directions to Labhganga Exhibition Centre (venue-level, so it shows on every event there, e.g. Plast Pack 2026). An entry-rules answer was left out as unsure. **Finding: organiser posts rarely state practical facts**, so most answers will come from organisers through `/submit?event=<id>` and from the admin. Event pages show start and end times as answers wherever the time is known.
  - **Weekly guide:** the week 47 Indore draft was made with 8 events (music 1, business and networking 2, nightlife 5) for $0.011; it waits at `/admin/roundups`.
  - **Pages:** `/indore/guide` answers (no guide published yet); event pages show "Before you go" with `FAQPage` data and the organiser link.
  - Total model spend on the checks: about $0.40. `enrich` was put back on `npm run job:enrich`, `30 20 * * 0`, branch main.
- **Still to watch:** the first daily `ingest` run on the fixed code (06:00 IST, 21 Nov): its report should show `pipeline.extraction.failed` at 0.
- **Known limits:** facts from posts processed before this change exist only after the backfill or a new post about the same event. "For families" relies on the kids category or an age-limit answer saying all ages or children, so it may be missing in a week where it would fit. The ISO week number names the guide after the Friday's week.

## Next: Prompt 12

Social posts with approved auto-publishing. The text is in `docs/build-prompts.md`. Start it in a new session (two builds were done in this one: merging Prompt 10 and building Prompt 11). It needs Meta developer access (an account-bound dependency: ask the owner first) and the prompt asks for Meta's current documentation to be read before any code. **The owner decided (said again on 20 Nov) to build Prompts 10 to 15 now, one after another, without waiting for the week of cost data.** The coverage reports stored on 23 and 30 Nov still show which Prompt 9 sources earn their keep.

Also on 19 Nov: the owner wrote to District asking for a feed or permission (the reply is pending; nothing is built for District), and has a drafted request for AllEvents' paid Events API (its price is unknown; nothing is to be built on it until the owner has seen the price).
