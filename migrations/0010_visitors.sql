-- 0010_visitors.sql — Mini Link v10.0: visitor IP log (admin-only)
-- Applied with: wrangler d1 migrations apply mini-link-db --remote
-- (or once, in the Cloudflare dashboard: D1 -> your database -> Console)
--
-- NOTE: the Worker ALSO self-applies this schema lazily (see
-- ensureV10Schema in src/index.js). That is what applies it on the live
-- database. This file exists for fresh installs and for
-- `wrangler d1 migrations apply`.
--
-- Privacy (owner's explicit decision, 2026-11-13): visitor IPs ARE
-- stored here — one row per IP with visit count, first/last seen and
-- last path. Served ONLY to the admin session; never in any public
-- response. Rows older than 30 days are pruned automatically; the admin
-- can also clear the table (or one IP) from the panel. Bots are never
-- recorded. click_events still stores no IP (link + time only).
CREATE TABLE IF NOT EXISTS visitors (
  ip TEXT PRIMARY KEY,
  visits INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_path TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_visitors_last ON visitors (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_visitors_visits ON visitors (visits DESC);
