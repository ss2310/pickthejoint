-- Prompt 6: user submissions, posters and the single-admin area.

-- ---------------------------------------------------------------- posters
-- Poster photos sent through "snap a poster", the admin poster inbox or the
-- poster email address. Stored privately for review only: never served on a
-- public page, never rehosted. The photo is re-encoded on upload, which drops
-- all metadata (location included). Housekeeping deletes each row once
-- delete_after has passed (the day after the event, or sooner when unused).
CREATE TABLE poster_images (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel       text NOT NULL CHECK (channel IN ('public', 'admin', 'email')),
  city_id       bigint REFERENCES cities(id),
  bytes         bytea NOT NULL,
  media_type    text NOT NULL,
  width         int,
  height        int,
  sha256        text NOT NULL,
  original_name text,
  note          text,                         -- the sender's note, or the email subject
  extraction    jsonb,                        -- what the vision model read
  extraction_state text NOT NULL DEFAULT 'pending'
                CHECK (extraction_state IN ('pending', 'done', 'failed', 'skipped')),
  extraction_error text,
  delete_after  timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX poster_images_delete_idx ON poster_images (delete_after);
CREATE INDEX poster_images_sha_idx ON poster_images (sha256);

-- ---------------------------------------------------------------- submissions
-- One row per event someone sent us. A draft is a form being filled in (the
-- token in its address is the only way to reach it); pending ones wait in
-- review_queue; approved ones point at the event they became.
CREATE TABLE submissions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token         text NOT NULL UNIQUE,         -- random, for the draft's address
  channel       text NOT NULL CHECK (channel IN ('form', 'poster', 'admin', 'email')),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  city_id       bigint REFERENCES cities(id),
  fields        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- event facts as sent (or as read from the poster)
  submitter     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- name and contact: never shown publicly
  screening     jsonb,                                -- pre-screen result and notes
  form_errors   jsonb,                                -- last validation errors, for the draft page
  poster_id     bigint REFERENCES poster_images(id) ON DELETE SET NULL,
  event_id      bigint REFERENCES events(id) ON DELETE SET NULL,
  ip_hash       text,
  submitted_at  timestamptz,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submissions_status_idx ON submissions (status, created_at);

-- Events from posters show "source: submitted poster".
ALTER TABLE sources DROP CONSTRAINT sources_source_type_check;
ALTER TABLE sources ADD CONSTRAINT sources_source_type_check CHECK (source_type IN ('instagram', 'submission', 'poster', 'web'));
ALTER TABLE sources ADD COLUMN submission_id bigint REFERENCES submissions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- rate limits
-- Hits per key (a hashed IP plus what was attempted), counted over a window.
-- Rows older than a day are deleted by housekeeping.
CREATE TABLE rate_hits (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key     text NOT NULL,
  hit_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_hits_key_idx ON rate_hits (key, hit_at);

-- ---------------------------------------------------------------- admin
-- One account (the owner's). The id is fixed at 1 so a second row cannot exist.
CREATE TABLE admin_account (
  id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  password_hash  text NOT NULL,               -- scrypt, with its parameters and salt
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Signed-in sessions. Only a hash of the cookie value is stored.
CREATE TABLE admin_sessions (
  token_hash    text PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- What the admin did to a public page, and why (cancellations, takedowns).
CREATE TABLE event_actions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action IN ('cancelled', 'removed', 'restored', 'published')),
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_actions_event_idx ON event_actions (event_id, created_at DESC);
