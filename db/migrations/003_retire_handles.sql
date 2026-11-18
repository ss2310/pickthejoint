-- Handles taken off the starting list on 18 November 2026.
-- Seven return nothing through the scraping actor (restricted or not found);
-- four have not posted for months. They are switched off rather than deleted
-- so they are not offered again as suggested handles. To bring one back, set
-- active = true.
UPDATE handles SET active = false, updated_at = now() WHERE handle IN (
  'phoenixcitadelofficial',
  'studioxoindore',
  'thepianoprojectindore',
  'romeolaneindore',
  'pitcherscafebar',
  'tanabanacollective_',
  'strikerindore',
  'shosha_indore',
  'socialofflineindore',
  'bccindore',
  'revolution.indore'
);
