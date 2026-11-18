-- Prompt 7: natural-language search.

-- search_log (Prompt 1) gains what the admin view needs: the query as it is
-- compared (lower case, spacing and punctuation folded), the page language and
-- what parsing it cost. No address or other data about the visitor is stored.
ALTER TABLE search_log
  ADD COLUMN normalized text,
  ADD COLUMN locale     text,
  ADD COLUMN cost_usd   numeric(12, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0);
UPDATE search_log SET normalized = lower(query) WHERE normalized IS NULL;
ALTER TABLE search_log ALTER COLUMN normalized SET NOT NULL;
CREATE INDEX search_log_normalized_idx ON search_log (normalized, searched_at);

-- Queries the model has parsed, so the same words are never paid for twice.
-- Dates are stored as relative words ("this saturday"), never as calendar
-- dates, so a cached answer stays right next week. `version` changes when the
-- parser does, which retires older answers.
CREATE TABLE search_parse_cache (
  city_id      bigint NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  normalized   text NOT NULL,
  version      int NOT NULL,
  parsed       jsonb NOT NULL,
  hits         int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city_id, normalized, version)
);
