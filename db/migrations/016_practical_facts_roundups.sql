-- Prompt 11: practical facts on event pages, and the weekly roundup per city.

-- 1. Practical facts. One answer per question per event or venue, each with the source it came from.
-- Venue-level facts (parking, accessibility, how to reach) are stored on the venue and shown on every
-- event there. Only facts a source states are stored; an unknown fact is simply absent (hard rule 3).
CREATE TABLE practical_facts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type    text NOT NULL CHECK (entity_type IN ('event', 'venue')),
  entity_id      bigint NOT NULL,
  fact_key       text NOT NULL,
  answer         text NOT NULL,
  -- Where it came from: a scraped post or page, the organiser (a reviewed submission), or the admin.
  source_type    text NOT NULL CHECK (source_type IN ('post', 'organiser', 'admin')),
  source_url     text,
  raw_post_id    bigint REFERENCES raw_posts(id) ON DELETE SET NULL,
  submission_id  bigint REFERENCES submissions(id) ON DELETE SET NULL,
  confidence     real,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, fact_key)
);

-- 2. Weekly roundups: one draft per city each Thursday, published by the admin in one click.
-- The overview is written by the model in both languages; the event lines are drawn from the
-- database when the page is shown, so a cancellation or correction reaches the article too.
CREATE TABLE roundups (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  city_id       bigint NOT NULL REFERENCES cities(id),
  slug          text NOT NULL,                    -- "2026-week-48"
  period_start  date NOT NULL,                    -- the Friday
  period_end    date NOT NULL,                    -- the Thursday after
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  title         text NOT NULL,
  intro         text NOT NULL,
  title_hi      text,
  intro_hi      text,
  -- [{ "key": "music" | "free" | "families", "event_ids": [..] }], in reading order
  sections      jsonb NOT NULL DEFAULT '[]'::jsonb,
  event_ids     bigint[] NOT NULL DEFAULT '{}',
  model_usd     numeric(10, 5) NOT NULL DEFAULT 0,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, slug)
);
CREATE INDEX roundups_city_status_idx ON roundups (city_id, status, period_start DESC);
