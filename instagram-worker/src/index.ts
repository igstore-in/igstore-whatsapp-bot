import { configFor, defaultConfig, type ReelConfig } from "./reel-config";
import { adminHtml } from "./admin";

export interface Env {
  META_VERIFY_TOKEN: string;
  META_ACCESS_TOKEN: string;
  META_APP_SECRET: string;
  IG_USER_ID?: string;
  META_GRAPH_VERSION?: string;
  META_GRAPH_HOST?: string;
  ADMIN_PASSWORD?: string;
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

type QuickReplyEvent = {
  eventId: string;
  senderId: string;
  payload: string;
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

type StoredRule = {
  media_id: string;
  enabled: number;
  keywords_json: string;
  public_reply: string;
  private_reply: string;
  updated_at: number;
};

type ReelMetadata = {
  media_id: string;
  shortcode: string | null;
  permalink: string | null;
};

type ActivityRow = {
  event_id: string;
  media_id: string;
  username: string | null;
  comment_text: string | null;
  public_reply: string | null;
  private_reply: string | null;
  status: string;
  error: string | null;
  received_at: number;
  updated_at: number;
  public_status: string | null;
  private_status: string | null;
};

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

function cookieValue(request: Request, name: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([key]) => key === name)?.[1];
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array | undefined {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function sessionSignature(payload: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

async function makeSession(password: string): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60 })));
  return `${payload}.${await sessionSignature(payload, password)}`;
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_PASSWORD) return false;
  const token = cookieValue(request, "igstore_admin");
  const [payload, signature] = token?.split(".") ?? [];
  if (!payload || !signature) return false;
  const expected = await sessionSignature(payload, env.ADMIN_PASSWORD);
  if (!bytesEqual(encoder.encode(signature), encoder.encode(expected))) return false;
  try {
    const decoded = fromBase64Url(payload);
    const session = JSON.parse(new TextDecoder().decode(decoded)) as { exp?: number };
    return typeof session.exp === "number" && session.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
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

function extractQuickReplyEvents(payload: unknown): QuickReplyEvent[] {
  const source = payload as { object?: string; entry?: unknown[] };
  if (source?.object && source.object !== "instagram") return [];
  const events: QuickReplyEvent[] = [];
  for (const rawEntry of source?.entry ?? []) {
    const entry = rawEntry as { messaging?: unknown[] };
    for (const rawMessage of entry.messaging ?? []) {
      const message = rawMessage as {
        sender?: { id?: unknown };
        message?: { mid?: unknown; quick_reply?: { payload?: unknown } };
      };
      const eventId = String(message.message?.mid ?? "");
      const senderId = String(message.sender?.id ?? "");
      const replyPayload = String(message.message?.quick_reply?.payload ?? "");
      if (eventId && senderId && replyPayload) events.push({ eventId, senderId, payload: replyPayload });
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

function ruleToConfig(rule: StoredRule): ReelConfig {
  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(rule.keywords_json);
    keywords = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string").slice(0, 30) : [];
  } catch {
    keywords = [];
  }
  return {
    enabled: rule.enabled === 1,
    keywords,
    publicReply: rule.public_reply,
    privateReply: rule.private_reply
  };
}

type ResolvedConfig = { config: ReelConfig | undefined; isDefault: boolean };

async function configForEvent(env: Env, mediaId: string): Promise<ResolvedConfig> {
  const exact = await env.DB.prepare(
    "SELECT media_id, enabled, keywords_json, public_reply, private_reply, updated_at FROM reel_rules WHERE media_id = ?"
  ).bind(mediaId).first<StoredRule>();
  if (exact) return { config: ruleToConfig(exact), isDefault: false };
  const fallback = await env.DB.prepare(
    "SELECT media_id, enabled, keywords_json, public_reply, private_reply, updated_at FROM reel_rules WHERE media_id = 'default'"
  ).first<StoredRule>();
  return { config: fallback ? ruleToConfig(fallback) : configFor(mediaId) ?? defaultConfig(), isDefault: true };
}

async function ensureReelMetadataTable(env: Env): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS reel_metadata (media_id TEXT PRIMARY KEY, shortcode TEXT, permalink TEXT, updated_at INTEGER NOT NULL)"
  );
}

async function ensureActivityTable(env: Env): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS comment_activity (event_id TEXT PRIMARY KEY, comment_id TEXT NOT NULL, media_id TEXT NOT NULL, username TEXT, comment_text TEXT, public_reply TEXT, private_reply TEXT, status TEXT NOT NULL, error TEXT, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
  );
}

async function ensureFollowGateTable(env: Env): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS follow_prompts (commenter_id TEXT PRIMARY KEY, prompted_at INTEGER NOT NULL)"
  );
}

function isFollowConfirmation(value: string): boolean {
  return /\b(done|followed|follow\s*(kar|kr|kiya|kya))\b/i.test(value);
}

async function hasFollowPrompt(env: Env, commenterId: string): Promise<boolean> {
  if (!commenterId) return false;
  await ensureFollowGateTable(env);
  const row = await env.DB.prepare("SELECT commenter_id FROM follow_prompts WHERE commenter_id = ?").bind(commenterId).first();
  return Boolean(row);
}

async function rememberFollowPrompt(env: Env, commenterId: string): Promise<void> {
  if (!commenterId) return;
  await ensureFollowGateTable(env);
  await env.DB.prepare(
    "INSERT INTO follow_prompts (commenter_id, prompted_at) VALUES (?, ?) ON CONFLICT(commenter_id) DO UPDATE SET prompted_at = excluded.prompted_at"
  ).bind(commenterId, Math.floor(Date.now() / 1000)).run();
}

async function recordActivity(env: Env, event: CommentEvent, status: string, replies?: { publicReply?: string; privateReply?: string }, error?: string): Promise<void> {
  await ensureActivityTable(env);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO comment_activity (event_id, comment_id, media_id, username, comment_text, public_reply, private_reply, status, error, received_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET public_reply = COALESCE(excluded.public_reply, comment_activity.public_reply), private_reply = COALESCE(excluded.private_reply, comment_activity.private_reply), status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`
  ).bind(event.eventId, event.commentId, event.mediaId, event.username || null, event.text || null, replies?.publicReply ?? null, replies?.privateReply ?? null, status, error?.slice(0, 500) ?? null, event.receivedAt, now).run();
}

function publicRule(rule: StoredRule, metadata?: ReelMetadata): Record<string, unknown> {
  const config = ruleToConfig(rule);
  return { mediaId: rule.media_id, shortcode: metadata?.shortcode ?? null, permalink: metadata?.permalink ?? null, ...config, updatedAt: rule.updated_at };
}

async function parseJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function validateRule(value: Record<string, unknown>): { rule?: Omit<StoredRule, "media_id" | "updated_at">; error?: string } {
  const enabled = value.enabled === true;
  const keywords = Array.isArray(value.keywords) ? value.keywords.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 30) : [];
  const publicReply = typeof value.publicReply === "string" ? value.publicReply.trim() : "";
  const privateReply = typeof value.privateReply === "string" ? value.privateReply.trim() : "";
  if (!publicReply || !privateReply) return { error: "Public reply and private DM reply are required." };
  if (publicReply.length > 1000 || privateReply.length > 1000) return { error: "Each reply must be 1,000 characters or fewer." };
  return { rule: { enabled: enabled ? 1 : 0, keywords_json: JSON.stringify(keywords), public_reply: publicReply, private_reply: privateReply } };
}

function shortcodeFromInput(value: string): string | undefined {
  const normalized = value.trim();
  const linkMatch = normalized.match(/instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)/i);
  if (linkMatch) return linkMatch[1];
  return /^[A-Za-z0-9_-]{5,}$/.test(normalized) && !/^\d+$/.test(normalized) ? normalized : undefined;
}

function shortcodeFromPermalink(value: string): string | undefined {
  return value.match(/instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)/i)?.[1];
}

async function graphGet<T>(env: Env, path: string): Promise<T> {
  const host = (env.META_GRAPH_HOST || "https://graph.instagram.com").replace(/\/$/, "");
  const version = env.META_GRAPH_VERSION || "v25.0";
  const response = await fetch(`${host}/${version}/${path}`, { headers: { authorization: `Bearer ${env.META_ACCESS_TOKEN}` } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || (result as { error?: unknown }).error) {
    const details = sanitizedMetaError(result);
    throw new MetaApiError(details.message || `Meta API returned HTTP ${response.status}`, false, response.status, details);
  }
  return result as T;
}

async function resolveReel(env: Env, input: string): Promise<{ mediaId: string; shortcode?: string; permalink?: string }> {
  if (input === "default") return { mediaId: "default" };
  if (/^\d{5,}$/.test(input)) return { mediaId: input };
  const shortcode = shortcodeFromInput(input);
  if (!shortcode) throw new Error("Paste an Instagram Reel link, shortcode, numeric media ID, or default.");
  if (!env.IG_USER_ID) throw new Error("Instagram account ID is not configured.");
  let after = "";
  for (let page = 0; page < 5; page += 1) {
    const query = `fields=id,permalink,media_product_type&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const result = await graphGet<{ data?: Array<{ id?: string; permalink?: string }>; paging?: { cursors?: { after?: string } } }>(env, `${env.IG_USER_ID}/media?${query}`);
    const match = result.data?.find((media) => shortcodeFromPermalink(media.permalink ?? "") === shortcode);
    if (match?.id) return { mediaId: match.id, shortcode, permalink: match.permalink };
    after = result.paging?.cursors?.after ?? "";
    if (!after) break;
  }
  throw new Error("Reel not found in the connected Instagram account. Ensure it belongs to this account and is among its recent media.");
}

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response | undefined> {
  if (url.pathname === "/admin" && request.method === "GET") {
    return new Response(adminHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (!url.pathname.startsWith("/api/admin/")) return undefined;
  if (url.pathname === "/api/admin/login" && request.method === "POST") {
    const body = await parseJson(request);
    const supplied = typeof body?.password === "string" ? body.password : "";
    if (!env.ADMIN_PASSWORD || !bytesEqual(encoder.encode(supplied), encoder.encode(env.ADMIN_PASSWORD))) return json({ error: "Invalid password" }, 401);
    const session = await makeSession(env.ADMIN_PASSWORD);
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": `igstore_admin=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800` } });
  }
  if (url.pathname === "/api/admin/logout" && request.method === "POST") {
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json; charset=utf-8", "set-cookie": "igstore_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" } });
  }
  if (!(await isAdmin(request, env))) return json({ error: "Unauthorized" }, 401);
  await ensureReelMetadataTable(env);
  await ensureActivityTable(env);
  if (url.pathname === "/api/admin/overview" && request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN status IN ('received','processing','retry') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status LIKE 'failed%' THEN 1 ELSE 0 END) AS failed FROM events"
    ).first<{ completed?: number; pending?: number; failed?: number }>();
    return json({ completed: Number(rows?.completed ?? 0), pending: Number(rows?.pending ?? 0), failed: Number(rows?.failed ?? 0) });
  }
  if (url.pathname === "/api/admin/rules" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT media_id, enabled, keywords_json, public_reply, private_reply, updated_at FROM reel_rules ORDER BY CASE WHEN media_id = 'default' THEN 0 ELSE 1 END, updated_at DESC"
    ).all<StoredRule>();
    const metadata = await env.DB.prepare("SELECT media_id, shortcode, permalink FROM reel_metadata").all<ReelMetadata>();
    const metadataByMediaId = new Map(metadata.results.map((item) => [item.media_id, item]));
    return json({ rules: results.map((rule) => publicRule(rule, metadataByMediaId.get(rule.media_id))) });
  }
  if (url.pathname === "/api/admin/activity" && request.method === "GET") {
    const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
    const { results } = await env.DB.prepare(
      `SELECT a.event_id, a.media_id, a.username, a.comment_text, a.public_reply, a.private_reply, a.status, a.error, a.received_at, a.updated_at,
        public_action.status AS public_status, private_action.status AS private_status
       FROM comment_activity a
       LEFT JOIN actions public_action ON public_action.event_id = a.event_id AND public_action.action = 'public_reply'
       LEFT JOIN actions private_action ON private_action.event_id = a.event_id AND private_action.action = 'private_reply'
       ORDER BY a.updated_at DESC LIMIT ?`
    ).bind(limit).all<ActivityRow>();
    return json({ activity: results });
  }
  const prefix = "/api/admin/rules/";
  if (url.pathname.startsWith(prefix)) {
    const reelInput = decodeURIComponent(url.pathname.slice(prefix.length));
    if (request.method === "PUT") {
      const body = await parseJson(request);
      if (!body) return json({ error: "Invalid JSON" }, 400);
      const validated = validateRule(body);
      if (!validated.rule) return json({ error: validated.error }, 400);
      let reel: { mediaId: string; shortcode?: string; permalink?: string };
      try {
        reel = await resolveReel(env, reelInput);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Could not resolve this Reel." }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        "INSERT INTO reel_rules (media_id, enabled, keywords_json, public_reply, private_reply, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(media_id) DO UPDATE SET enabled = excluded.enabled, keywords_json = excluded.keywords_json, public_reply = excluded.public_reply, private_reply = excluded.private_reply, updated_at = excluded.updated_at"
      ).bind(reel.mediaId, validated.rule.enabled, validated.rule.keywords_json, validated.rule.public_reply, validated.rule.private_reply, now).run();
      if (reel.mediaId !== "default") {
        await env.DB.prepare(
          "INSERT INTO reel_metadata (media_id, shortcode, permalink, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(media_id) DO UPDATE SET shortcode = excluded.shortcode, permalink = excluded.permalink, updated_at = excluded.updated_at"
        ).bind(reel.mediaId, reel.shortcode ?? null, reel.permalink ?? null, now).run();
      }
      return json({ ok: true, mediaId: reel.mediaId, permalink: reel.permalink ?? null });
    }
    if (request.method === "DELETE") {
      const mediaId = reelInput;
      await env.DB.prepare("DELETE FROM reel_rules WHERE media_id = ?").bind(mediaId).run();
      await env.DB.prepare("DELETE FROM reel_metadata WHERE media_id = ?").bind(mediaId).run();
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
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

type QuickReply = { content_type: "text"; title: string; payload: string };

async function sendDirectMessage(
  env: Env,
  recipientId: string,
  messageText: string,
  quickReplies?: QuickReply[]
): Promise<void> {
  const ownerId = env.IG_USER_ID;
  if (!ownerId) throw new Error("Instagram account ID is not configured.");
  await graphPost(env, `${ownerId}/messages`, {
    recipient: { id: recipientId },
    message: { text: messageText, ...(quickReplies?.length ? { quick_replies: quickReplies } : {}) }
  });
}

async function handleQuickReply(env: Env, event: QuickReplyEvent): Promise<void> {
  if (event.payload === "IGSTORE_ACCESS") {
    await sendDirectMessage(
      env,
      event.senderId,
      "Before I send the store access, please follow @igstore_in: https://www.instagram.com/igstore_in/\n\nThen tap the confirmation below.",
      [{ content_type: "text", title: "I'm following", payload: "IGSTORE_FOLLOW_CONFIRMED" }]
    );
    return;
  }
  if (event.payload === "IGSTORE_FOLLOW_CONFIRMED") {
    await sendDirectMessage(
      env,
      event.senderId,
      "Thank you! Here is your IGStore.in access link: https://igstore.in/"
    );
  }
}

async function processQuickReply(env: Env, event: QuickReplyEvent): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS quick_reply_events (event_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  );
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO quick_reply_events (event_id, status, updated_at) VALUES (?, 'received', ?)"
  ).bind(event.eventId, now).run();
  const claim = await env.DB.prepare(
    "UPDATE quick_reply_events SET status = 'processing', updated_at = ? WHERE event_id = ? AND status IN ('received', 'retry')"
  ).bind(now, event.eventId).run();
  if (Number(claim.meta.changes ?? 0) !== 1) return;
  try {
    await handleQuickReply(env, event);
    await env.DB.prepare("UPDATE quick_reply_events SET status = 'completed', updated_at = ? WHERE event_id = ?")
      .bind(Math.floor(Date.now() / 1000), event.eventId).run();
  } catch (error) {
    await env.DB.prepare("UPDATE quick_reply_events SET status = 'retry', updated_at = ? WHERE event_id = ?")
      .bind(Math.floor(Date.now() / 1000), event.eventId).run();
    throw error;
  }
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
  await recordActivity(env, event, "processing");
  const ownerId = event.ownerId || env.IG_USER_ID || "";
  const resolved = await configForEvent(env, event.mediaId);
  const config = resolved.config;
  const ignoreReason =
    (!ownerId && "missing_owner_id") ||
    (event.parentId && "reply_comment") ||
    (event.commenterId && event.commenterId === ownerId && "self_comment") ||
    ((!config || !config.enabled) && "disabled") ||
    (config && !matchesKeywords(event.text, config.keywords) && "keyword_miss");
  if (ignoreReason) {
    await markEvent(env, event.eventId, `ignored:${ignoreReason}`);
    await recordActivity(env, event, `ignored:${ignoreReason}`);
    console.log(JSON.stringify({ level: "info", event: "comment_ignored", eventId: event.eventId, mediaId: event.mediaId, reason: ignoreReason }));
    return;
  }
  const followConfirmed = resolved.isDefault && isFollowConfirmation(event.text) && await hasFollowPrompt(env, event.commenterId);
  if (resolved.isDefault && !followConfirmed) await rememberFollowPrompt(env, event.commenterId);
  const publicReply = resolved.isDefault && !followConfirmed
    ? "Please check your DM to get access."
    : render(config!.publicReply, event);
  const privateReply = resolved.isDefault && !followConfirmed
    ? render("Hey {{username}}! Tap below and I'll send you the access in just a moment.", event)
    : render(config!.privateReply, event);
  await recordActivity(env, event, "processing", { publicReply, privateReply });
  await runAction(env, event, "public_reply", () =>
    graphPost(env, `${event.commentId}/replies`, { message: publicReply })
  );
  await runAction(env, event, "private_reply", () =>
    graphPost(env, `${ownerId}/messages`, {
      recipient: { comment_id: event.commentId },
      message: {
        text: privateReply,
        ...(resolved.isDefault && !followConfirmed
          ? { quick_replies: [{ content_type: "text", title: "Send me the access", payload: "IGSTORE_ACCESS" }] }
          : {})
      }
    })
  );
  await markEvent(env, event.eventId, "completed");
  await recordActivity(env, event, "completed", { publicReply, privateReply });
  console.log(JSON.stringify({ level: "info", event: "comment_completed", eventId: event.eventId, mediaId: event.mediaId }));
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const adminResponse = await handleAdmin(request, env, url);
  if (adminResponse) return adminResponse;
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
  const quickReplies = extractQuickReplyEvents(payload);
  if (events.length > 0) await env.COMMENT_QUEUE.sendBatch(events.map((body) => ({ body })));
  for (const quickReply of quickReplies) await processQuickReply(env, quickReply);
  console.log(JSON.stringify({ level: "info", event: "webhook_accepted", comments: events.length, quickReplies: quickReplies.length }));
  return json({ received: true, queued: events.length, quickReplies: quickReplies.length });
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
        await recordActivity(env, message.body, retryable ? "retry" : "failed_permanent", undefined, safeError.message);
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

