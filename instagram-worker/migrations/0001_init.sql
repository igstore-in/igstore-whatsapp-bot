CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  event_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER,
  meta_object_id TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, action)
);

CREATE INDEX IF NOT EXISTS events_status_updated_idx
  ON events(status, updated_at);
