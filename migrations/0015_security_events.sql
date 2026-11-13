-- v10.6: security event log (admin-only). IPs stored like the visitors
-- table (admin-only, 90-day retention); excluded IPs are never recorded.
-- No usernames or emails are stored here.
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  type TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);
CREATE INDEX IF NOT EXISTS idx_security_events_ip ON security_events(ip, created_at DESC);
