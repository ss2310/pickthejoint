# Handoff: where the build stands

Written 18 November 2026, at the end of the session that built Prompts 2, 3 and 3b, and updated the same day after Prompts 4 and 5, a redesign, and Prompts 6, 7 and 8. Read this with `CLAUDE.md` (project rules) and `README.md` (commands and layout). The owner works prompt by prompt from a numbered prompt file (Prompts 1 to 15). **The text of every prompt not yet built is in `docs/build-prompts.md`**, so there is no need to ask for it. Each prompt ends with checks that must be run and shown before moving on.

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
| 9 Wider sourcing | **Next**, but only after a week of cost data (first production ingest was 18 Nov, so from about 25 Nov) |
| 10 to 15 | Not started. Text in `docs/build-prompts.md` |

Production showed 13 Indore events before Prompt 6; one approved submission has been added since.

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
- **Not Hindi's fault, still to fix:** the English description writer sometimes says a fact is missing ("No ticket price has been provided"), and the Hindi carries that over. See `src/lib/pipeline/write.ts`.
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

## Next: Prompt 9

Wider sourcing. The text is in `docs/build-prompts.md`. Its own notes say Prompts 9 to 11 come only after a week of cost data; the first production ingest ran on 18 Nov, so start from about 25 Nov and read a week of `cost_log` (the admin overview shows spend by service, model and job) before planning. The baseline above shows which sources AI engines lean on for Indore (allevents.in, District, BookMyShow, Amar Ujala, stayhappening.com): useful when choosing what to widen into, within the source rules in `docs/sources.md` (Dainik Bhaskar and Naidunia forbid automated collection).
