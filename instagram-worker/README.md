# Instagram Reel comment automation

Cloudflare Worker that verifies Meta webhooks, queues Reel comment events, posts a public reply, and sends the comment-author private reply configured for that Reel.

## Security and reliability

- Validates `X-Hub-Signature-256` with the Meta App Secret before parsing events.
- Stores `META_VERIFY_TOKEN`, `META_ACCESS_TOKEN`, and `META_APP_SECRET` only as Cloudflare secrets.
- Uses Cloudflare Queues for background delivery, exponential retries, and a dead-letter queue.
- Uses D1 event/action leases for duplicate suppression and loop prevention.
- Logs structured identifiers and sanitized Meta errors, never access tokens or full webhook bodies.

## Configuration

Edit `src/reel-config.ts` to add each Reel media ID and its public/private messages. The `default` entry is used when no exact Reel ID is present. Set `enabled: false` to disable an entry. An empty `keywords` array replies to every top-level comment; otherwise at least one keyword must occur.

Cloudflare secrets (never commit their values):

```text
META_VERIFY_TOKEN
META_ACCESS_TOKEN
META_APP_SECRET
IG_USER_ID (optional fallback)
```

## Deployment checklist

1. Create D1 database `igstore-instagram-events`, update its ID in `wrangler.jsonc`, and apply `migrations/0001_init.sql` remotely.
2. Create queues `igstore-instagram-comments` and `igstore-instagram-comments-dlq`.
3. Add the three required Cloudflare secrets and deploy from GitHub with root directory `instagram-worker`.
4. In the Meta app, configure callback URL `https://<worker>.workers.dev/instagram-comments`, use the same verify token, and subscribe the Instagram `comments` field.
5. Grant the correct advanced-access permissions for the app login model, generate a production token for the connected professional Instagram account, then comment from a different account to test.

For Instagram Login, the usual permissions are `instagram_business_basic`, `instagram_business_manage_comments`, and `instagram_business_manage_messages`. Facebook Login-based apps instead use `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_show_list`, and commonly `pages_read_engagement`. Exact approval requirements must be checked in the app dashboard because they depend on the app type and rollout state.

Meta private replies are sent to `/{ig-user-id}/messages` with `recipient.comment_id`; the commenter user ID is not a valid substitute for this flow. Meta also limits private replies by policy and comment age, so failed 4xx responses are recorded as permanent rather than retried indefinitely.
