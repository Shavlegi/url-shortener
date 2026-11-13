-- 0012_visitor_users.sql — Mini Link v10.2: IP <-> user mapping (admin-only)
-- Applied with: wrangler d1 migrations apply mini-link-db --remote
-- (or once, in the Cloudflare dashboard: D1 -> your database -> Console)
--
-- NOTE: the Worker ALSO self-applies this schema lazily (see
-- ensureV12Schema in src/index.js). That is what applies it on the live
-- database. This file exists for fresh installs and for
-- `wrangler d1 migrations apply`.
--
-- One row per (IP, logged-in user) pair: when a logged-in user visits,
-- their username becomes visible next to that IP in the admin panel's
-- visitors list ONLY. Anonymous visits have no row here. Same 30-day
-- retention as `visitors`; rows are also deleted when the IP is
-- excluded/cleared or when the user account is deleted.
CREATE TABLE IF NOT EXISTS visitor_users (
  ip TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (ip, user_id)
);
CREATE INDEX IF NOT EXISTS idx_visitor_users_user ON visitor_users (user_id, last_seen DESC);
