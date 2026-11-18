-- Prompt 8: citation tracker and public proof.
-- citation_queries and citation_results exist since Prompt 1; this adds what
-- an automated run records and what the weekly figures need.

-- The fixed questions, in the order they are shown. Loaded from
-- data/citation-queries.json by the seed.
ALTER TABLE citation_queries ADD COLUMN position int NOT NULL DEFAULT 0;

-- One row per question, engine and week (IST weeks, starting Monday).
-- `answered` is false when the engine gave nothing to judge (Google showed no
-- AI Overview, or the request failed): such a check is left out of the share.
ALTER TABLE citation_results
  ADD COLUMN answered       boolean NOT NULL DEFAULT true,
  ADD COLUMN cited_urls     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- every source the answer cited
  ADD COLUMN our_urls       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- the pickthejoint.com pages among them
  ADD COLUMN answer_excerpt text,                                -- admin only, never on a public page
  ADD COLUMN model          text,
  ADD COLUMN cost_usd       numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  ADD COLUMN asked_at       timestamptz,
  ADD COLUMN run_id         text,
  ADD COLUMN note           text;
CREATE INDEX citation_results_week_idx ON citation_results (week_start);

-- Each imported results file, once. Its cost is logged in cost_log when it is imported.
CREATE TABLE citation_runs (
  run_id      text PRIMARY KEY,
  tool        text NOT NULL,
  week_start  date NOT NULL,
  asked_at    timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  checks      int NOT NULL,
  answered    int NOT NULL,
  cost_usd    numeric(12, 6) NOT NULL DEFAULT 0,
  engines     jsonb NOT NULL DEFAULT '{}'::jsonb,
  report      jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Free first-party sources, entered by hand or from a CSV each week:
-- Bing Webmaster Tools' AI Performance report and Search Console's performance data.
CREATE TABLE first_party_stats (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source       text NOT NULL CHECK (source IN ('bing_ai', 'search_console')),
  week_start   date NOT NULL,
  citations    int,
  cited_pages  int,
  impressions  int,
  clicks       int,
  avg_position numeric(6, 2),
  note         text,
  entered_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, week_start)
);

-- What the site had live each week, kept because it cannot be worked out
-- afterwards (events end, pages come and go). Housekeeping updates the current
-- week every day; the last value of a week stands.
CREATE TABLE weekly_snapshots (
  week_start  date PRIMARY KEY,
  live_events int NOT NULL,
  venues      int NOT NULL,
  artists     int NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
