-- Pick the Joint: initial schema.
-- All timestamps are timestamptz (stored as UTC, shown in Asia/Kolkata).
-- Status-like columns use CHECK constraints rather than enum types so values
-- can be added later with a simple constraint swap.

-- ---------------------------------------------------------------- places

CREATE TABLE cities (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  state       text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Asia/Kolkata',
  is_live     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE areas (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  city_id     bigint NOT NULL REFERENCES cities(id),
  slug        text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, slug)
);

CREATE TABLE categories (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- entities

CREATE TABLE venues (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  city_id           bigint NOT NULL REFERENCES cities(id),
  area_id           bigint REFERENCES areas(id),
  slug              text NOT NULL,
  name              text NOT NULL,
  venue_type        text,
  address           text,
  lat               double precision,
  lng               double precision,
  geocode_confidence real,
  capacity          int,
  parking           text,
  how_to_reach      text,
  description       text,
  official_links    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"instagram": "...", "website": "..."}
  same_as           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- Wikipedia / Wikidata etc.
  needs_enrichment  boolean NOT NULL DEFAULT true,
  enriched_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  search_tsv        tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(address, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'C')
  ) STORED,
  UNIQUE (city_id, slug)
);
CREATE INDEX venues_search_idx ON venues USING gin (search_tsv);
CREATE INDEX venues_area_idx ON venues (area_id);

CREATE TABLE artists (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  kind              text NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'group')),
  genre             text,
  hometown          text,
  bio               text,
  official_links    jsonb NOT NULL DEFAULT '{}'::jsonb,
  same_as           jsonb NOT NULL DEFAULT '[]'::jsonb,
  needs_enrichment  boolean NOT NULL DEFAULT true,
  enriched_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  search_tsv        tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(genre, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(bio, '')), 'C')
  ) STORED
);
CREATE INDEX artists_search_idx ON artists USING gin (search_tsv);

CREATE TABLE organisers (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  bio               text,
  official_links    jsonb NOT NULL DEFAULT '{}'::jsonb,
  same_as           jsonb NOT NULL DEFAULT '[]'::jsonb,
  needs_enrichment  boolean NOT NULL DEFAULT true,
  enriched_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Facts behind artist/venue/organiser text. Every published fact about an
-- entity must trace to a row here (hard rule 6).
CREATE TABLE entity_sources (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type  text NOT NULL CHECK (entity_type IN ('venue', 'artist', 'organiser')),
  entity_id    bigint NOT NULL,
  url          text NOT NULL,
  title        text,
  fact         text,          -- the fact this source supports, in our words
  retrieved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entity_sources_entity_idx ON entity_sources (entity_type, entity_id);

CREATE TABLE series (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  city_id      bigint REFERENCES cities(id),  -- null for multi-city series
  description  text,
  recurrence   text,                          -- e.g. "annual, January"
  official_links jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- events

CREATE TABLE events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  city_id           bigint NOT NULL REFERENCES cities(id),
  venue_id          bigint REFERENCES venues(id),
  category_id       bigint REFERENCES categories(id),
  series_id         bigint REFERENCES series(id),
  slug              text NOT NULL,
  title             text NOT NULL,
  description       text,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz,
  price_text        text,
  is_free           boolean,
  booking_url       text,
  status            text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled', 'cancelled', 'postponed', 'happened')),
  confidence        real CHECK (confidence BETWEEN 0 AND 1),
  is_published      boolean NOT NULL DEFAULT false,
  last_verified_at  timestamptz,
  origin            text NOT NULL CHECK (origin IN ('scraped', 'submitted')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  search_tsv        tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'C')
  ) STORED,
  UNIQUE (city_id, slug),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX events_search_idx ON events USING gin (search_tsv);
CREATE INDEX events_city_start_idx ON events (city_id, starts_at);
CREATE INDEX events_venue_start_idx ON events (venue_id, starts_at);
CREATE INDEX events_category_idx ON events (category_id);

CREATE TABLE event_artists (
  event_id   bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  artist_id  bigint NOT NULL REFERENCES artists(id),
  billing_order int NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, artist_id)
);
CREATE INDEX event_artists_artist_idx ON event_artists (artist_id);

CREATE TABLE event_organisers (
  event_id      bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  organiser_id  bigint NOT NULL REFERENCES organisers(id),
  PRIMARY KEY (event_id, organiser_id)
);
CREATE INDEX event_organisers_organiser_idx ON event_organisers (organiser_id);

-- ---------------------------------------------------------------- ingestion

CREATE TABLE handles (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handle           text NOT NULL UNIQUE,     -- lowercase, no leading @
  handle_type      text NOT NULL,            -- venue, organiser, comedy_club, cafe, college, cultural_body, artist...
  city_id          bigint NOT NULL REFERENCES cities(id),
  tier             char(1) NOT NULL CHECK (tier IN ('A', 'B')),
  active           boolean NOT NULL DEFAULT true,
  last_checked_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handles_due_idx ON handles (city_id, tier, active, last_checked_at);

CREATE TABLE suggested_handles (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  handle         text NOT NULL UNIQUE,
  city_id        bigint REFERENCES cities(id),
  reason         text,                        -- e.g. "tagged as co-host"
  seen_count     int NOT NULL DEFAULT 1,
  first_seen_post text,                       -- shortcode
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE raw_posts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shortcode         text NOT NULL UNIQUE,
  handle            text NOT NULL,
  post_url          text NOT NULL,
  post_type         text,                      -- image, carousel, reel
  caption           text,
  media_urls        jsonb NOT NULL DEFAULT '[]'::jsonb,  -- reference only, never rehosted
  tagged_handles    jsonb NOT NULL DEFAULT '[]'::jsonb,
  posted_at         timestamptz,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  processing_state  text NOT NULL DEFAULT 'new'
                    CHECK (processing_state IN ('new', 'filtered_out', 'extracting', 'extracted', 'queued_review', 'published', 'merged', 'error')),
  filter_result     text CHECK (filter_result IN ('event', 'maybe', 'not_event')),
  extraction        jsonb,                     -- model output with per-field confidence
  error             text
);
CREATE INDEX raw_posts_state_idx ON raw_posts (processing_state);
CREATE INDEX raw_posts_handle_idx ON raw_posts (handle, posted_at DESC);

-- One row per Instagram post, submission or other source supporting an event.
CREATE TABLE sources (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_type  text NOT NULL CHECK (source_type IN ('instagram', 'submission', 'web')),
  raw_post_id  bigint REFERENCES raw_posts(id),
  url          text,
  submission   jsonb,                          -- submitter details (never shown publicly)
  observed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sources_event_idx ON sources (event_id);

-- ---------------------------------------------------------------- i18n

CREATE TABLE translations (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type  text NOT NULL,                  -- event, venue, artist, organiser, series, hub, area, category, city
  entity_id    bigint NOT NULL,
  locale       text NOT NULL CHECK (locale IN ('en', 'hi')),
  field        text NOT NULL,
  text         text NOT NULL,
  source_hash  text,                           -- hash of source text, to detect stale translations
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, locale, field)
);

-- ---------------------------------------------------------------- operations

CREATE TABLE review_queue (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_type    text NOT NULL,                  -- raw_post, submission, event, venue_geocode, entity_fact, handle...
  item_id      bigint,
  reason       text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'resolved')),
  resolved_at  timestamptz,
  resolution_note text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_queue_open_idx ON review_queue (status, created_at);

CREATE TABLE cost_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  logged_at      timestamptz NOT NULL DEFAULT now(),
  bucket         text NOT NULL CHECK (bucket IN ('scrape', 'model')),
  sub_budget     text,                         -- e.g. reelTranscript
  service        text NOT NULL,                -- apify, anthropic...
  model          text,                         -- model ID or actor ID
  units          numeric NOT NULL DEFAULT 0,   -- results, tokens...
  unit_label     text,
  estimated_usd  numeric(12, 6) NOT NULL CHECK (estimated_usd >= 0),
  job_name       text NOT NULL,
  dry_run        boolean NOT NULL DEFAULT false
);
CREATE INDEX cost_log_month_idx ON cost_log (bucket, logged_at);

CREATE TABLE job_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name     text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  dry_run      boolean NOT NULL DEFAULT false,
  report       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text
);
CREATE INDEX job_runs_job_idx ON job_runs (job_name, started_at DESC);

CREATE TABLE search_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  searched_at  timestamptz NOT NULL DEFAULT now(),
  city_id      bigint REFERENCES cities(id),
  query        text NOT NULL,
  parsed       jsonb,
  parse_method text,                           -- rules, model, keyword_fallback
  result_count int NOT NULL DEFAULT 0
);
CREATE INDEX search_log_time_idx ON search_log (searched_at);

-- AI crawler visits only. No data about human visitors.
CREATE TABLE crawler_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  visited_at  timestamptz NOT NULL DEFAULT now(),
  agent       text NOT NULL,
  path        text NOT NULL,
  status      int
);
CREATE INDEX crawler_log_time_idx ON crawler_log (visited_at);
CREATE INDEX crawler_log_agent_idx ON crawler_log (agent, visited_at);

CREATE TABLE citation_queries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  city_id     bigint NOT NULL REFERENCES cities(id),
  locale      text NOT NULL CHECK (locale IN ('en', 'hi')),
  query       text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, locale, query)
);

CREATE TABLE citation_results (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  query_id            bigint NOT NULL REFERENCES citation_queries(id),
  engine              text NOT NULL,           -- chatgpt, gemini, perplexity, google_aio, copilot...
  week_start          date NOT NULL,
  cited               boolean NOT NULL,
  mentioned_by_name   boolean NOT NULL DEFAULT false,
  competitors_cited   jsonb NOT NULL DEFAULT '[]'::jsonb,
  screenshot_url      text,
  method              text NOT NULL DEFAULT 'manual' CHECK (method IN ('manual', 'automated')),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (query_id, engine, week_start)
);
