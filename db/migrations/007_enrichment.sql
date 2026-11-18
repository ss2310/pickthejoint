-- Entity enrichment (Prompt 4).

-- An artist's "library": notable works that link out to official platforms.
-- [{"title": "...", "url": "https://...", "platform": "YouTube", "year": "2023"}]
ALTER TABLE artists ADD COLUMN notable_works jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE venues ADD COLUMN landmarks text;

-- Which page fact a source supports, and how strong the source is
-- (official: the entity's own site or profile; reputable; weak).
ALTER TABLE entity_sources ADD COLUMN field text;
ALTER TABLE entity_sources ADD COLUMN strength text CHECK (strength IN ('official', 'reputable', 'weak'));
