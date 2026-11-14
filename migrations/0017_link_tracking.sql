-- 0017_link_tracking.sql — Mini Link v10.9: per-link click tracking
-- Applied with: wrangler d1 migrations apply mini-link-db --remote
-- (or once, in the Cloudflare dashboard: D1 -> your database -> Console)
--
-- NOTE: the Worker ALSO self-applies this schema lazily (see
-- ensureV17Schema in src/index.js, with duplicate-column-tolerant
-- ALTERs). That is what applies it on the live database. This file
-- exists for fresh installs and for `wrangler d1 migrations apply`.
--
-- `links.is_custom` marks links created with an explicitly provided
-- alias (admin create with alias, or import with an explicit alias).
-- Auto-generated links (public form, Telegram bot) stay 0, and links
-- created before v10.9 stay 0 — tracking toggles appear only on custom
-- links created after this migration. `track_server` / `track_browser`
-- are the two per-link toggles (default OFF, admin-only).
-- `link_visits` holds one row per recorded click on a tracked link:
-- the same 15 enrichment columns as `visitors`, plus an optional
-- `browser_data` JSON blob filled in by the interstitial page's beacon
-- (one-shot `beacon_token`). Admin-only viewing, 90-day retention,
-- newest 5000 rows kept per link.
ALTER TABLE links ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN track_server INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN track_browser INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS link_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES links(id),
  ip TEXT NOT NULL,
  visited_at INTEGER NOT NULL,
  beacon_token TEXT,
  country TEXT,
  city TEXT,
  region TEXT,
  postal_code TEXT,
  latitude REAL,
  longitude REAL,
  timezone TEXT,
  isp TEXT,
  asn INTEGER,
  is_eu INTEGER,
  browser TEXT,
  os TEXT,
  device TEXT,
  language TEXT,
  referrer TEXT,
  browser_data TEXT
);
CREATE INDEX IF NOT EXISTS idx_link_visits_link ON link_visits(link_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_link_visits_time ON link_visits(visited_at);
CREATE INDEX IF NOT EXISTS idx_link_visits_token ON link_visits(beacon_token);
