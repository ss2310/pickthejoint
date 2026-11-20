# Parked

Pick the Joint was parked on 20 Nov 2026. Nothing has been deleted: the site,
the database and every scheduled job are still there, just switched off.
Parking and restarting are both one setting, `PARKED=true`, plus the cron
schedules on Railway.

## What parking does

`PARKED=true` is a variable set on each Railway service (`web`, `ingest`,
`housekeeping`, `enrich`). While it is set:

- **Scheduled jobs do nothing.** Each job prints one line, "parked", and exits
  before it opens the database or calls anything. The cron schedules are also
  cleared on Railway, so the jobs do not even start.
- **Every paid call is refused.** Both budget caps read as $0
  (`SCRAPE_BUDGET_USD`, `MODEL_BUDGET_USD`), so the budget guard blocks every
  Apify, Claude, DataForSEO and OpenRouter call before it is made. This also
  covers what the website itself pays for:
  - Public search falls back to the plain search, with no model.
  - Poster submissions are still accepted and wait in the review queue, but
    nothing reads the poster.
  - Admin buttons that call a model (weekly guide, re-checks) show the budget
    message.
  - The admin overview shows both caps as $0.00.
- **Stale pages are kept out of search and AI answers.** These pages get an
  `X-Robots-Tag: noindex` header and are left out of the sitemap:
  - the home page and city home
  - today, this weekend, this week
  - category and area pages
  - search
  - the weekly guides

  Event, venue, artist, organiser and series pages stay indexable: they state
  dated facts with sources, which stay true. The past-events archive also
  stays indexable. robots.txt is unchanged on purpose: a crawler that is
  disallowed never sees the noindex header.
- **Every public page says it is paused.** One line under the header, in
  English or Hindi: listings are not being updated, so check the date with the
  organiser.

**Not covered by the flag:** the AI citation checks run from the owner's own
computer (`scripts/citations/geogrid_run.py`, see /admin/citations). Simply do
not run them while parked.

## What still costs money

- **Railway:** `web` and `Postgres` keep running, about $4 a month of usage.
  That fits inside the Hobby plan's $5 monthly minimum. The three job services
  cost nothing while their schedules are cleared.
- **Domain and Cloudflare:** unchanged. Cloudflare is the free plan.
- **APIs (Apify, Claude, DataForSEO, OpenRouter):** $0.

## Database backup

A full dump was taken when the site was parked. Where it is and how it was
checked: see "Backup taken on parking" below.

## Restarting, in this order

1. **Check the accounts and keys still work.** This step is free.
   - Apify, Anthropic, DataForSEO and OpenRouter accounts and keys: still
     valid and funded?
   - Model IDs in `src/config/index.ts` (`models`): check them against
     Anthropic's current model list. Old models are retired.
   - Apify actor IDs (`apify` and `sourcing` in the same file): still offered,
     at the same price?
2. **web first.**
   - Remove `PARKED` from the `web` service; Railway redeploys it.
   - Check:
     - the paused line has gone
     - `/indore` and `/indore/this-weekend` no longer send `X-Robots-Tag`
     - `/sitemaps/hubs.xml` lists the hub pages again
     - the admin overview shows the normal caps
3. **housekeeping next.** It makes no paid calls.
   - Remove `PARKED` and set its cron back to `0 19 * * *` (00:30 IST).
   - Its first run:
     - marks finished events as past
     - tells search engines what changed
     - on a Monday, checks that AI crawlers can reach the site
4. **ingest.**
   - Remove `PARKED` but leave the cron empty for now.
   - Run a dry run first, which sees what is due and logs the estimated cost
     without paying: set the start command to
     `npm run job:ingest -- --dry-run`, give it a cron a few minutes ahead, and
     force a fresh build.
   - Read the report, then put back:
     - start command: `npm run job:ingest -- --batch`
     - cron: `30 0 * * *` (06:00 IST)
5. **enrich last.**
   - Remove `PARKED` and set its cron back to `30 20 * * 0` (Monday 02:00 IST).
6. **Keep these as they were:** the other variables on each service
   (`FACEBOOK_POSTS=on`, `TRANSLATION=on`, `NEWS_SOURCES`, `INDEXNOW=on`, the
   budgets). Parking does not touch them.

## What the first run after a restart costs

These are estimates from the November 2026 runs.

- **First ingest run: about $2 to $4.**
  - Every handle is due at once, at 3 posts each.
  - About 35 to 60 handles is 100 to 180 posts: about $0.25 to $0.45 to
    scrape, plus $0.50 to $0.90 to read.
  - If the weekly Facebook page read falls on that day: at most $1.26 to
    scrape and about $0.87 to read.
  - News, web calendars and Hindi translation: well under $0.50.
  - Posts older than the scrape window are not fetched, so a long pause does
    not mean a bigger bill.
- **First enrich run (Monday): at most $5.** It stops at a quarter of the $20
  enrichment budget.
- **First week in total: about $8 to $12**, then about the same as before
  parking. That was $10.48 for 18 to 20 Nov 2026, much of it one-off first
  enrichment work.
- Both monthly caps ($50 scrape, $60 model) apply from the first call, with a
  warning at 80%.

## Backup taken on parking

(Filled in after the dump.)
