# IG Store WhatsApp Bot

Production Cloudflare Worker for IG Store customer shopping, Shopify product and order support, WhatsApp order capture, shipment tracking, human handoff, and consent-based abandoned-checkout recovery.

Live service: `igstore-whatsapp-bot.igstore-jpr.workers.dev`  
Storefront: `https://igstore.in`  
Support: `+91 95876 66693`

## Architecture

Cloudflare Workers receives Meta and Shopify webhooks. D1 stores deduplication records, conversations, order drafts, consent, opt-outs, recovery jobs, send events, locks, and health state. Shopify Admin GraphQL supplies verified products, orders, abandoned checkouts, webhooks, and discount health. Meta WhatsApp Cloud API sends approved templates and customer-service replies.

The deployed entrypoint remains:

```text
src/variant-entry.ts
→ src/order-entry.ts
→ src/entry.ts
→ src/index.ts
```

The outer entrypoint handles global `STOP` and `START` before any product, variant, address, order, or AI flow. WhatsApp message IDs and Shopify webhook IDs prevent duplicate processing.

## Required accounts

- Cloudflare Workers and D1
- Shopify store with an Admin API app
- Meta Business account with WhatsApp Cloud API
- OpenAI API access for AI-assisted replies

## Shopify setup

Use one authentication method:

- `SHOPIFY_ADMIN_ACCESS_TOKEN`; or
- `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`

Required scopes:

```text
read_products
read_orders
read_all_orders
read_checkouts
read_customers
read_discounts
write_discounts
read_fulfillments
read_merchant_managed_fulfillment_orders
write_webhooks
```

`write_discounts` is needed only for an authenticated one-time discount setup/repair workflow. Routine cron runs never create or change discounts.

Configure Shopify webhooks to:

```text
https://igstore-whatsapp-bot.igstore-jpr.workers.dev/shopify/webhook
```

Required topics include checkout create/update, order create/paid/update, and fulfillment create/update. Shopify HMAC is verified against the raw request body.

Add the explicit cart checkbox by following `docs/shopify-whatsapp-consent.md`.

## Meta setup

Configure the callback:

```text
https://igstore-whatsapp-bot.igstore-jpr.workers.dev/webhook
```

Subscribe to WhatsApp messages and configure `META_VERIFY_TOKEN` and `META_APP_SECRET`. The POST webhook requires `X-Hub-Signature-256`.

Create the three marketing templates exactly as documented in `docs/meta-whatsapp-templates.md`. Template names and language remain configurable.

## Configuration

Non-secret variables can be placed in `wrangler.jsonc`:

```text
META_GRAPH_VERSION
SHOP_DOMAIN
SHOPIFY_ADMIN_DOMAIN
SHOPIFY_ADMIN_API_VERSION
OPENAI_MODEL
ABANDONED_TEMPLATE_FIRST
ABANDONED_TEMPLATE_SECOND
ABANDONED_TEMPLATE_THIRD
ABANDONED_TEMPLATE_LANGUAGE
ABANDONED_FALLBACK_IMAGE_URL
ABANDONED_FALLBACK_BODY_TEMPLATE
ABANDONED_OFFER_CODE
ABANDONED_FINAL_OFFER_CODE
```

Add secrets with Cloudflare encrypted secrets, never in Git:

```powershell
npx wrangler secret put META_VERIFY_TOKEN
npx wrangler secret put META_APP_SECRET
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_CATALOG_ID
npx wrangler secret put SHOPIFY_ADMIN_ACCESS_TOKEN
npx wrangler secret put SHOPIFY_CLIENT_SECRET
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
```

Do not configure both Shopify token methods unless deliberately supporting a fallback.

## Database and cron

Apply migrations before deploying:

```powershell
npx wrangler d1 migrations apply DB --local
npx wrangler d1 migrations apply DB --remote
```

Schedules:

- `* * * * *`: due and retry jobs only
- `*/5 * * * *`: incremental abandoned-checkout sync with a safe overlap
- `0 */6 * * *`: webhook verification, cleanup, and health maintenance

The three reminder times are 5, 50, and 110 minutes after abandonment. `(checkout_token, stage)` is unique and each claim has a ten-minute lease.

## Local testing

```powershell
npm install
npm test
npx wrangler deploy --dry-run
npx wrangler d1 migrations apply DB --local
```

Do not deploy if any check fails.

## Admin inbox and health

`/admin/inbox` and all `/admin/api/*` routes require Basic Auth. Configure `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

Health routes:

```text
GET /health
GET /shopify/health
GET /shopify/order-health
GET /admin/api/automation-health
GET /admin/api/discount-health
GET /admin/api/template-health
```

Health responses show configuration names and status but never secret values.

## Production deployment

1. Apply remote D1 migrations.
2. Configure encrypted secrets.
3. Verify CART5 and CART10 in `/admin/api/discount-health`.
4. Verify templates in `/admin/api/template-health`.
5. Run the complete test checklist.
6. Deploy with `npx wrangler deploy`.
7. Confirm Meta and Shopify webhook delivery.

## Rollback

1. Roll back the Worker to the previous known-good Cloudflare version.
2. Disable cron triggers if automation behavior is unsafe.
3. Keep D1 data; do not reverse the additive migration.
4. Stop affected checkouts through the authenticated admin action.
5. Fix forward, rerun tests, and redeploy.

## Troubleshooting

- No Stage 1: check explicit WhatsApp consent, recovery URL, normalized Indian phone, sync health, and opt-out state.
- Stage 2/3 skipped: inspect discount health; inactive, expired, wrong-percentage, or stackable codes are blocked.
- Meta failure: inspect stored HTTP/error metadata and template parameter order.
- Shopify webhook rejected: verify the app webhook secret and raw-body HMAC.
- Duplicate cron: inspect `abandoned_message_events`; a sent or active leased event is never resent.
- Admin unavailable: configure both admin credentials and retry with Basic Auth.

## Manual verification checklist

- Unchecked cart continues normally and sends no marketing reminder.
- Checked cart stores WhatsApp consent timestamp/source.
- Reminder timings are 5, 50, and 110 minutes.
- Duplicate cron and webhook deliveries produce one result.
- `STOP` works during product and order flows; `START` stores fresh consent.
- A customer reply marks the checkout engaged and pauses later reminders.
- Purchase recovery works before Stage 1, between stages, and after Stage 3.
- CART5 and CART10 health matches 5% and 10%.
- Order tracking never returns another customer’s order.
- Hindi and emoji remain valid UTF-8.
