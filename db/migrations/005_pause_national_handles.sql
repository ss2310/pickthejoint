-- National listing accounts taken off the Indore list on 18 November 2026.
-- They post about events in every city, so almost everything fetched from them
-- was read and then discarded for being elsewhere. Switched off rather than
-- deleted so they are not offered again as suggested handles.
UPDATE handles SET active = false, updated_at = now() WHERE handle IN (
  'bookmyshowin',
  'allevents_official',
  'sortmyscene',
  'skillboxofficial',
  'districtupdates'
);
