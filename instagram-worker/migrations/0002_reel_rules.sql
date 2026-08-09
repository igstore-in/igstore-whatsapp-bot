Exit code: 0
Wall time: 1.2 seconds
Output:
CREATE TABLE IF NOT EXISTS reel_rules (
  media_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  public_reply TEXT NOT NULL,
  private_reply TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS reel_rules_updated_idx
  ON reel_rules(updated_at DESC);

