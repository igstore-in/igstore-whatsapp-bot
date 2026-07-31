PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bot_users (
  phone TEXT PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'both',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
  phone TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL DEFAULT '',
  bot_paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  whatsapp_message_id TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  media_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_shopify_webhooks (
  webhook_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL DEFAULT '',
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recovered_checkout_tokens (
  checkout_token TEXT PRIMARY KEY,
  recovered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS abandoned_checkouts (
  checkout_token TEXT PRIMARY KEY,
  phone TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT 'there',
  product_title TEXT NOT NULL DEFAULT 'your selected product',
  product_image TEXT,
  total_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  recovery_url TEXT NOT NULL DEFAULT '',
  consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  recovered_at INTEGER
);

ALTER TABLE abandoned_checkouts ADD COLUMN consent_source TEXT NOT NULL DEFAULT '';
ALTER TABLE abandoned_checkouts ADD COLUMN consent_at INTEGER;
ALTER TABLE abandoned_checkouts ADD COLUMN recovery_order_id TEXT NOT NULL DEFAULT '';
ALTER TABLE abandoned_checkouts ADD COLUMN recovery_order_name TEXT NOT NULL DEFAULT '';
ALTER TABLE abandoned_checkouts ADD COLUMN recovered_revenue REAL NOT NULL DEFAULT 0;
ALTER TABLE abandoned_checkouts ADD COLUMN recovery_stage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE abandoned_checkouts ADD COLUMN admin_stopped_at INTEGER;
ALTER TABLE abandoned_checkouts ADD COLUMN engaged_at INTEGER;
ALTER TABLE abandoned_checkouts ADD COLUMN paused_until INTEGER;

CREATE TABLE IF NOT EXISTS abandoned_message_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkout_token TEXT NOT NULL,
  stage INTEGER NOT NULL CHECK(stage BETWEEN 1 AND 3),
  status TEXT NOT NULL DEFAULT 'claimed',
  whatsapp_message_id TEXT,
  template_name TEXT NOT NULL DEFAULT '',
  http_status INTEGER,
  error_code TEXT NOT NULL DEFAULT '',
  error_subcode TEXT NOT NULL DEFAULT '',
  error_title TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  claimed_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(checkout_token, stage)
);

CREATE TABLE IF NOT EXISTS whatsapp_marketing_consents (
  phone TEXT PRIMARY KEY,
  consented_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  checkout_token TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_marketing_opt_outs (
  phone TEXT PRIMARY KEY,
  opted_out_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL DEFAULT 'whatsapp_inbound_stop'
);

CREATE TABLE IF NOT EXISTS recommendation_context (
  phone TEXT PRIMARY KEY,
  query TEXT NOT NULL DEFAULT '',
  budget REAL,
  reference_pending INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS last_product_suggestions (
  phone TEXT PRIMARY KEY,
  products_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_catalogue_map (
  product_url TEXT PRIMARY KEY,
  catalogue_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_flow_context (
  phone TEXT PRIMARY KEY,
  step TEXT NOT NULL,
  selected_product_json TEXT,
  selected_variant_json TEXT,
  customization_text TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  customer_name TEXT NOT NULL DEFAULT '',
  mobile_phone TEXT NOT NULL DEFAULT '',
  full_address TEXT NOT NULL DEFAULT '',
  pincode TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_tracking_context (
  phone TEXT PRIMARY KEY,
  pending INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS whatsapp_order_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  mobile_phone TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  product_title TEXT NOT NULL,
  product_url TEXT NOT NULL DEFAULT '',
  variant_id TEXT NOT NULL,
  variant_title TEXT NOT NULL DEFAULT '',
  customization_text TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL,
  total_price REAL,
  full_address TEXT NOT NULL DEFAULT '',
  pincode TEXT NOT NULL DEFAULT '',
  checkout_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'payment_pending',
  shopify_order_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS human_handoffs (
  phone TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'customer_requested_support',
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shopify_orders (
  order_id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL DEFAULT '',
  order_name TEXT NOT NULL DEFAULT '',
  checkout_token TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  financial_status TEXT NOT NULL DEFAULT '',
  fulfillment_status TEXT NOT NULL DEFAULT '',
  shipment_status TEXT NOT NULL DEFAULT '',
  status_label TEXT NOT NULL DEFAULT 'Order confirmed',
  tracking_company TEXT NOT NULL DEFAULT '',
  tracking_number TEXT NOT NULL DEFAULT '',
  tracking_url TEXT NOT NULL DEFAULT '',
  order_status_url TEXT NOT NULL DEFAULT '',
  total_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  line_items_summary TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS automation_locks (
  lock_name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  sync_name TEXT PRIMARY KEY,
  cursor TEXT NOT NULL DEFAULT '',
  last_success_at INTEGER,
  last_attempt_at INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_health_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS marketing_contacts (
  phone TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL DEFAULT '',
  shopify_customer_id TEXT NOT NULL DEFAULT '',
  number_of_orders INTEGER NOT NULL DEFAULT 0,
  opted_in INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaign_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  template_name TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_sends (
  event_key TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_abandoned_due ON abandoned_checkouts(status, due_at);
CREATE INDEX IF NOT EXISTS idx_abandoned_phone ON abandoned_checkouts(phone, updated_at);
CREATE INDEX IF NOT EXISTS idx_abandoned_created ON abandoned_checkouts(created_at);
CREATE INDEX IF NOT EXISTS idx_abandoned_events_status ON abandoned_message_events(status, next_retry_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_abandoned_events_checkout ON abandoned_message_events(checkout_token, stage);
CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_queue ON human_handoffs(status, priority, updated_at);
CREATE INDEX IF NOT EXISTS idx_order_drafts_phone ON whatsapp_order_drafts(phone, updated_at);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_lookup ON shopify_orders(order_number, phone, updated_at);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_checkout ON shopify_orders(checkout_token);
CREATE INDEX IF NOT EXISTS idx_webhooks_processed ON processed_shopify_webhooks(processed_at);
