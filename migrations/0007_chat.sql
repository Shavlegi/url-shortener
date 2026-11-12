-- v7.0: admin chat — 1:1 threads between the admin and email-verified
-- users (lazy migration in src/index.js, ensureV7Schema).
-- chat_threads: one row per user (user_id UNIQUE); unread counters per side.
-- chat_messages: text only — NO blob column, so listing messages never
-- touches file bytes. Attachments live in chat_attachments and are fetched
-- only by id for downloads. Attachment data is capped at 1.5 MB decoded
-- (D1 caps a single value / row at 2,000,000 bytes).
CREATE TABLE IF NOT EXISTS chat_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  admin_unread INTEGER NOT NULL DEFAULT 0,
  user_unread INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (thread_id, id);
CREATE TABLE IF NOT EXISTS chat_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_message ON chat_attachments (message_id);
