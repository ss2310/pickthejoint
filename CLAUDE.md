# Pick the Joint

## What this is
An events discovery site for Indian cities at pickthejoint.com. It launches with
Indore only. Next come other tier-2 cities in Madhya Pradesh, then tier-1 cities.
Nothing in the code may assume a single city.

## Why it exists
The goal is to become the source AI assistants (ChatGPT, Gemini, Perplexity,
Google AI Overviews) cite when someone asks what is happening in a city. It is a
public case study in AI visibility. Every decision is judged by one question:
does this make our pages more complete, more accurate, more current and easier
for a machine to read than District and BookMyShow listings? Traffic and revenue
are not goals yet.

## How we win
- Coverage: events the big ticketing platforms don't list (small venues, free
  gigs, college and community events, workshops, religious and cultural events).
- Context: every event links to a venue page, an artist page and an organiser
  page that answer the follow-up questions (who is this, where is it, how do I
  get there, what else is on there).
- Freshness and honesty: every event shows its source and a "last verified" date.
- We send people to the official booking page (District, BookMyShow, the
  organiser's own link). We do not sell tickets.

## Scope of version 1
In: Instagram ingestion from a curated handle list, event/venue/artist/organiser
pages, hub pages, an archive of past events, English and Hindi, user-submitted
events with moderation, natural-language search, an AI citation tracker.
Later phase (only when a prompt asks for it): wider sourcing beyond Instagram
handles, artist tracking with official video embeds, practical-facts FAQs and
weekly roundup articles.
Out (do not build, do not scaffold): email or WhatsApp digests, user accounts
for the public, ticketing or payments, an open-ended chatbot, a mobile app,
separate Hinglish pages, ads, llms.txt or any machine-only version of pages
(studies show no effect on citations; the normal pages are what gets cited).

## Stack
- Everything is hosted in one Railway project: the web service, the Postgres
  database and the scheduled jobs.
- Next.js (App Router, TypeScript) running as a Node service on Railway.
- Railway Postgres for all data. Use Postgres full-text search.
- Cloudflare (free plan) in front of the site for caching and speed.
- Apify for Instagram scraping (pay-per-result actor, actor ID in config).
- Claude models through the Claude API, with the model chosen per task in one
  config file (look up the current model IDs in Anthropic's documentation):
  - Fast tier (Haiku class): caption filtering, search-query parsing, dedup
    checks, classification of artist posts.
  - Mid tier (Sonnet class): reading poster images and extracting event
    facts, all public-facing writing (event descriptions, artist and venue
    text, Hindi translation, social captions), and enrichment.
  - Escalation: where a fast-tier result has low confidence, retry once on the
    mid tier before sending it to review_queue.
  - Top tier (Opus class): only the weekly roundup article, and only if a
    side-by-side test I approve shows it is clearly better.
  - Scheduled, non-urgent jobs use the Message Batches API for the batch
    discount.
- The AI crawler list in config covers training, search and live-fetch agents
  (for example GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot,
  Claude-User, PerplexityBot, Perplexity-User, Google-Extended, Bingbot,
  Applebot). Check each vendor's current documentation for the exact names.
- Scheduled jobs run as Railway cron services (separate from the web
  service), so long runs never block or time out page requests.
- A scheduled weekly database dump to off-site storage, since backups are our
  responsibility.
- Cloudflare Turnstile for captcha.

## Hard rules
1. Budget: two separate monthly caps, both enforced by the budget guard.
   SCRAPE_BUDGET_USD (default 50) covers Apify and any other cash spend.
   MODEL_BUDGET_USD (default 60) covers Claude API usage, which is paid from
   my plan's monthly API credit; the rest of that credit is reserved for my
   other projects. Railway hosting is separate from both. Every paid call is
   logged with an estimated cost, by service and by model. Paid jobs refuse to
   run once their cap is reached. Warn at 80%.
2. Every public page is server-rendered HTML with the full content present
   without JavaScript. AI crawlers do not run scripts.
3. Never invent facts. An event is published only when title, date and venue
   were extracted with confidence. Anything uncertain goes to a review queue.
4. Never rehost Instagram images or videos. Link to the original post or use
   Instagram's official embed. Descriptions are written in our own words from
   the facts (what, when, where, price, who).
5. Never host or reproduce music, lyrics or long quotes. Link to official
   channels. Official YouTube and Instagram embeds are allowed, and every
   embed must have a line of plain text beside it saying what it is, because
   crawlers cannot read inside an embed.
6. Pages about people state professional, public facts only, each traceable to
   a listed source.
7. All dates and times are stored in UTC and shown in Asia/Kolkata.
8. Secrets live in environment variables. Never commit keys.
9. Ask me before adding any paid service, any new dependency that needs an
   account, or any feature not listed in scope.

## URL structure
- /{city}/events/{slug}            event page
- /{city}/venues/{slug}            venue page
- /artists/{slug}                  artist page (artists are not tied to a city)
- /organisers/{slug}               organiser page
- /{city}                          city home
- /{city}/today, /{city}/this-weekend, /{city}/this-week
- /{city}/{category}               e.g. /indore/comedy
- /{city}/area/{area}              e.g. /indore/area/vijay-nagar
- /{city}/past                     archive
- /series/{slug}                   recurring festivals and annual events
- Hindi versions live under /hi/ with the same paths.
