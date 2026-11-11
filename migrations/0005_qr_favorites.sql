-- v5: QR Maker favorites for logged-in users (lazy migration in src/index.js).
-- Anonymous users keep favorites in localStorage on their own device.
CREATE TABLE IF NOT EXISTS qr_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  payload TEXT NOT NULL,
  fg TEXT NOT NULL DEFAULT '#000000',
  bg TEXT NOT NULL DEFAULT '#ffffff',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_favorites_user ON qr_favorites (user_id, created_at DESC);
