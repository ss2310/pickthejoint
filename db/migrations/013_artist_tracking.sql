-- Prompt 10: artist tracking and official video.

-- 1. Who is tracked is worked out on the spot (an upcoming event within 30
-- days, until 7 days after the last one); the owner can also pin an artist.
ALTER TABLE artists
  ADD COLUMN tracking_pinned       boolean NOT NULL DEFAULT false,
  ADD COLUMN tracking_checked_at   timestamptz,
  -- The artist's official YouTube channel, once found, and when videos were last looked up.
  ADD COLUMN youtube_channel_id    text,
  ADD COLUMN youtube_channel_title text,
  ADD COLUMN videos_checked_at     timestamptz,
  -- Admin-only note on how the channel was found, or why none was.
  ADD COLUMN videos_note           text;

-- 2. Every post of a tracked artist that was read, and what it was judged to
-- be. Only a "new_release" with a line of our own shows on the artist page;
-- "other" posts are kept here only so the same post is never read twice.
-- The post itself is never stored: only its link and our one-line update.
CREATE TABLE artist_posts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artist_id   bigint NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  shortcode   text NOT NULL UNIQUE,
  post_url    text NOT NULL,
  posted_at   timestamptz,
  label       text NOT NULL CHECK (label IN ('new_show', 'event_change', 'new_release', 'other')),
  confidence  numeric(4, 3),
  reason      text,             -- the classifier's short note; admin only
  update_text text,             -- new_release only: one line in our own words
  hidden      boolean NOT NULL DEFAULT false,
  model_usd   numeric(12, 6) NOT NULL DEFAULT 0 CHECK (model_usd >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artist_posts_artist_idx ON artist_posts (artist_id, posted_at DESC);

-- 3. Official videos chosen for an artist. Only YouTube's own IDs and facts
-- are stored; the video is embedded with YouTube's player. Nothing shows on a
-- page until the owner approves it.
CREATE TABLE artist_videos (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artist_id      bigint NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  video_id       text NOT NULL,
  title          text NOT NULL,
  published_year int,
  -- One sentence, in our own words, on what it is and why it is known.
  blurb          text,
  channel_id     text,
  channel_title  text,
  view_count     bigint,
  position       int NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  UNIQUE (artist_id, video_id)
);
CREATE INDEX artist_videos_status_idx ON artist_videos (status, artist_id);
