-- 0001_init.sql — URL Shortener, initial schema (Cloudflare D1 / SQLite)
-- Applied with: wrangler d1 migrations apply url-shortener-db --remote
-- (or once, in the Cloudflare dashboard: D1 -> your database -> Console)

-- Links created by the administrator.
CREATE TABLE IF NOT EXISTS links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  alias       TEXT    NOT NULL UNIQUE,   -- short code, e.g. "aB3x9Q"
  destination TEXT    NOT NULL,          -- full https:// destination URL
  created_at  INTEGER NOT NULL,          -- epoch milliseconds (UTC)
  expires_at  INTEGER,                   -- epoch milliseconds (UTC), NULL = never
  enabled     INTEGER NOT NULL DEFAULT 1, -- 1 = active, 0 = disabled
  clicks      INTEGER NOT NULL DEFAULT 0  -- total counted redirects
);

CREATE INDEX IF NOT EXISTS idx_links_created ON links (created_at DESC);

-- Administrator sessions. Only a SHA-256 hash of the session token is stored
-- (peppered with SESSION_SECRET), never the token itself.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL,           -- epoch milliseconds (UTC)
  expires_at INTEGER NOT NULL            -- epoch milliseconds (UTC)
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Rate-limit counters. Keys are SHA-256 hashes of (scope + window + IP hash);
-- raw visitor IPs are NEVER stored here or anywhere else.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT    PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL            -- epoch seconds, start of the window
);

CREATE INDEX IF NOT EXISTS idx_rate_window ON rate_limits (window_start);
