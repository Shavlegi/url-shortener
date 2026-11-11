-- v6: QR generation history — EVERY QR the Maker generates (lazy migration in src/index.js).
-- Logged-in users get user_id attached; anonymous rows stay ownerless (user_id NULL).
-- favorite=1 marks rows the user also saved as a favorite.
-- Existing favorites (if any) are copied in as favorite=1 by the migration.
CREATE TABLE IF NOT EXISTS qr_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  payload TEXT NOT NULL,
  fg TEXT NOT NULL DEFAULT '#000000',
  bg TEXT NOT NULL DEFAULT '#ffffff',
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_history_user ON qr_history (user_id, created_at DESC);
