-- 0013_visit_enrichment.sql — Mini Link v10.3: visitor enrichment + aggregates
-- Applied with: wrangler d1 migrations apply mini-link-db --remote
-- (or once, in the Cloudflare dashboard: D1 -> your database -> Console)
--
-- NOTE: the Worker ALSO self-applies this schema lazily (see
-- ensureV13Schema in src/index.js, with duplicate-column-tolerant
-- ALTERs). That is what applies it on the live database. This file
-- exists for fresh installs and for `wrangler d1 migrations apply`.
--
-- Enrichment columns on `visitors` (last-known values per IP, from
-- Cloudflare request.cf + parsed User-Agent + headers; raw User-Agent
-- is never stored). visit_hours/path_stats are 30-day aggregates;
-- screen_stats is a pure histogram with no IPs at all.
ALTER TABLE visitors ADD COLUMN country TEXT;
ALTER TABLE visitors ADD COLUMN city TEXT;
ALTER TABLE visitors ADD COLUMN region TEXT;
ALTER TABLE visitors ADD COLUMN postal_code TEXT;
ALTER TABLE visitors ADD COLUMN latitude REAL;
ALTER TABLE visitors ADD COLUMN longitude REAL;
ALTER TABLE visitors ADD COLUMN timezone TEXT;
ALTER TABLE visitors ADD COLUMN isp TEXT;
ALTER TABLE visitors ADD COLUMN asn INTEGER;
ALTER TABLE visitors ADD COLUMN is_eu INTEGER;
ALTER TABLE visitors ADD COLUMN browser TEXT;
ALTER TABLE visitors ADD COLUMN os TEXT;
ALTER TABLE visitors ADD COLUMN device TEXT;
ALTER TABLE visitors ADD COLUMN language TEXT;
ALTER TABLE visitors ADD COLUMN referrer TEXT;
CREATE TABLE IF NOT EXISTS visit_hours (
  day TEXT NOT NULL,
  hour INTEGER NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, hour)
);
CREATE TABLE IF NOT EXISTS path_stats (
  path TEXT PRIMARY KEY,
  visits INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS screen_stats (
  resolution TEXT PRIMARY KEY,
  visits INTEGER NOT NULL DEFAULT 0
);
