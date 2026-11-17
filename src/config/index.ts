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

/** Apify actors. Set the real IDs from the Apify console. */
export const apify = {
  instagramPostsActorId: process.env.APIFY_IG_POSTS_ACTOR_ID ?? "",
  instagramPostsFallbackActorId: process.env.APIFY_IG_POSTS_FALLBACK_ACTOR_ID ?? "",
  reelTranscriptActorId: process.env.APIFY_REEL_TRANSCRIPT_ACTOR_ID ?? "",
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
  /** Fraction of a cap at which a warning is logged. */
  warnAt: 0.8,
} as const;

export type BudgetBucket = "scrape" | "model";
export type SubBudget = "reelTranscript";

export const subBudgetParent: Record<SubBudget, BudgetBucket> = {
  reelTranscript: "scrape",
};

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
  url: process.env.SITE_URL ?? "https://pickthejoint.com",
} as const;
