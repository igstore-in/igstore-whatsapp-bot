CREATE TABLE IF NOT EXISTS abandoned_message_events (
  message_id TEXT PRIMARY KEY,
  checkout_token TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  stage INTEGER NOT NULL,
  template_name TEXT NOT NULL,
  tracking_token TEXT UNIQUE,
  destination_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  delivered_at INTEGER,
  read_at INTEGER,
  clicked_at INTEGER,
  purchased_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_abandoned_message_checkout
ON abandoned_message_events(checkout_token, stage);

CREATE UNIQUE INDEX IF NOT EXISTS idx_abandoned_message_tracking_token
ON abandoned_message_events(tracking_token)
WHERE tracking_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS shopify_cart_events (
  cart_token TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  item_count INTEGER NOT NULL DEFAULT 0,
  total_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  checkout_started_at INTEGER,
  purchased_at INTEGER
);

