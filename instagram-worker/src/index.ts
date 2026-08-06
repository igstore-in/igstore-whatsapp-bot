import { configFor } from "./reel-config";

export interface Env {
  META_VERIFY_TOKEN: string;
  META_ACCESS_TOKEN: string;
  META_APP_SECRET: string;
  IG_USER_ID?: string;
  META_GRAPH_VERSION?: string;
  META_GRAPH_HOST?: string;
  DB: D1Database;
  COMMENT_QUEUE: Queue<CommentEvent>;
}

export type CommentEvent = {
  eventId: string;
  commentId: string;
  mediaId: string;
  mediaProductType: string;
  commenterId: string;
  username: string;
  text: string;
  ownerId: string;
  parentId: string;
  receivedAt: number;
};

type MetaError = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  fbtrace_id?: string;
};

class MetaApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number,
    readonly details: MetaError
  ) {
    super(message);
  }
}

const encoder = new TextEncoder();

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyMetaSignature(
  rawBody: ArrayBuffer,
  signatureHeader: string | null,
  appSecret: string
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=") || !appSecret) return false;
  const supplied = hexToBytes(signatureHeader.slice(7));
  if (!supplied) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  return bytesEqual(expected, supplied);
}

export function extractCommentEvents(payload: unknown): CommentEvent[] {
  const source = payload as { object?: string; entry?: unknown[] };
  if (source?.object && source.object !== "instagram") return [];
  const events: CommentEvent[] = [];
  for (const rawEntry of source?.entry ?? []) {
    const entry = rawEntry as { id?: unknown; changes?: unknown[]; time?: unknown };
    const ownerId = String(entry?.id ?? "");
    for (const rawChange of entry?.changes ?? []) {
      const change = rawChange as { field?: unknown; value?: Record<string, unknown> };
      if (change?.field !== "comments") continue;
      const value = change.value ?? {};
      const media = (value.media ?? {}) as Record<string, unknown>;
      const from = (value.from ?? {}) as Record<string, unknown>;
      const commentId = String(value.id ?? "");
      const mediaId = String(media.id ?? "");
      if (!commentId || !mediaId) continue;
      events.push({
        eventId: commentId,
        commentId,
        mediaId,
        mediaProductType: String(media.media_product_type ?? ""),
        commenterId: String(from.id ?? ""),
        username: String(from.username ?? ""),
        text: String(value.text ?? ""),
        ownerId,
        parentId: String(value.parent_id ?? ""),
        receivedAt: Number(entry.time ?? Math.floor(Date.now() / 1000))
      });
    }
  }
  return events;
}

function render(template: string, event: CommentEvent): string {
  return template
    .replaceAll("{{username}}", event.username || "there")
    .replaceAll("{{media_id}}", event.mediaId);
}

function matchesKeywords(textValue: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const normalized = textValue.toLocaleLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase()));
}

function sanitizedMetaError(value: unknown): MetaError {
  const error = ((value as { error?: MetaError })?.error ?? {}) as MetaError;
  return {
    message: error.message,
    type: error.type,
    code: error.code,
    error_subcode: error.error_subcode,
    is_transient: error.is_transient,
    fbtrace_id: error.fbtrace_id
  };
}

async function graphPost(
  env: Env,
  path: string,
  body: unknown
): Promise<{ id?: string }> {
  const host = (env.META_GRAPH_HOST || "https://graph.instagram.com").replace(/\/$/, "");
  const version = env.META_GRAPH_VERSION || "v25.0";
  const response = await fetch(`${host}/${version}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const result = (await response.json().catch(() => ({}))) as { id?: string; error?: MetaError };
  if (!response.ok || result.error) {
    const details = sanitizedMetaError(result);
    const retryable = response.status === 429 || response.status >= 500 || details.is_transient === true;
    throw new MetaApiError(details.message || `Meta API returned HTTP ${response.status}`, retryable, response.status, details);
  }
  return { id: result.id };
}

async function claimEvent(env: Env, event: CommentEvent): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO events
      (event_id, comment_id, media_id, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'received', 0, ?, ?)`
  ).bind(event.eventId, event.commentId, event.mediaId, now, now).run();
  const claim = await env.DB.prepare(
    `UPDATE events
       SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ?
     WHERE event_id = ?
       AND (status IN ('received', 'retry') OR (status = 'processing' AND lease_until < ?))`
  ).bind(now + 600, now, event.eventId, now).run();
  return Number(claim.meta.changes ?? 0) === 1;
}

async function runAction(
  env: Env,
  event: CommentEvent,
  action: "public_reply" | "private_reply",
  operation: () => Promise<{ id?: string }>
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO actions (event_id, action, status, updated_at)
     VALUES (?, ?, 'pending', ?)`
  ).bind(event.eventId, action, now).run();
  const claim = await env.DB.prepare(
    `UPDATE actions SET status = 'processing', lease_until = ?, updated_at = ?
     WHERE event_id = ? AND action = ?
       AND (status IN ('pending', 'retry') OR (status = 'processing' AND lease_until < ?))`
  ).bind(now + 600, now, event.eventId, action, now).run();
  if (Number(claim.meta.changes ?? 0) !== 1) return;
  try {
    const result = await operation();
    await env.DB.prepare(
      `UPDATE actions SET status = 'succeeded', lease_until = NULL, meta_object_id = ?,
       last_error = NULL, updated_at = ? WHERE event_id = ? AND action = ?`
    ).bind(result.id ?? null, now, event.eventId, action).run();
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
    await env.DB.prepare(
      `UPDATE actions SET status = 'retry', lease_until = NULL, last_error = ?, updated_at = ?
       WHERE event_id = ? AND action = ?`
    ).bind(message, now, event.eventId, action).run();
    throw error;
  }
}

async function markEvent(env: Env, eventId: string, status: string, error?: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE events SET status = ?, lease_until = NULL, last_error = ?, updated_at = ?
     WHERE event_id = ?`
  ).bind(status, error?.slice(0, 500) ?? null, now, eventId).run();
}

async function processEvent(env: Env, event: CommentEvent): Promise<void> {
  if (!(await claimEvent(env, event))) return;
  const ownerId = event.ownerId || env.IG_USER_ID || "";
  const config = configFor(event.mediaId);
  const ignoreReason =
    (!ownerId && "missing_owner_id") ||
    (event.parentId && "reply_comment") ||
    (event.commenterId && event.commenterId === ownerId && "self_comment") ||
    (event.mediaProductType && event.mediaProductType !== "REELS" && "not_reel") ||
    (!config && "disabled") ||
    (config && !matchesKeywords(event.text, config.keywords) && "keyword_miss");
  if (ignoreReason) {
    await markEvent(env, event.eventId, `ignored:${ignoreReason}`);
    console.log(JSON.stringify({ level: "info", event: "comment_ignored", eventId: event.eventId, mediaId: event.mediaId, reason: ignoreReason }));
    return;
  }
  await runAction(env, event, "public_reply", () =>
    graphPost(env, `${event.commentId}/replies`, { message: render(config!.publicReply, event) })
  );
  await runAction(env, event, "private_reply", () =>
    graphPost(env, `${ownerId}/messages`, {
      recipient: { comment_id: event.commentId },
      message: { text: render(config!.privateReply, event) }
    })
  );
  await markEvent(env, event.eventId, "completed");
  console.log(JSON.stringify({ level: "info", event: "comment_completed", eventId: event.eventId, mediaId: event.mediaId }));
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    try {
      await env.DB.prepare("SELECT 1").first();
      return json({ ok: true, service: "igstore-instagram-comment-bot", database: "ok" });
    } catch {
      return json({ ok: false, service: "igstore-instagram-comment-bot", database: "error" }, 503);
    }
  }
  if (url.pathname !== "/instagram-comments") return text("Not found", 404);
  if (request.method === "GET") {
    const valid =
      url.searchParams.get("hub.mode") === "subscribe" &&
      bytesEqual(
        encoder.encode(url.searchParams.get("hub.verify_token") ?? ""),
        encoder.encode(env.META_VERIFY_TOKEN ?? "")
      );
    return valid ? text(url.searchParams.get("hub.challenge") ?? "") : text("Forbidden", 403);
  }
  if (request.method !== "POST") return text("Method not allowed", 405);
  const rawBody = await request.arrayBuffer();
  const verified = await verifyMetaSignature(rawBody, request.headers.get("x-hub-signature-256"), env.META_APP_SECRET);
  if (!verified) {
    console.warn(JSON.stringify({ level: "warn", event: "invalid_webhook_signature" }));
    return json({ error: "Invalid signature" }, 401);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const events = extractCommentEvents(payload);
  await env.COMMENT_QUEUE.sendBatch(events.map((body) => ({ body })));
  console.log(JSON.stringify({ level: "info", event: "webhook_accepted", count: events.length }));
  return json({ received: true, queued: events.length });
}

export default {
  fetch: handleFetch,
  async queue(batch: MessageBatch<CommentEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processEvent(env, message.body);
        message.ack();
      } catch (error) {
        const retryable = !(error instanceof MetaApiError) || error.retryable;
        const safeError = error instanceof MetaApiError ? error.details : { message: error instanceof Error ? error.message : "Unknown error" };
        console.error(JSON.stringify({ level: "error", event: "comment_failed", eventId: message.body.eventId, mediaId: message.body.mediaId, retryable, error: safeError }));
        await markEvent(env, message.body.eventId, retryable ? "retry" : "failed_permanent", safeError.message);
        if (retryable) {
          const delaySeconds = Math.min(900, 30 * 2 ** Math.max(0, message.attempts - 1));
          message.retry({ delaySeconds });
        } else {
          message.ack();
        }
      }
    }
  }
} satisfies ExportedHandler<Env, CommentEvent>;
