CREATE TABLE IF NOT EXISTS whatsapp_flow_submissions (
  source_message_id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  request_type TEXT NOT NULL,
  product_category TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  mobile_number TEXT NOT NULL DEFAULT '',
  order_number TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  flow_token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_flow_submissions_phone
ON whatsapp_flow_submissions(phone, created_at);
