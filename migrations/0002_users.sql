-- 0002_users.sql — Mini Link v2: user accounts (voluntary), per-user spaces
-- Applied with: wrangler d1 migrations apply mini-link-db --remote
-- (or once, in the Cloudflare dashboard: D1 -> your database -> Console)
--
-- NOTE: the Worker ALSO self-applies this schema lazily on its first API
-- call (see ensureV2Schema in src/index.js: CREATE TABLE IF NOT EXISTS +
-- ALTER TABLE with a duplicate-column guard + a schema_meta version flag).
-- That is what applies it on the live database. This file exists for fresh
-- installs and for `wrangler d1 migrations apply`. Do NOT run it twice
-- manually: `ALTER TABLE links ADD COLUMN user_id` fails if the column
-- already exists (the Worker's lazy migration handles that case).
--
-- Privacy: visitor IPs are NEVER stored — rate limiting uses SHA-256 hashes
-- of the IP (as in v1). Email verification codes are stored ONLY as
-- SHA-256 hashes (peppered with SESSION_SECRET), never as plaintext.

-- Registered users. email_verified = 0 until the 6-digit code from the
-- verification email is entered. disabled = 1 blocks login and new links.
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,   -- 3-20 chars, [A-Za-z0-9_]
  email          TEXT    NOT NULL UNIQUE,   -- lowercase, unique
  password_hash  TEXT    NOT NULL,          -- pbkdf2$100000$... (same as admin)
  email_verified INTEGER NOT NULL DEFAULT 0,
  disabled       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL           -- epoch milliseconds (UTC)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

-- User sessions. Only a SHA-256 hash of the session token is stored
-- (peppered with SESSION_SECRET), never the token itself. Separate from
-- the admin `sessions` table and the `session` cookie (this one is the
-- `user_session` cookie), so admin and user logins never interfere.
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,              -- REFERENCES users(id)
  created_at INTEGER NOT NULL,              -- epoch milliseconds (UTC)
  expires_at INTEGER NOT NULL               -- epoch milliseconds (UTC)
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions (expires_at);

-- One-time email codes (verification + password reset). Only the SHA-256
-- hash of the 6-digit code is stored — the code itself is never written
-- to the database. purpose is 'verify' or 'reset'.
CREATE TABLE IF NOT EXISTS email_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,              -- REFERENCES users(id)
  email      TEXT    NOT NULL,              -- address the code was sent to
  purpose    TEXT    NOT NULL,              -- 'verify' | 'reset'
  code_hash  TEXT    NOT NULL,              -- SHA-256(SESSION_SECRET:code)
  expires_at INTEGER NOT NULL,              -- epoch milliseconds (UTC), +10 min
  attempts   INTEGER NOT NULL DEFAULT 0,    -- wrong tries; >= 5 invalidates
  used       INTEGER NOT NULL DEFAULT 0,    -- 1 = consumed / invalidated
  created_at INTEGER NOT NULL               -- epoch milliseconds (UTC)
);

CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes (user_id, purpose, used, expires_at);

-- Owner of a link. NULL = anonymous (all v1 links, public-form links made
-- while logged out, and links of deleted users — deleting a user sets
-- user_id back to NULL so their short links keep redirecting).
ALTER TABLE links ADD COLUMN user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_links_user ON links (user_id);

-- Applied-schema marker (used by the Worker's lazy migration).
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
