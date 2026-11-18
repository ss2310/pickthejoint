-- Whether a listing has been checked to take place in the city it is filed under.
-- New listings are checked at extraction. Listings published before that check
-- existed start as false and are audited by the ingest job (audit.ts).
ALTER TABLE events ADD COLUMN city_checked boolean NOT NULL DEFAULT false;
-- Submitted events name their city on the form.
UPDATE events SET city_checked = true WHERE origin = 'submitted';
