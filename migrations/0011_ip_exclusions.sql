-- 0011_ip_exclusions.sql — Mini Link v10.1: admin-managed IP exclusions
-- Applied with: wrangler d1 migrations apply mini-link-db --remote
-- (or once, in the Cloudflare dashboard: D1 -> your database -> Console)
--
-- NOTE: the Worker ALSO self-applies this schema lazily (see
-- ensureV11Schema in src/index.js). That is what applies it on the live
-- database. This file exists for fresh installs and for
-- `wrangler d1 migrations apply`.
--
-- Visits from these IPs are never recorded in `visitors` (the owner
-- excludes his own IPs here). Managed only from the admin panel; adding
-- an IP also deletes its existing `visitors` row.
CREATE TABLE IF NOT EXISTS ip_exclusions (
  ip TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
