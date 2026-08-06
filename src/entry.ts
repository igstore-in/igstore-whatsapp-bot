import handler, { verifyWebhookSignature } from "./index";

type WorkerHandler = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Response | Promise<Response>;
  scheduled?: (controller: unknown, env: unknown, ctx: unknown) => unknown;
};

type WorkerEnv = {
  DB?: D1Database;
  META_APP_SECRET?: string;
};

type UnsupportedWebhookMessage = {
  id: string;
  from: string;
  profileName: string;
  logText: string;
};

const CP1252_REVERSE = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

const MOJIBAKE_MARKER = /(?:Ã|Â|â|ð|à¤|à¥|à¦|à§|à¨|à©|àª|à«|à¬|à­|à®|à¯|à°|à±|à²|à³|à´|àµ)/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function windows1252Byte(character: string): number | null {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return null;
  if (codePoint <= 0xff) return codePoint;
  return CP1252_REVERSE.get(codePoint) ?? null;
}

function utf8SequenceLength(firstByte: number): number {
  if (firstByte >= 0xc2 && firstByte <= 0xdf) return 2;
  if (firstByte >= 0xe0 && firstByte <= 0xef) return 3;
  if (firstByte >= 0xf0 && firstByte <= 0xf4) return 4;
  return 0;
}

function isValidUtf8Sequence(bytes: number[]): boolean {
  if (bytes.length < 2) return false;
  for (let index = 1; index < bytes.length; index += 1) {
    if (bytes[index] < 0x80 || bytes[index] > 0xbf) return false;
  }
  if (bytes[0] === 0xe0 && bytes[1] < 0xa0) return false;
  if (bytes[0] === 0xed && bytes[1] > 0x9f) return false;
  if (bytes[0] === 0xf0 && bytes[1] < 0x90) return false;
  if (bytes[0] === 0xf4 && bytes[1] > 0x8f) return false;
  return true;
}

function decodeMojibakeOnce(value: string): string {
  const characters = Array.from(value);
  const bytes = characters.map(windows1252Byte);
  let output = "";

  for (let index = 0; index < characters.length;) {
    const firstByte = bytes[index];
    if (firstByte === null) {
      output += characters[index];
      index += 1;
      continue;
    }
    const length = utf8SequenceLength(firstByte);
    if (length > 0 && index + length <= characters.length) {
      const sequence = bytes.slice(index, index + length);
      if (sequence.every((byte): byte is number => byte !== null) && isValidUtf8Sequence(sequence)) {
        try {
          output += utf8Decoder.decode(Uint8Array.from(sequence));
          index += length;
          continue;
        } catch {
          // Preserve the source text when decoding is unsafe.
        }
      }
    }
    output += characters[index];
    index += 1;
  }
  return output;
}

export function repairMojibake(value: string): string {
  let repaired = value;
  for (let attempt = 0; attempt < 3 && MOJIBAKE_MARKER.test(repaired); attempt += 1) {
    const next = decodeMojibakeOnce(repaired);
    if (next === repaired) break;
    repaired = next;
  }
  return repaired;
}

function repairJsonValue(value: unknown): unknown {
  if (typeof value === "string") return repairMojibake(value);
  if (Array.isArray(value)) return value.map(repairJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, repairJsonValue(child)]),
    );
  }
  return value;
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function unsupportedLogText(message: any): string {
  const visibleContent = firstNonEmptyString([
    message?.text?.body,
    message?.body,
    message?.content?.text,
    message?.payload?.text,
    message?.caption,
  ]);
  if (visibleContent) return visibleContent.slice(0, 4000);

  const details = firstNonEmptyString([
    message?.errors?.[0]?.error_data?.details,
    message?.errors?.[0]?.message,
    message?.errors?.[0]?.title,
  ]);

  return details
    ? `[Unsupported WhatsApp message — ${details}; content unavailable via Meta Cloud API]`.slice(0, 4000)
    : "[Protected/unsupported WhatsApp message — content unavailable via Meta Cloud API]";
}

function extractUnsupportedMessages(payload: any): UnsupportedWebhookMessage[] {
  const unsupported: UnsupportedWebhookMessage[] = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      if (messages.length === 0) continue;

      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
      const supportedMessages: any[] = [];

      for (const message of messages) {
        if (message?.type !== "unsupported") {
          supportedMessages.push(message);
          continue;
        }

        const id = String(message?.id ?? "").trim();
        const from = String(message?.from ?? "").replace(/\D/g, "");
        if (!id || !from) continue;

        const contact = contacts.find(
          (item: any) => String(item?.wa_id ?? "").replace(/\D/g, "") === from,
        );
        unsupported.push({
          id,
          from,
          profileName: String(contact?.profile?.name ?? "").trim().slice(0, 120),
          logText: unsupportedLogText(message),
        });
      }

      value.messages = supportedMessages;
    }
  }

  return unsupported;
}

async function saveUnsupportedMessages(
  env: WorkerEnv,
  messages: UnsupportedWebhookMessage[],
): Promise<void> {
  if (!env.DB || messages.length === 0) return;

  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS contacts (
        phone TEXT PRIMARY KEY,
        profile_name TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        direction TEXT NOT NULL,
        body TEXT NOT NULL,
        whatsapp_message_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
  ]);

  for (const message of messages) {
    try {
      const inserted = await env.DB.prepare(
        "INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)",
      ).bind(message.id).run();
      if (Number(inserted.meta?.changes ?? 0) === 0) continue;

      await env.DB.prepare(`
        INSERT INTO contacts (phone, profile_name, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(phone) DO UPDATE SET
          profile_name = CASE
            WHEN excluded.profile_name != '' THEN excluded.profile_name
            ELSE contacts.profile_name
          END,
          updated_at = CURRENT_TIMESTAMP
      `).bind(message.from, message.profileName).run();

      await env.DB.prepare(`
        INSERT INTO conversations (phone, direction, body, whatsapp_message_id)
        VALUES (?, 'in', ?, ?)
      `).bind(message.from, message.logText, message.id).run();
    } catch (error) {
      console.error("Failed to save unsupported WhatsApp message:", error);
    }
  }
}

const nativeFetch = globalThis.fetch.bind(globalThis);
const repairedFetch: typeof fetch = async (input, init) => {
  let nextInit = init;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https:\/\/graph\.facebook\.com\//i.test(url) && typeof init?.body === "string") {
    const contentType = new Headers(init.headers).get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        nextInit = { ...init, body: JSON.stringify(repairJsonValue(JSON.parse(init.body))) };
      } catch {
        // Keep the original request when it is not valid JSON.
      }
    }
  }
  return nativeFetch(input, nextInit);
};

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  writable: true,
  value: repairedFetch,
});

async function repairWorkerResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/") && !contentType.includes("application/json") && !contentType.includes("application/javascript")) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  return new Response(repairMojibake(await response.text()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const baseHandler = handler as WorkerHandler;

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    const requestUrl = new URL(request.url);
    const workerEnv = env as WorkerEnv;

    if (request.method === "POST" && requestUrl.pathname === "/webhook") {
      const rawBody = await request.clone().text();
      let payload: any = null;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        // The base handler will return its normal bad-request response.
      }

      if (payload) {
        const secret = workerEnv.META_APP_SECRET?.trim();
        const signatureValid = !secret || await verifyWebhookSignature(
          rawBody,
          request.headers.get("X-Hub-Signature-256") ?? undefined,
          secret,
        );

        if (signatureValid) {
          const unsupported = extractUnsupportedMessages(payload);
          if (unsupported.length > 0) {
            await saveUnsupportedMessages(workerEnv, unsupported);

            const headers = new Headers(request.headers);
            headers.delete("content-length");
            headers.delete("x-hub-signature-256");
            const sanitizedRequest = new Request(request.url, {
              method: request.method,
              headers,
              body: JSON.stringify(payload),
            });
            const sanitizedEnv = secret
              ? { ...(env as Record<string, unknown>), META_APP_SECRET: "" }
              : env;

            return repairWorkerResponse(
              await baseHandler.fetch(sanitizedRequest, sanitizedEnv, ctx),
            );
          }
        }
      }
    }

    return repairWorkerResponse(await baseHandler.fetch(request, env, ctx));
  },
  scheduled(controller: unknown, env: unknown, ctx: unknown): unknown {
    return baseHandler.scheduled?.(controller, env, ctx);
  },
};
