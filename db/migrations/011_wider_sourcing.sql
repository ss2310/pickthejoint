-- Prompt 9: wider sourcing.

-- 1. Venue census: places in a city where events happen, whether or not we
-- have listed an event there yet. Kept apart from `venues` so a place gets a
-- public page only once it has a published event. Admin only.
CREATE TABLE venue_census (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  city_id          bigint NOT NULL REFERENCES cities(id),
  name             text NOT NULL,
  name_key         text NOT NULL,
  -- auditorium, club_bar, cafe, hotel_banquet, mall, college, cultural_centre, ground, religious, community, other
  venue_type       text NOT NULL DEFAULT 'other',
  address          text,
  lat              double precision,
  lng              double precision,
  -- Where the row came from: OpenStreetMap, an Instagram location tag, a CSV or the admin, or an event's venue.
  source           text NOT NULL CHECK (source IN ('osm', 'instagram_location', 'manual', 'event')),
  source_ref       text,             -- e.g. "node/123" or an Instagram location id
  instagram_handle text,
  facebook_url     text,
  website          text,
  venue_id         bigint REFERENCES venues(id) ON DELETE SET NULL,
  ignored          boolean NOT NULL DEFAULT false,
  seen_count       int NOT NULL DEFAULT 1,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX venue_census_ref_idx ON venue_census (city_id, source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX venue_census_name_idx ON venue_census (city_id, name_key);
CREATE INDEX venue_census_venue_idx ON venue_census (venue_id);

-- 2. Handles: automatic tiering and pausing (monthly), with a log of changes.
ALTER TABLE handles
  ADD COLUMN tier_set_by   text NOT NULL DEFAULT 'import' CHECK (tier_set_by IN ('import', 'manual', 'auto')),
  ADD COLUMN tier_set_at   timestamptz,
  ADD COLUMN paused_reason text;

CREATE TABLE handle_changes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handle_id   bigint NOT NULL REFERENCES handles(id) ON DELETE CASCADE,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  from_tier   char(1),
  to_tier     char(1),
  from_active boolean,
  to_active   boolean,
  reason      text NOT NULL
);
CREATE INDEX handle_changes_time_idx ON handle_changes (changed_at DESC);

-- 3. Suggested handles: how they were found, and how many event posts credited them.
ALTER TABLE suggested_handles
  ADD COLUMN via          text[] NOT NULL DEFAULT '{}',   -- event_post, hashtag, location
  ADD COLUMN event_posts  int NOT NULL DEFAULT 0,
  ADD COLUMN last_seen_at timestamptz;
UPDATE suggested_handles SET via = '{event_post}', event_posts = seen_count, last_seen_at = updated_at;

-- 4. Items from the new sources, and the model spend on each item (filter, extraction, dedup and its
-- event's description), so cost per published event can be reported by source. Scraping costs are in cost_log.
ALTER TABLE raw_posts DROP CONSTRAINT raw_posts_source_kind_check;
ALTER TABLE raw_posts ADD CONSTRAINT raw_posts_source_kind_check
  CHECK (source_kind IN ('instagram', 'google', 'news', 'web', 'facebook'));
ALTER TABLE raw_posts ADD COLUMN model_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (model_usd >= 0);

-- 5. Public Facebook pages whose upcoming events are read (logged out, through Apify).
CREATE TABLE facebook_pages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  city_id         bigint NOT NULL REFERENCES cities(id),
  page            text NOT NULL,     -- the page's path on facebook.com, e.g. "fleamarketindore"
  name            text,
  venue_id        bigint REFERENCES venues(id) ON DELETE SET NULL,
  organiser_id    bigint REFERENCES organisers(id) ON DELETE SET NULL,
  added_via       text NOT NULL DEFAULT 'manual' CHECK (added_via IN ('manual', 'official_link', 'census')),
  active          boolean NOT NULL DEFAULT true,
  last_checked_at timestamptz,
  events_seen     int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, page)
);

-- 6. Series: what attaches an event to a recurring festival, and its sources.
ALTER TABLE series
  ADD COLUMN aliases text[] NOT NULL DEFAULT '{}',  -- words in an event title that mark it as this series
  ADD COLUMN months  int[] NOT NULL DEFAULT '{}';   -- months (1-12, local time) an edition can fall in; empty = any
ALTER TABLE entity_sources DROP CONSTRAINT entity_sources_entity_type_check;
ALTER TABLE entity_sources ADD CONSTRAINT entity_sources_entity_type_check
  CHECK (entity_type IN ('venue', 'artist', 'organiser', 'series'));

-- 7. Weekly coverage report per city (IST weeks starting Monday).
CREATE TABLE coverage_reports (
  city_id    bigint NOT NULL REFERENCES cities(id),
  week_start date NOT NULL,
  report     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, week_start)
);
