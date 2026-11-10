-- 0003_click_events.sql — Mini Link v3: click history (per-click timestamps)
-- Applied with: wrangler d1 migrations apply mini-link-db --remote
-- (or once, in the Cloudflare dashboard: D1 -> your database -> Console)
--
-- NOTE: the Worker ALSO self-applies this schema lazily on its first API
-- call or redirect (see ensureV3Schema in src/index.js: CREATE TABLE IF
-- NOT EXISTS + indexes + a schema_meta version flag). That is what applies
-- it on the live database. This file exists for fresh installs and for
-- `wrangler d1 migrations apply`.
--
-- Privacy: click_events stores ONLY (link_id, clicked_at) — the link that
-- was opened and WHEN. No IP, no User-Agent, no referrer, no country,
-- nothing that could identify a visitor. Each link keeps at most its
-- newest 100 events (pruned on every counted click in handleRedirect),
-- so the table cannot grow forever. Bot visits are not recorded at all
-- (same rule as the click counter).

CREATE TABLE IF NOT EXISTS click_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id    INTEGER NOT NULL,  -- REFERENCES links(id)
  clicked_at INTEGER NOT NULL   -- epoch milliseconds (UTC)
);

CREATE INDEX IF NOT EXISTS idx_click_events_link ON click_events (link_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_click_events_time ON click_events (clicked_at);
