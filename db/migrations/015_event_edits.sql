-- Correcting a published event from the admin area (owner's request, 19 Nov 2026).

-- 1. An edit is recorded with its reason, like a cancellation or a takedown.
ALTER TABLE event_actions DROP CONSTRAINT event_actions_action_check;
ALTER TABLE event_actions ADD CONSTRAINT event_actions_action_check
  CHECK (action IN ('cancelled', 'removed', 'restored', 'published', 'edited'));

-- 2. An event's address carries its title and date. When either is corrected the address changes,
-- and the old one keeps working as a permanent redirect, so links and citations are not broken.
CREATE TABLE event_redirects (
  city_id     bigint NOT NULL REFERENCES cities(id),
  old_slug    text NOT NULL,
  event_id    bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, old_slug)
);
CREATE INDEX event_redirects_event_idx ON event_redirects (event_id);
