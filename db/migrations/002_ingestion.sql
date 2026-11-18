-- Prompt 2: ingestion pipeline support.

-- raw_posts now also holds items from the non-Instagram launch sources.
-- For those, `shortcode` is "<kind>:<hash>" and `handle` is the source key.
ALTER TABLE raw_posts
  ADD COLUMN source_kind text NOT NULL DEFAULT 'instagram'
    CHECK (source_kind IN ('instagram', 'google', 'news')),
  ADD COLUMN city_id bigint REFERENCES cities(id),
  ADD COLUMN transcript text,                    -- reel speech; informs facts only, never published
  ADD COLUMN transcript_requested_at timestamptz, -- set once; an empty transcript is not retried
  ADD COLUMN processed_at timestamptz;
CREATE INDEX raw_posts_kind_idx ON raw_posts (source_kind, fetched_at DESC);

-- Date of the event in its city's timezone (dedup key), and whether the
-- source stated a start time (if not, starts_at is local midnight and pages
-- must not show a time).
ALTER TABLE events
  ADD COLUMN local_date date,
  ADD COLUMN start_time_known boolean NOT NULL DEFAULT true;
CREATE INDEX events_dedup_idx ON events (city_id, venue_id, local_date);

-- A post supports an event at most once.
CREATE UNIQUE INDEX sources_event_post_idx ON sources (event_id, raw_post_id) WHERE raw_post_id IS NOT NULL;

-- Last fetch per non-Instagram source, so each is fetched at most once a day.
CREATE TABLE source_state (
  source_key      text PRIMARY KEY,
  last_fetched_at timestamptz,
  last_status     text
);
