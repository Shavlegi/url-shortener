-- 0014_visit_tracking_notes.sql — Mini Link v10.4: behavior tracking + IP notes
-- Applied with: wrangler d1 migrations apply mini-link-db --remote
-- (or once, in the Cloudflare dashboard: D1 -> your database -> Console)
--
-- NOTE: the Worker ALSO self-applies this schema lazily (see
-- ensureV14Schema in src/index.js, with a duplicate-column-tolerant
-- ALTER). That is what applies it on the live database. This file
-- exists for fresh installs and for `wrangler d1 migrations apply`.
--
-- `visitors.note` is the admin's own note on an IP (max 500 chars);
-- it lives on the visitor row, so it is pruned with the row after
-- 30 days. `visit_events` holds per-visit behavior events (page
-- opens, clicks, time on page) — admin-only viewing, same 30-day
-- retention, newest 5000 rows kept.
ALTER TABLE visitors ADD COLUMN note TEXT;
CREATE TABLE IF NOT EXISTS visit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  session TEXT NOT NULL,
  type TEXT NOT NULL,
  path TEXT,
  label TEXT,
  seconds INTEGER,
  scroll INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visit_events_ip ON visit_events(ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_visit_events_created ON visit_events(created_at);
