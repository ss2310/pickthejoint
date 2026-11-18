-- When a venue's address was last sent to the geocoder, so each venue is tried once.
ALTER TABLE venues ADD COLUMN geocoded_at timestamptz;
