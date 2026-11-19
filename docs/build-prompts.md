# Build prompts still to run

The owner's numbered build prompts, copied word for word from the prompt file he pasted on 18 November 2026, so a new session does not have to ask for them. Prompts 1 to 5 are built and are not repeated here (their text is in the project brief, the code and `docs/HANDOFF.md`). Prompts 13 to 15 were added on 18 November 2026.

How the owner runs them:
- In order, each ending with checks that must be run and shown before moving on.
- At most two prompts per session, then update `docs/HANDOFF.md` and start a new session.
- Prompts 9 to 11 are the depth layer: only after a week of cost data. (Overridden: the owner chose to build Prompt 9 at once on 18 Nov, and Prompts 10 to 15 at once, confirmed 20 Nov.)
- Prompt 12 needs live events and the generated event images from Prompt 3b.
- Prompts 13 to 15 are written as additions to an already-built site, so they are safe to run after Prompt 5 or later.

If the owner pastes a newer version of a prompt, the pasted version wins; update this file.

## Prompt 6 — User submissions and the admin area

```text
Read CLAUDE.md. Let organisers add their own events, and give me one place to
approve things.

1. Public submission form: event details, venue, category, booking link, an
   optional Instagram post link, and the submitter's name and contact (not
   shown publicly). Protect it with Cloudflare Turnstile, a hidden honeypot
   field and a per-IP rate limit.
1b. "Snap a poster": an alternative to the form where anyone uploads a photo
   of an event poster (a street poster, a college notice board, a flyer, or a
   poster forwarded on WhatsApp), with an optional note. The image goes
   through the same vision extraction as Instagram posters, and the form is
   prefilled for the submitter to check before sending. Images are stored
   privately for review only and never shown on the site; delete them after
   the event has passed. Accept only common image types, cap the file size,
   and strip location metadata from photos on upload.
1c. Poster inbox for me: a private upload page in the admin area (and, if
   simple, a dedicated email address that accepts forwarded images) where I
   can drop several posters at once, for example ones collected from WhatsApp
   and Telegram groups. Each becomes a draft in review_queue.
2. Nothing submitted is published directly. Each submission is pre-screened
   (complete, plausible date, not a duplicate, not spam) and placed in
   review_queue with the screening notes. Events from posters show "source:
   submitted poster" on the page, with no image.
3. Admin area, protected by a single-admin login (one account, mine; strong
   password hashed in the database, secure session cookie, login rate limit):
   - Review queue with approve, edit and reject in one click each.
   - Suggested handles to approve or dismiss, and a handle list where I can
     change tiers or pause a handle.
   - The month's spend against the cap, by service and by job.
   - Last run report for each job.
   - A way to mark an event cancelled or to remove a page after a takedown
     request, which also records the reason.
4. Approved submissions get origin "submitted" and show "submitted by the
   organiser" on the page.

Checks before you finish: submit a real and a spam-like test event, confirm
neither appears publicly, approve one and confirm it goes live with correct
structured data. Upload three poster photos (one clear, one blurry, one that
is not an event) and show me what extraction made of each.
```

## Prompt 7 — Natural-language search

```text
Read CLAUDE.md. Add a search box that understands plain questions such as
"comedy show this Saturday near Vijay Nagar" or "aaj Indore mein kya hai".
This is search, not a chatbot.

1. One small model call turns the query into the same filters the plain search
   uses (city, date range, category, area, free or paid, keywords). The site
   then shows the normal results page for those filters, with a one-line
   restatement of how the query was understood.
2. Try rules first for common patterns (today, tonight, this weekend, category
   names, area names in English, Hindi and Hinglish). Call the model only when
   rules don't resolve the query.
3. Cache parsed queries. Apply a per-IP rate limit and a daily spend limit for
   this feature through the budget guard. When a limit is hit, fall back to
   keyword search without an error.
4. The model never writes free-form answers and never sees anything except the
   query and the list of valid filter values.
5. Log each query and whether it returned results in search_log. Give me an
   admin view of the most common queries and the ones with no results, since
   those show which hub pages and handles are missing.

Checks before you finish: run 20 test queries in English, Hindi and Hinglish
and show me how each was parsed; show the cost of those 20 queries.
```

## Prompt 8 — Citation tracker and public proof

```text
Read CLAUDE.md. Build the measurement that proves whether this works.

Before writing code, ask me how I want to run the AI checks: I have an
existing tool that queries AI engines, and I may prefer to reuse it or to
enter results by hand at first. Do not add a paid AI-engine API without my
approval.

1. citation_queries: a fixed set of about 15 questions per city in English and
   Hindi, of the kind people ask assistants ("what's happening in Indore this
   weekend", "comedy shows in Indore", "live music in Indore tonight"). I
   approve the list. The set stays fixed so results are comparable over time.
2. citation_results: for each query, engine and week, record whether
   pickthejoint.com was cited, whether it was mentioned by name, which
   competitors were cited, and a link to a screenshot.
3. Support both an automated run (if I approve a method) and a quick manual
   entry form in the admin area.
4. An admin dashboard and a public page showing, week by week: share of
   queries where we were cited, per engine; AI crawler visits from
   crawler_log; number of live events, venues and artists.
5. Record a baseline run before anything else, so week zero is on record.
6. Add a place to log two free first-party sources each week: the AI
   Performance report in Bing Webmaster Tools (citations in Copilot and Bing
   AI answers) and Search Console's performance data. Manual entry or CSV
   import is fine.

Checks before you finish: the baseline week is recorded; the public page
renders server-side and shows the numbers.
```

## Prompt 9 — Wider sourcing

```text
Read CLAUDE.md. Widen event coverage beyond the starting handle list without
raising cost much. Complete coverage is our main advantage, so this matters
more than any single page feature. Every paid call goes through the budget
guard, and each source below gets its own monthly limit in config.

Before building, show me a short plan with an estimated monthly cost per
source, using the measured cost per post from the pipeline so far.

1. Venues first
   - Nearly every event happens at a venue, and a city has a finite number of
     them. Build a venue census for each city: auditoriums, clubs, cafes and
     bars with live acts, hotels and banquet halls, malls, colleges, cultural
     centres, grounds, religious and community venues.
   - Give me an admin view of venues with no Instagram handle on record and
     venues with no event in the last 60 days, so I can fill gaps.
   - Venue handles default to tier A when they post events often, tier B
     otherwise. Re-tier automatically each month from how many real events a
     handle produced, and pause handles that produced none in 90 days.

2. Snowball discovery
   - Keep adding tagged, mentioned and co-host accounts from event posts to
     suggested_handles, ranked by how often they appear.
   - A weekly capped pull of recent posts for a small set of city hashtags and
     venue location tags. Its purpose is to discover new handles and venues,
     not to publish events directly. Hard cap on posts per week in config.

3. More sources outside Instagram (Google event results and local news
   calendars already run from Prompt 2)
   - Ticketing and event platforms with public city listings: for example
     District, BookMyShow, AllEvents, Townscript, Skillboxes, Meetup,
     Eventbrite, and KonfHub for tech events.
   - Institutions with their own event calendars: auditoriums and cultural
     bodies, large hotels and convention centres, colleges and their annual
     fests, TEDx events, stadiums, marathons and running clubs, and civic or
     tourism bodies.
   - Public Facebook events for the city's venues and organisers, through an
     Apify actor that reads public event pages, within its own monthly limit.
   - For every source: check its terms and robots.txt first and tell me what
     you found; skip any that disallows it. Fetch politely and infrequently.
   - Annual festival calendar per city (for Indore, for example Rangpanchami
     Gair, Navratri garba and Ganesh utsav): seed series pages for recurring
     festivals so they exist before the dates are announced, and attach each
     year's events to them.
   - Community spaces (the city's Reddit community, WhatsApp and Telegram
     groups) are not scraped. They are covered by the poster inbox from
     Prompt 6 and by posting our roundups there by hand.
   - From any of these, take facts only (title, date, time, venue, price,
     official link). Write our own description, link to the source as the
     booking or information page, and record it in sources.
   - These events go through the same matching, dedup and confidence rules as
     Instagram events. An event confirmed by two independent sources gets a
     higher confidence and shows both.

4. Organiser outreach list
   - An admin export of organisers and venues that have events on the site,
     with their page URL and public contact, so I can invite them to claim
     their free listing and submit future events themselves.
   - A small "listed on Pick the Joint" link snippet they can put on their
     own site or profile.

5. Coverage report
   - A weekly report per city: events published by source type, share of
     events found by more than one source, new venues and handles discovered,
     and cost per published event by source. This tells me which sources to
     keep.

Checks before you finish: run each new source once for Indore in dry-run and
then for real with small limits; show me how many events were new versus
already known, and the cost per new event for each source.
```

## Prompt 10 — Artist tracking and official video

```text
Read CLAUDE.md. Make artist pages current and rich, at low cost.

1. Who gets tracked
   - Only artists with an upcoming event in one of our cities in the next 30
     days, plus artists I pin manually. Tracking stops 7 days after their last
     event. Cap the number of tracked artists in config.

2. What tracking does
   - Check each tracked artist's Instagram every 3 days, new posts only,
     latest 3 posts, through the budget guard with its own monthly limit.
   - Classify each new post: new show or tour date, change to an existing
     event, new release, or other. Ignore "other".
   - A new show date in one of our cities enters the normal event pipeline. A
     change updates the event. A new release is added to the artist page as a
     dated one-line update in our own words with a link to the post.
   - Do not rewrite general posts as news, and do not publish anything about
     an artist's private life.

3. Official video
   - Using the YouTube Data API within its free quota, find the artist's
     official channel and select up to 5 of their best-known videos from
     official sources only. Store the IDs; I approve the selection in the
     admin area before it goes live.
   - Embed them with YouTube's official player, loaded lazily so pages stay
     fast. Beside each one, plain text: title, year, and one sentence on what
     it is and why it is known.
   - Show the same block, shortened to 1–2 videos, on that artist's event
     pages under "Get to know the artist".

4. Artist and city history
   - On each artist page, list their upcoming and past events in each of our
     cities, with venue and date. This is the part no other site has.

Checks before you finish: run tracking for 5 artists with upcoming events;
show me the updates it produced and the ones it ignored, the video selections
awaiting approval, and the cost per tracked artist per month.
```

## Prompt 11 — Practical facts and weekly roundups

```text
Read CLAUDE.md. Add the two content types most likely to be quoted by AI
assistants: practical answers on each event, and a weekly article per city.

1. Practical facts on every event page
   - Extend extraction and the data model to capture, when the sources state
     them: age limit, entry rules, doors and start times, expected end time,
     seating or standing, parking, food and drink, dress code, accessibility,
     refund or cancellation terms, language of the performance, whether it is
     indoors or outdoors.
   - Show them as a short question-and-answer block on the event page with
     FAQPage structured data. Only show questions we can answer from a source.
     Never guess; an unknown fact is simply left out.
   - Venue-level facts (parking, accessibility, how to reach) are stored on
     the venue and reused on every event there.
   - Let organisers add or correct these facts through the submission form.

2. Weekly roundup per city
   - Every Thursday, generate a draft article for the coming weekend and week:
     a plain-language overview, then sections by category, with each event's
     what, when, where and price and a link to its page. Include a short
     "free this weekend" and "for families" section when there are enough
     events.
   - Written in our own words from the database, in English and Hindi. Give it
     Article structured data, a clear date, and a permanent URL such as
     /{city}/guide/{year}-week-{n}.
   - It is saved as a draft for me to review and publish in one click. Nothing
     in this section auto-publishes.
   - Past roundups stay live and link to the events' archive pages.

Checks before you finish: show me three event pages with their fact blocks and
the sources behind each answer; generate one roundup draft for Indore in both
languages.
```

## Prompt 12 — Social posts with approved auto-publishing

```text
Read CLAUDE.md. Build a generator for Instagram and Facebook posts, published
through Meta's official APIs after I approve them. The site stays the source
of truth; social posts point back to it. Nothing is published without my
approval of that specific post.

1. A weekly pack, generated every Wednesday night into a "Social queue" in the
   admin area, for me to review on Thursday:
   - One weekend roundup carousel per city: a cover slide plus one slide per
     event (up to 9), in the site's visual style.
   - Up to 3 single-event cards for the most notable events of the week.
   - One "free this weekend" card when there are enough free events.
   Keep the total small. I would rather post 5 good things a week than 20.

2. Images
   - Generated on the server from our own templates and data: title, date,
     time, venue, price, city, and the site name. Portrait size for the feed
     and a story-size version of each.
   - Never use the organiser's poster or any Instagram media. Our own design
     only.

3. Captions
   - For each post: a caption in English and one in Hinglish, written in our
     own words; the handles of the venue, organiser and artists to tag; a
     short set of relevant local hashtags; and the page URL to put in the
     link sticker or bio link.
   - Facts in captions come only from the database. If an event is cancelled
     or changed after a pack is generated, flag the affected post in the queue.

4. Queue workflow
   - Each post has: preview, editable caption, approve and reject buttons, a
     scheduled time I can change, and its status (draft, approved, published,
     failed). "Approve whole pack" in one click.
   - Skip events already posted. Show which organisers were tagged, so I can
     follow up with them about claiming their listing.
   - Keep a manual fallback: copy-caption and download-images buttons and a
     "mark as posted by hand" toggle, for when the API is unavailable or for
     things it cannot do.

4b. Publishing through Meta's APIs
   - Instagram: use the official content publishing API for our own
     professional account (single images, carousels and stories). Facebook:
     publish the same posts to our Page through the Pages API.
   - Before writing code, read Meta's current developer documentation for
     both and tell me: the exact permissions needed, whether our app can stay
     in development mode since it only posts to accounts we own, what the API
     cannot do (for example link stickers or tagging), and the current daily
     publishing limit. Do not rely on memory for any of this.
   - Approved posts are published at their scheduled time by a cron job.
     Before publishing, re-check the event in the database; if it has been
     cancelled or changed since approval, do not publish and flag it.
   - Images are served from public URLs on our own domain, as the API
     requires.
   - Tokens: store them encrypted, refresh them before they expire, and alert
     me well ahead if a refresh fails. A dead token must never fail silently.
   - Every publish attempt is logged with the API response. A failure sets the
     post to "failed" with the reason and alerts me; never retry more than
     twice, and never publish the same post twice.
   - Hard cap in config on posts per day per account (default 3), far below
     Meta's limit, so a bug cannot flood the page.
   - A global "pause publishing" switch in the admin area.

5. Cost
   - Image generation uses templates, not an image model. Caption writing goes
     through the budget guard with a small monthly limit.

Checks before you finish: generate one pack for Indore from live data and show
me the carousel, two single cards and their captions. Then publish one
approved test post to each platform, show me the logged response, and prove
that an unapproved post and a cancelled event are both refused.
```

## Prompt 13 — Tours: many events from one post, and artist tour pages

```text
Read CLAUDE.md. Prompts 1–5 are already built, so make these changes as
additions and migrations; do not rebuild existing pipeline steps.

1. Multi-event extraction
   - A single post or poster can announce several events (a tour poster with
     many cities and dates, a venue's monthly line-up). Change extraction to
     return a LIST of events per post, each with its own city, date, venue and
     confidence. A normal single-event post returns a list of one.
   - Each extracted event goes through the existing matching, dedup and
     confidence rules separately, and all of them cite the same source post.
   - Tour posters often give a city and date but no venue. Store these as
     "date announced, venue to be confirmed": visible on the artist's tour
     page, but NOT published as a city event page until a venue is confirmed
     from a second source (organiser post, ticket page) or by me in the
     review queue. Re-check these automatically when new posts from that
     artist or matching organisers arrive.
   - Dates in cities we do not cover yet are stored against the artist with
     the city name as text. Do not create city pages for them. When a city is
     added later, these become its first events.

2. Artist tour pages
   - Add /artists/{slug}/tour: the artist's full list of upcoming dates across
     all cities (covered or not), each with city, date, venue or "to be
     confirmed", official booking link when known, and source. Past dates sit
     below as an archive.
   - Open with a two-sentence plain summary (how many dates, which cities,
     over what period) and a short FAQ phrased the way people ask ("Is
     {artist} coming to Indore?", "{artist} tour dates"), in English and
     Hindi, with FAQPage and Event structured data for each confirmed date.
   - Link every city event page for that artist to the tour page and back.
   - Include tour pages in the sitemap and IndexNow pings.

3. Which artists get this
   - Any artist with an upcoming event in one of our cities gets a tour page.
   - Add a "priority artists" list I control in the admin area, for touring
     comedians, indie bands and regional singers worth tracking even between
     visits. Priority artists are tracked continuously (Prompt 10 tracking
     rules, new posts only) within a cap in config (default 50).
   - Show me a monthly suggestion list for that priority list: artists who
     appeared most often in our data and in our search_log. Do not spend on
     outside search-volume data without asking me.

4. Costs
   - Multi-event extraction must not add a second model call for normal
     posts. Report the cost difference per post after the change.

Checks before you finish: run three real tour posters and one normal post
through extraction and show me the events produced, which were held for
venue confirmation, and one finished tour page in English and Hindi.
```

## Prompt 14 — Scaling coverage with a bigger budget

```text
Read CLAUDE.md. Make coverage scale with budget through config, with no code
changes needed when I raise or lower it.

1. Budget profiles in config, selectable from the admin area:
   - "lean": about 300 handles per city, 50 checked daily, the rest weekly.
   - "standard": about 500 handles, 100 daily.
   - "wide": about 1,000 handles, 200 daily.
   Each profile sets the handle cap, the daily-tier size, and the monthly
   scraping and model caps. Show the projected monthly cost of each profile
   from OUR measured cost per post, not from estimates.

2. Spend the budget where it finds events
   - Rank handles by events found per rupee over the last 60 days. Promote
     the best to the daily tier and demote the worst automatically, inside
     the profile's limits.
   - When the handle list is shorter than the profile allows, say so on the
     admin page: at that point more budget buys nothing and the work is
     finding more venues (Prompt 9's census and snowball discovery).

3. A coverage estimate per city: venues known, venues with a tracked handle,
   venues with at least one event in 60 days, and events per week by source.
   This is the number I use to decide whether to raise the budget.

Checks before you finish: show me the three profiles with projected costs
from real data and the current coverage estimate for Indore.
```

## Prompt 15 — Venues, organisers and artists as customers

```text
Read CLAUDE.md. The businesses we list are the audience that can pay. Build
the free "claim" layer now and the paid layer as switched-off scaffolding.
Ask me before enabling anything that takes money.

1. Claim your page
   - A "Claim this page" link on venue, organiser and artist pages. Claiming
     verifies control of the listed Instagram account or official email
     domain; anything unclear goes to my review queue.
   - A claimed owner gets a simple login to: correct their facts, add
     practical details (parking, entry rules, contact), submit events that
     skip the public form's queue but still pass the automatic checks, and
     see how many times their pages were viewed.
   - Claimed pages show a "verified by the venue" mark. Facts they enter are
     labelled as provided by them.

2. A lead list for me
   - An admin view of every venue and organiser with: events listed, page
     views, whether claimed, public contact, and a notes field. Export as
     CSV. This is my outreach list for marketing services.
   - A monthly per-venue summary I can send them ("your events were viewed N
     times"), generated as a draft for me to send by hand.

3. Paid layer, built but OFF
   - Data model and admin switches for featured placement on hub pages and a
     highlighted listing. Featured items are always labelled "Featured" and
     never change the facts or the order of the "all events" lists that AI
     assistants read.
   - No payment integration yet. Tell me what it would need when I ask.

Checks before you finish: claim a test venue page end to end, show the owner
view, the lead list export, and one monthly summary draft.
```

## After launch (the owner's notes)

- Approve suggested handles weekly; the handle list is the real limit on coverage.
- Check the review queue daily at first. If the same reason keeps appearing, fix the extraction rule rather than approving by hand.
- Use the measured cost per post from Prompt 2 to decide how many handles the scraping cap supports before adding a second city.
- Adding a city is: a new cities row, its areas, its handle CSV and its citation queries. No code changes.
- Off-site presence, which no code can do: post the weekly roundup on the brand's Instagram and in local communities where it is welcome, answer "what's on" questions there honestly with a link, and invite organisers and venues to link to their listing.
