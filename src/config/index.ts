/**
 * Central configuration. Every tunable that jobs or pages depend on lives here,
 * so changing a model, actor or budget never means hunting through the code.
 * Secrets are NOT stored here; they come from environment variables.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Env var ${name} must be a non-negative number, got "${raw}"`);
  }
  return n;
}

/**
 * Claude models per task tier (see CLAUDE.md, "Stack").
 * IDs checked against Anthropic's model list on 2026-11-18; re-check when upgrading.
 */
export const models = {
  /** Haiku class: caption filtering, search-query parsing, dedup checks, artist-post classification. */
  fast: process.env.MODEL_FAST ?? "claude-haiku-5-5",
  /** Sonnet class: poster reading / extraction, all public-facing writing, Hindi, enrichment. */
  mid: process.env.MODEL_MID ?? "claude-sonnet-5-5",
  /** Opus class: weekly roundup only, and only after an approved side-by-side test. */
  top: process.env.MODEL_TOP ?? "claude-opus-5-5",
} as const;

export type ModelTier = keyof typeof models;

/**
 * List prices in USD per million tokens, used to estimate and log model spend.
 * Checked against Anthropic's pricing on 2026-11-18; re-check when changing models.
 * A model missing from this table is costed at the most expensive rate here.
 */
export const modelPricing: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
};
/** The Message Batches API bills at half the list price. */
export const batchDiscount = 0.5;

/**
 * Apify actors. IDs come from the environment (the shorter names are accepted
 * as aliases). Prices are per result, as listed on each actor's store page;
 * override them if the actor's price changes.
 */
export const apify = {
  instagramPostsActorId: process.env.APIFY_IG_POSTS_ACTOR_ID ?? process.env.APIFY_ACTOR_ID ?? "",
  instagramPostsFallbackActorId: process.env.APIFY_IG_POSTS_FALLBACK_ACTOR_ID ?? "",
  reelTranscriptActorId: process.env.APIFY_REEL_TRANSCRIPT_ACTOR_ID ?? process.env.APIFY_TRANSCRIPT_ACTOR_ID ?? "",
  usdPerPost: num("APIFY_USD_PER_POST", 0.0027),
  usdPerTranscript: num("APIFY_USD_PER_TRANSCRIPT", 0.015),
} as const;

/**
 * Artist tracking and official video (Prompt 10). Only artists with an event
 * in one of our cities soon, or pinned by the owner, are tracked.
 */
export const artistTracking = {
  get enabled() { return process.env.ARTIST_TRACKING !== "off"; },
  /** At most this many artists are tracked at once: pinned ones first, then the soonest events. */
  maxTracked: num("ARTIST_TRACKING_MAX", 40),
  /** An artist is tracked from this many days before an event... */
  upcomingDays: 30,
  /** ...until this many days after their last one. */
  stopAfterDays: 7,
  /** A little under three days between checks, so a daily job that drifts still picks artists up. */
  everyHours: 70,
  /** How far back to look the first time an artist is checked. */
  firstCheckLookbackDays: 14,
  /** Below this, the fast model's label is checked once by the mid tier. */
  minConfidence: 0.7,
  /** Words allowed in a release line. */
  updateMaxWords: 30,
  /** YouTube Data API key (free quota: 100 searches a day; everything else 10,000 units a day). */
  get youtubeApiKey() { return process.env.YOUTUBE_API_KEY ?? ""; },
  videosPerArtist: 5,
  /** Artists whose videos are looked up per run; each costs at most 2 of the day's 100 searches. */
  videoLookupsPerRun: num("ARTIST_VIDEO_LOOKUPS_PER_RUN", 10),
  /** Videos shorter than this are left out (Shorts and teasers are not an artist's best-known work). */
  minVideoSeconds: 61,
  /** Videos shown for an artist on an event page. */
  videosOnEventPage: 2,
} as const;

/** Ingestion tunables (Prompt 2). */
export const ingestion = {
  /** Latest posts fetched per handle per check. */
  postsPerHandle: 3,
  /** Tier A handles checked per city per day at most. */
  tierAMaxPerCity: 50,
  /** A little under a day / a week, so a cron that drifts still picks handles up. */
  tierAIntervalHours: 20,
  tierBIntervalHours: 6.5 * 24,
  /** How far back to look the first time a handle is checked. */
  firstCheckLookbackDays: 30,
  /** Handles sent to the actor in one run. */
  handlesPerActorRun: 25,
  /** Title, date and venue must all reach this to publish (hard rule 3). */
  publishConfidence: 0.8,
  /** Below this, a fast-tier answer is treated as unsure and escalated. */
  fastTierMinConfidence: 0.7,
  /** Poster images sent to the vision model per post. */
  maxImagesPerPost: 2,
  maxImageBytes: 4_500_000,
  /** Title similarity (0..1): at or above `same` is the same event, below `different` is not. */
  titleSimilarity: { same: 0.6, different: 0.25 },
  /** Added to an event's confidence when a second independent source confirms it. */
  secondSourceBoost: 0.1,
  /** Minutes to wait for a Message Batch before the job gives up. */
  batchMaxWaitMinutes: 120,
  description: { minWords: 60, maxWords: 120 },
} as const;

/**
 * Monthly budget caps in USD. Each paid call is charged to exactly one bucket.
 * "scrape" covers Apify and any other cash spend; "model" covers Claude API usage.
 * Sub-limits (e.g. reel transcripts) are carved out of a parent bucket and are
 * enforced in addition to it.
 */
export const budgets = {
  scrape: num("SCRAPE_BUDGET_USD", 50),
  model: num("MODEL_BUDGET_USD", 60),
  /** Sub-limit inside "scrape" so transcripts can never crowd out scraping. */
  reelTranscript: num("REEL_TRANSCRIPT_BUDGET_USD", 3),
  /** Sub-limit inside "scrape" for Google event result queries. */
  googleEvents: num("GOOGLE_EVENTS_BUDGET_USD", 3),
  /** Sub-limit inside "model" for reading local news event roundups. */
  newsCalendars: num("NEWS_CALENDARS_BUDGET_USD", 5),
  /** Sub-limit inside "model" for entity enrichment: research with web search, and the page text. */
  enrichment: num("ENRICHMENT_BUDGET_USD", 20),
  /** Sub-limit inside "model" for the second look: one web search lookup for a queued post with a missing fact. */
  secondLook: num("SECOND_LOOK_BUDGET_USD", 8),
  /** Sub-limit inside "model" for translating page text into Hindi. */
  translation: num("TRANSLATION_BUDGET_USD", 5),
  /** Sub-limit inside "model" for public submissions: reading snapped posters and pre-screening. */
  submissions: num("SUBMISSIONS_BUDGET_USD", 3),
  /** Sub-limit inside "scrape" (cash spend) for the weekly AI citation checks run through GeoGrid. */
  citations: num("CITATIONS_BUDGET_USD", 10),
  /** Sub-limit inside "model" for natural-language search: parsing queries the rules cannot read. */
  search: num("SEARCH_BUDGET_USD", 3),
  /** Sub-limit inside "scrape" for the weekly Instagram hashtag and location pull that finds new handles and venues (Prompt 9). */
  discovery: num("DISCOVERY_BUDGET_USD", 3),
  /** Sub-limit inside "scrape" for reading public Facebook event pages through Apify (Prompt 9). */
  facebookEvents: num("FACEBOOK_EVENTS_BUDGET_USD", 5),
  /**
   * Sub-limit inside "scrape" for reading the recent posts of public Facebook pages through Apify.
   * It also bounds the model spend on those posts, since only stored posts are ever read by a model.
   */
  facebookPosts: num("FACEBOOK_POSTS_BUDGET_USD", 10),
  /** Sub-limit inside "scrape" for checking tracked artists' Instagram posts (Prompt 10). */
  artistTracking: num("ARTIST_TRACKING_BUDGET_USD", 5),
  /** Sub-limit inside "model" for sorting tracked artists' posts and writing update lines and video notes (Prompt 10). */
  artistText: num("ARTIST_TEXT_BUDGET_USD", 3),
  /** Sub-limit inside "model" for reading events from web calendars and Facebook events (Prompt 9). */
  webCalendars: num("WEB_CALENDARS_BUDGET_USD", 3),
  /** Sub-limit inside "model" for the weekly roundup per city: one overview in English and Hindi per city per week (Prompt 11). */
  roundups: num("ROUNDUPS_BUDGET_USD", 2),
  /** Fraction of a cap at which a warning is logged. */
  warnAt: 0.8,
} as const;

export type BudgetBucket = "scrape" | "model";
export type SubBudget =
  | "secondLook"
  | "reelTranscript" | "googleEvents" | "newsCalendars" | "enrichment" | "translation" | "submissions" | "search" | "citations"
  | "discovery" | "facebookEvents" | "facebookPosts" | "webCalendars" | "artistTracking" | "artistText" | "roundups";

export const subBudgetParent: Record<SubBudget, BudgetBucket> = {
  reelTranscript: "scrape",
  googleEvents: "scrape",
  newsCalendars: "model",
  enrichment: "model",
  secondLook: "model",
  translation: "model",
  submissions: "model",
  search: "model",
  citations: "scrape",
  discovery: "scrape",
  facebookEvents: "scrape",
  facebookPosts: "scrape",
  webCalendars: "model",
  artistTracking: "scrape",
  artistText: "model",
  roundups: "model",
};

/**
 * Daily caps (USD, per calendar day in UTC) on top of a sub-budget's monthly
 * cap, for features any visitor can trigger. The budget guard refuses a call
 * that would cross either one.
 */
export const dailyCaps: Partial<Record<SubBudget, number>> = {
  search: num("SEARCH_DAILY_BUDGET_USD", 0.25),
};

/**
 * Entity enrichment (Prompt 4): the weekly job that fills in venue, artist and
 * organiser pages from public sources.
 */
export const enrichment = {
  /** A run stops starting new entities once it has spent this much (a quarter of the monthly limit by default). */
  perRunUsd: num("ENRICHMENT_RUN_BUDGET_USD", budgets.enrichment / 4),
  /** Entities of each type a run takes on at most, most-referenced first. */
  perRunLimit: { venue: 8, artist: 8, organiser: 4 },
  /** Reserved against the budget before an entity's research call; replaced by the measured cost. */
  estResearchUsd: 0.25,
  /** Anthropic's web search tool is billed per search, on top of tokens. Checked 2026-11-18. */
  usdPerSearch: 0.01,
  maxSearches: 4,
  maxFetches: 3,
  /** Tokens of each fetched page the model is given. */
  maxFetchTokens: 6000,
  /** A fact below this confidence goes to the review queue, not onto the page. */
  minConfidence: 0.7,
  /** Fewer accepted facts than this and no text is written: the page stays a stub. */
  minFactsForText: 2,
  text: { minWords: 30, maxWords: 110 },
  /** Apify actor that reads an Instagram profile's own bio (the entity's first-party source). */
  profileActorId: process.env.APIFY_IG_PROFILE_ACTOR_ID ?? "apify/instagram-scraper",
  usdPerProfile: num("APIFY_USD_PER_PROFILE", apify.usdPerPost),
  /**
   * Sources that anyone can edit or that list businesses unchecked. A fact that
   * rests on just one of these is left out; two that agree are accepted.
   */
  weakDomains: [
    "justdial.com", "sulekha.com", "magicpin.in", "tripadvisor.com", "tripadvisor.in", "quora.com", "reddit.com", "pinterest.com",
    "facebook.com", "x.com", "twitter.com", "linkedin.com", "medium.com", "blogspot.com", "wordpress.com", "wikipedia.org",
    "fandom.com", "yelp.com", "foursquare.com", "indiamart.com", "tradeindia.com", "wanderlog.com", "restaurant-guru.in",
    "restaurantguru.com", "nearbuy.com", "dineout.co.in", "eazydiner.com", "zomato.com", "swiggy.com", "mouthshut.com",
    "wedmegood.com", "venuelook.com", "weddingwire.in", "allevents.in", "eventbrite.com", "townscript.com", "imdb.com",
  ],
  /** Official platforms an artist's notable works may link out to. Host suffix to display name. */
  workPlatforms: {
    "youtube.com": "YouTube", "youtu.be": "YouTube", "music.youtube.com": "YouTube Music", "spotify.com": "Spotify",
    "music.apple.com": "Apple Music", "jiosaavn.com": "JioSaavn", "gaana.com": "Gaana", "soundcloud.com": "SoundCloud",
    "bandcamp.com": "Bandcamp", "music.amazon.in": "Amazon Music", "primevideo.com": "Prime Video", "netflix.com": "Netflix",
    "hotstar.com": "JioHotstar", "sonyliv.com": "SonyLIV", "zee5.com": "ZEE5",
  } as Record<string, string>,
} as const;

/**
 * Second look (the owner's decisions of 19 Nov 2026). A post left in the review
 * queue only because its title, venue, date or city could not be established is
 * checked against our own listings (free) and then looked up once through
 * Anthropic's web search. We never fetch the pages themselves: the facts come
 * from the search results, and a fact counts only when a returned page about the
 * same event states it.
 */
export const secondLook = {
  /** Off until SECOND_LOOK=on is set on the job service, so a deploy alone never starts paid lookups. */
  get enabled() { return process.env.SECOND_LOOK === "on"; },
  /**
   * "Click first" is the default: a found fact waits in the review queue for one click.
   * SECOND_LOOK_PUBLISH=on lets a fact that passes every check publish without the click.
   */
  get publish() { return process.env.SECOND_LOOK_PUBLISH === "on"; },
  /** Paid lookups a run makes at most. */
  maxPerRun: num("SECOND_LOOK_MAX_PER_RUN", 15),
  /** Web searches one lookup may make. Page fetch is never offered. */
  maxSearches: 2,
  maxTokens: 4000,
  /**
   * Reserved against the budget before a lookup's search request; replaced by the measured cost.
   * First production run (19 Nov 2026): 3 lookups cost $0.391 in all, about $0.13 each with reading the notes.
   */
  estResearchUsd: 0.12,
  /** A looked-up fact below this confidence is shown to the reviewer but not counted as found. */
  minConfidence: 0.8,
  /** How often the reading of a lookup's notes is tried before the lookup is recorded as having found nothing. */
  maxReadAttempts: 2,
  /** Ticketing sites whose own event pages count as good sources (they sell the ticket; we link to them for booking). */
  goodDomains: ["district.in", "bookmyshow.com"],
  /** Weak on top of `enrichment.weakDomains` (which has allevents.in): copies of AllEvents' data. Such a fact needs a second site. */
  weakDomains: ["stayhappening.com", "happeningnext.com"],
} as const;

/**
 * Launch sources beyond Instagram (Prompt 2, step 8). Each has its own monthly
 * limit in `budgets` and its own line in the run report.
 */
export const webSources = {
  google: {
    /** DataForSEO Google organic SERP (live); events come from the "events" block of the result page. */
    usdPerQuery: num("GOOGLE_EVENTS_USD_PER_QUERY", 0.002),
    /** {city} is replaced with the city name. One request per query per day. */
    queries: [
      "events in {city} this week",
      "{city} events this weekend",
      "live music in {city}",
      "comedy shows in {city}",
      "workshops in {city} this week",
    ],
  },
  news: {
    /**
     * Keys of the news sources that are switched on, comma-separated, e.g. "fpj,patrika".
     * Empty by default: a source is only fetched once its terms have been reviewed
     * (see docs/sources.md). robots.txt is checked again on every run.
     */
    enabled: (process.env.NEWS_SOURCES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    userAgent: "PickTheJointBot/1.0 (+https://pickthejoint.com/about)",
    /** Roundup articles read per source per day. */
    maxArticlesPerDay: 3,
    /** Pause between requests to the same site. */
    delayMs: 5000,
    maxArticleChars: 9000,
    sources: [
      { key: "fpj", name: "Free Press Journal (Indore)", city: "indore", sectionUrl: "https://www.freepressjournal.in/indore",
        articlePattern: "^https://www\\.freepressjournal\\.in/indore/[a-z0-9-]+$" },
      { key: "patrika", name: "Patrika (Indore)", city: "indore", sectionUrl: "https://www.patrika.com/indore-news",
        articlePattern: "^https://www\\.patrika\\.com/indore-news/[a-z0-9-]+$" },
    ],
  },
} as const;

/**
 * Wider sourcing (Prompt 9). What each city's sources are (census area,
 * hashtags, web calendars) lives in data/sourcing.json, so adding a city needs
 * no code change. Every paid call goes through the budget guard with its own
 * sub-budget above. Terms and robots.txt findings: docs/sources.md.
 */
export const sourcing = {
  userAgent: "PickTheJointBot/1.0 (+https://pickthejoint.com/about)",
  /** Pause between requests to the same site. */
  delayMs: 5000,
  census: {
    /** OpenStreetMap's Overpass API: free, no account; the data needs attribution ("© OpenStreetMap contributors"). */
    overpassUrl: process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter",
    /** OSM tag filters and the venue type each maps to. Only named places are taken. */
    osmFilters: [
      { key: "amenity", values: "theatre|arts_centre", type: "auditorium" },
      { key: "amenity", values: "events_venue|conference_centre|exhibition_centre", type: "hotel_banquet" },
      { key: "amenity", values: "nightclub|bar|pub", type: "club_bar" },
      { key: "amenity", values: "cafe", type: "cafe", also: { key: "live_music", value: "yes" } },
      { key: "tourism", values: "hotel", type: "hotel_banquet" },
      { key: "shop", values: "mall", type: "mall" },
      { key: "amenity", values: "college|university", type: "college" },
      { key: "amenity", values: "community_centre", type: "community" },
      { key: "tourism", values: "museum|gallery", type: "cultural_centre" },
      { key: "leisure", values: "stadium", type: "ground" },
      { key: "landuse", values: "recreation_ground", type: "ground" },
      { key: "amenity", values: "place_of_worship", type: "religious" },
    ] as { key: string; values: string; type: string; also?: { key: string; value: string } }[],
    /** Days without an event after which a venue shows in the admin "no recent event" list. */
    quietDays: 60,
  },
  discovery: {
    /** Apify actor for hashtag and location pages (the same Instagram actor ingestion uses). */
    actorId: process.env.APIFY_DISCOVERY_ACTOR_ID ?? "apify/instagram-scraper",
    /** Hard cap on posts pulled per city per week, across all hashtags and locations. */
    maxPostsPerWeek: num("DISCOVERY_MAX_POSTS_PER_WEEK", 200),
    /**
     * Instagram location tags pulled per week (the most-seen ones first). 0 until a test run shows the
     * actor returns posts for location pages; it may return only the place's details.
     */
    locationsPerWeek: num("DISCOVERY_LOCATIONS_PER_WEEK", 0),
    everyHours: 6.5 * 24,
  },
  facebook: {
    /** Reads public event pages logged out; no Facebook account is used. */
    actorId: process.env.APIFY_FACEBOOK_EVENTS_ACTOR_ID ?? "apify/facebook-events-scraper",
    enabled: process.env.FACEBOOK_EVENTS !== "off",
    /** Apify's price on the owner's plan, checked 18 Nov 2026: per event returned, plus one charge per run. */
    usdPerEvent: num("APIFY_USD_PER_FB_EVENT", 0.01),
    usdPerRun: 0.001,
    /** Logged out, a page shows about this many upcoming events. */
    maxEventsPerPage: 8,
    /**
     * The guard prices a run at every page returning its full 8 events, so this many pages must fit
     * under the monthly limit: 30 pages is $2.40 against the default $5.
     */
    maxPagesPerRun: num("FACEBOOK_MAX_PAGES_PER_RUN", 30),
    everyHours: 6.5 * 24,
  },
  /**
   * Recent posts of the same public Facebook pages (the owner's decision of 19 Nov 2026): most pages
   * announce events in ordinary posts, not through Facebook's Events feature. Read logged out through
   * Apify; new posts go through the same filter, extraction and publishing rules as Instagram posts.
   */
  facebookPosts: {
    actorId: process.env.APIFY_FACEBOOK_POSTS_ACTOR_ID ?? "apify/facebook-posts-scraper",
    /** Off until FACEBOOK_POSTS=on is set on the job service, so a deploy alone never starts paid runs. */
    get enabled() { return process.env.FACEBOOK_POSTS === "on"; },
    /**
     * Apify's list price, read 19 Nov 2026: $0.005 a post plus $0.002 for the "newer than" filter, which
     * stops us paying for posts we already have. Paid plans are cheaper; set APIFY_USD_PER_FB_POST to match.
     */
    usdPerPost: num("APIFY_USD_PER_FB_POST", 0.007),
    /** Per tier: hours between checks (a little under 2, 7 and 14 days) and the newest posts taken per check. */
    tiers: {
      A: { everyHours: 44, posts: 3 },
      B: { everyHours: 6.5 * 24, posts: 3 },
      C: { everyHours: 13.5 * 24, posts: 2 },
    },
    /** A page with this many posts read and not one that led to an event is read at the tier C pace. */
    quietAfterPosts: 12,
    /** How far back to look the first time a page is read. */
    firstCheckLookbackDays: 21,
    pagesPerActorRun: 25,
    maxPagesPerRun: num("FACEBOOK_POSTS_MAX_PAGES_PER_RUN", 60),
    /** Characters of post text (and text read off its image) kept. */
    maxChars: 5000,
  },
  calendars: {
    /** Comma-separated calendar keys to switch on; when unset, the `enabled` flags in data/sourcing.json apply. */
    enabled: process.env.WEB_CALENDARS === undefined
      ? undefined
      : process.env.WEB_CALENDARS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    /** New items (pages or events) read with the model per source per run. */
    maxPagesPerRun: 30,
    /** Pages fetched per source per run, including ones set aside without a model call. */
    maxFetchesPerRun: 150,
    /** Characters of page text passed to the extraction model. */
    maxChars: 9000,
  },
  tiering: {
    /** Events found in the last 30 days that make a handle tier A at the monthly re-tier. */
    tierAMinEvents: 2,
    /** A suggested handle credited in at least this many event posts is offered at tier A. */
    suggestTierAMinEventPosts: 3,
    /** A handle that has produced no event for this long is paused. */
    pauseAfterDays: 90,
    /** A tier the admin set by hand is left alone by the re-tier for this long. */
    manualHoldDays: 30,
    everyHours: 27 * 24,
  },
} as const;

export const locales = ["en", "hi"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/**
 * Hindi translation (Prompt 5). New and changed text is translated at the end
 * of the ingest and enrich jobs once TRANSLATION=on is set on those services;
 * `npm run translate:backfill` does the same on demand.
 */
export const translation = {
  enabled: process.env.TRANSLATION === "on",
  /** Short items (names, prices) and long ones (descriptions) share a request up to these limits. */
  itemsPerRequest: 24,
  charsPerRequest: 4500,
} as const;

export const displayTimeZone = "Asia/Kolkata";

/**
 * Weekly roundup per city (Prompt 11). The ingest job drafts one each Thursday (IST) for the Friday
 * to Thursday ahead; the admin publishes it. ROUNDUPS=off stops the drafting.
 */
export const roundups = {
  enabled: process.env.ROUNDUPS !== "off",
  weekday: "Thursday",
  /** No guide for a week with fewer events than this. */
  minEvents: 3,
  /** "Free this weekend" and "For families" appear only with at least this many events each. */
  minForExtraSection: 3,
  /** Events listed to the model for the overview; the article itself lists all of them. */
  maxEventsInPrompt: 60,
  introMinWords: 70,
  introMaxWords: 140,
} as const;

/**
 * AI crawler user-agent tokens: training, search and live-fetch agents.
 * Names as published in each vendor's crawler documentation; re-check before
 * Prompt 3 (robots.txt) and Prompt 3b (crawl access check).
 */
export const aiCrawlers: { token: string; vendor: string; purpose: "training" | "search" | "user-fetch" }[] = [
  { token: "GPTBot", vendor: "OpenAI", purpose: "training" },
  { token: "OAI-SearchBot", vendor: "OpenAI", purpose: "search" },
  { token: "ChatGPT-User", vendor: "OpenAI", purpose: "user-fetch" },
  { token: "ClaudeBot", vendor: "Anthropic", purpose: "training" },
  { token: "Claude-SearchBot", vendor: "Anthropic", purpose: "search" },
  { token: "Claude-User", vendor: "Anthropic", purpose: "user-fetch" },
  { token: "PerplexityBot", vendor: "Perplexity", purpose: "search" },
  { token: "Perplexity-User", vendor: "Perplexity", purpose: "user-fetch" },
  { token: "Google-Extended", vendor: "Google", purpose: "training" },
  { token: "Googlebot", vendor: "Google", purpose: "search" },
  { token: "Bingbot", vendor: "Microsoft", purpose: "search" },
  { token: "Applebot", vendor: "Apple", purpose: "search" },
  { token: "Applebot-Extended", vendor: "Apple", purpose: "training" },
  { token: "Meta-ExternalAgent", vendor: "Meta", purpose: "training" },
  { token: "CCBot", vendor: "Common Crawl", purpose: "training" },
  { token: "DuckAssistBot", vendor: "DuckDuckGo", purpose: "user-fetch" },
  { token: "MistralAI-User", vendor: "Mistral", purpose: "user-fetch" },
];

export const site = {
  name: "Pick the Joint",
  url: (process.env.SITE_URL ?? "https://pickthejoint.com").replace(/\/+$/, ""),
  /** Address for corrections and takedown requests, shown on the corrections page. */
  contactEmail: process.env.CONTACT_EMAIL ?? "",
  /** Pick the Joint's own official profiles (comma-separated URLs), linked as sameAs on the Organization. */
  profiles: (process.env.SITE_PROFILES ?? "").split(",").map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s)),
} as const;

/**
 * IndexNow (Bing and the engines that share its index). The key is public by
 * design: it is served at /{key}.txt from the public folder so engines can
 * check that pings come from this site. Pings are only sent when INDEXNOW=on,
 * so local runs never announce URLs.
 */
export const indexNow = {
  key: "d632b94e7b1106de3376c2c8b5b6b82b",
  endpoint: "https://api.indexnow.org/indexnow",
  enabled: process.env.INDEXNOW === "on",
} as const;

/** Job alerts, sent by email through Resend. Without RESEND_API_KEY and ALERT_FROM an alert is logged, not sent. */
export const alerts = {
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  from: process.env.ALERT_FROM ?? "",
  to: process.env.ALERT_TO ?? process.env.CONTACT_EMAIL ?? "",
} as const;

/**
 * User submissions and posters (Prompt 6). Nothing submitted is published
 * until the admin approves it.
 */
export const submissions = {
  turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "",
  turnstileSecret: process.env.TURNSTILE_SECRET_KEY ?? "",
  /** Per hashed IP address. */
  limits: {
    form: { max: 5, windowMinutes: 60 },
    formDaily: { max: 15, windowMinutes: 24 * 60 },
    poster: { max: 6, windowMinutes: 24 * 60 },
    /** Failed admin sign-ins. */
    login: { max: 5, windowMinutes: 15 },
  },
  /** Accepted upload types, checked from the file's bytes, not its name. */
  imageFormats: ["jpeg", "png", "webp"] as readonly string[],
  maxUploadBytes: 8 * 1024 * 1024,
  /** Posters dropped into the admin inbox at once. */
  maxInboxFiles: 12,
  /** Long edge of the stored copy: enough for the vision model to read small print. */
  storedLongEdge: 1600,
  /** Poster photos are deleted this long after the event, or after upload when no event came of them. */
  keepDaysAfterEvent: 1,
  keepDaysUnused: 7,
  /** Drafts never sent are deleted after this many days, with their poster. */
  draftDays: 2,
} as const;

/** The single-admin area (Prompt 6). */
export const admin = {
  /** Set on the web service to open /admin/setup once; remove it afterwards. */
  setupToken: process.env.ADMIN_SETUP_TOKEN ?? "",
  /** ADMIN_RESET=on lets the setup page replace an existing password (the setup token is still needed). */
  allowReset: process.env.ADMIN_RESET === "on",
  sessionHours: 12,
  minPasswordLength: 14,
} as const;

/** The poster email address, through Resend's inbound email (Prompt 6). */
export const inbound = {
  /** Signing secret of the Resend webhook for the email.received event ("whsec_..."). */
  webhookSecret: process.env.RESEND_INBOUND_WEBHOOK_SECRET ?? "",
  /** Only mail from these senders is read (comma-separated addresses); anything else is dropped. */
  allowedSenders: (process.env.POSTER_EMAIL_SENDERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** City the emailed posters are filed under. */
  city: (process.env.POSTER_EMAIL_CITY ?? "indore").toLowerCase(),
} as const;

/**
 * Natural-language search (Prompt 7). Rules read the common patterns; the fast
 * tier is asked only when they cannot, and its answers are cached.
 */
export const search = {
  /** Longest query read; anything after this is ignored. */
  maxQueryChars: 200,
  /** Model parses per hashed IP address. Past either limit the search falls back to keywords. */
  limits: {
    hour: { max: 20, windowMinutes: 60 },
    day: { max: 60, windowMinutes: 24 * 60 },
  },
  /** A cached parse is reused for this long, then asked again (filter values change). */
  cacheDays: 30,
  /** Leftover words the rules may treat as search words without asking the model. */
  maxRuleKeywords: 2,
  /** Reserved against the budget before a parse; replaced by the measured cost. */
  estInputTokens: 1200,
  estOutputTokens: 150,
} as const;

/**
 * Citation tracker (Prompt 8). The AI engines are asked through the owner's
 * GeoGrid tool from the owner's own computer (scripts/citations/geogrid_run.py), with
 * GeoGrid's own keys; the results file is imported in /admin/citations.
 * Engines without an automated route are entered by hand.
 */
export const citations = {
  ourDomain: "pickthejoint.com",
  /** The site's name as an answer may write it. */
  namePatterns: [/pick\s*the\s*joint/i, /pickthejoint/i, /पिक\s*द\s*ज[ॉो]इंट/],
  engines: [
    { key: "chatgpt", label: "ChatGPT", automated: true },
    { key: "gemini", label: "Gemini", automated: true },
    { key: "perplexity", label: "Perplexity", automated: true },
    { key: "google_aio", label: "Google AI Overviews", automated: true },
    { key: "copilot", label: "Microsoft Copilot", automated: false },
    { key: "claude", label: "Claude", automated: false },
  ],
  /** GeoGrid's engine labels to ours. */
  geogridLabels: { ChatGPT: "chatgpt", Gemini: "gemini", Perplexity: "perplexity", "Google AI Overviews": "google_aio" } as Record<string, string>,
  /** Event listing and ticketing sites; a cited host matching one of these (or a subdomain) is a competitor. */
  competitors: [
    "district.in", "bookmyshow.com", "insider.in", "paytminsider.com", "allevents.in", "eventbrite.com", "eventbrite.co.in",
    "townscript.com", "skillboxes.com", "highape.com", "meraevents.com", "explara.com", "ticketnew.com", "zomato.com",
    "eventshigh.com", "knowafest.com", "songkick.com", "bandsintown.com", "sortmyscene.com", "urbanaut.app", "ticketsterrace.com",
    // Seen in the baseline run, 18 Nov 2026.
    "stayhappening.com", "happeningnext.com", "mepass.in",
  ],
  /** Longest answer text kept per check (admin only). */
  excerptChars: 4000,
  /** Ceiling the admin page suggests for one run, in USD (GeoGrid stops at it). */
  maxRunUsd: 3,
} as const;
