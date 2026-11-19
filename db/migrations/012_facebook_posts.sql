-- Facebook page posts (the owner's decision of 19 Nov 2026).
-- Most pages announce events in ordinary posts, not through Facebook's Events
-- feature, so a page's recent posts are now read as well (logged out, through
-- Apify) and go through the same pipeline as Instagram posts. They are stored
-- in raw_posts with source_kind 'facebook' and a shortcode of "fbp:<post id>"
-- (a native Facebook event stays "fb:<event id>").

ALTER TABLE facebook_pages
  -- How often posts are read: A every two days, B weekly, C every two weeks.
  ADD COLUMN tier             char(1) NOT NULL DEFAULT 'B' CHECK (tier IN ('A', 'B', 'C')),
  -- What kind of page it is ("University, College & Campus Fest"); passed to the model as context.
  ADD COLUMN category         text,
  -- Statewide and national pages: keep only posts that name the city.
  ADD COLUMN city_filter      boolean NOT NULL DEFAULT false,
  ADD COLUMN posts_checked_at timestamptz,
  ADD COLUMN posts_seen       int NOT NULL DEFAULT 0;

ALTER TABLE facebook_pages DROP CONSTRAINT facebook_pages_added_via_check;
ALTER TABLE facebook_pages ADD CONSTRAINT facebook_pages_added_via_check
  CHECK (added_via IN ('manual', 'official_link', 'census', 'import'));
