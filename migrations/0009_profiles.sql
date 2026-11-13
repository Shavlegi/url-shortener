-- 0009_profiles.sql — Mini Link v8.0: public profile pages (/@username)
-- Applied with: wrangler d1 migrations apply mini-link-db --remote
-- (or once, in the Cloudflare dashboard: D1 -> your database -> Console)
--
-- NOTE: the Worker ALSO self-applies this schema lazily on its first API
-- call (see ensureV9Schema in src/index.js: CREATE TABLE + a schema_meta
-- version flag). That is what applies it on the live database. This file
-- exists for fresh installs and for the record.
--
-- profiles: one row per user, created EXPLICITLY by the user (never
-- automatically). Only email-verified users may create one (the gate is
-- enforced server-side). display_name/bio are shown on the public page;
-- avatar bytes live in the private R2 bucket (avatar_r2_key) and are
-- served publicly via GET /@username/avatar. show_views toggles the
-- public view counter; link_limit caps the user's profile buttons
-- (default 5, raised only by the admin). view_count is incremented
-- atomically on every public render.
-- profile_links: the user's MANUALLY curated buttons — nothing is
-- auto-published. kind 'short' points at one of the user's own links
-- (link_id); kind 'manual' stores a hand-typed https URL (url).
-- Timestamps are ISO strings (TEXT), unlike the epoch-ms INTEGERs of
-- older tables — profile dates are never displayed, only ordered by
-- position, so the simpler format is fine.
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  display_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  avatar_r2_key TEXT,
  avatar_mime TEXT,
  show_views INTEGER NOT NULL DEFAULT 1,
  link_limit INTEGER NOT NULL DEFAULT 5,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS profile_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  position INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  link_id INTEGER REFERENCES links(id),
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_profile_links_user ON profile_links (user_id, position);
