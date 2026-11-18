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
  /** Fraction of a cap at which a warning is logged. */
  warnAt: 0.8,
} as const;

export type BudgetBucket = "scrape" | "model";
export type SubBudget = "reelTranscript" | "googleEvents" | "newsCalendars";

export const subBudgetParent: Record<SubBudget, BudgetBucket> = {
  reelTranscript: "scrape",
  googleEvents: "scrape",
  newsCalendars: "model",
};

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

export const locales = ["en", "hi"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export const displayTimeZone = "Asia/Kolkata";

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
