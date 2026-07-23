type WorkerHandler = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Response | Promise<Response>;
  scheduled?: (controller: unknown, env: unknown, ctx: unknown) => unknown;
};

type BotEnv = {
  DB: any;
  META_APP_SECRET?: string;
  META_GRAPH_VERSION?: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  SHOP_DOMAIN?: string;
};

type OrderProduct = {
  title: string;
  url: string;
  handle?: string;
  price?: string | number;
  price_min?: string | number;
  available?: boolean;
  variants?: OrderVariant[];
};

type OrderVariant = {
  id: string | number;
  title: string;
  price: number | null;
  available: boolean;
};

type ManualOrderContext = {
  phone: string;
  step: string;
  selected_product: OrderProduct;
  selected_variant: OrderVariant | null;
  customization_text: string;
  quantity: number;
  customer_name: string;
  full_address: string;
  pincode: string;
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
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const nativeFetch = globalThis.fetch.bind(globalThis);

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

    const sequenceLength = utf8SequenceLength(firstByte);
    if (sequenceLength > 0 && index + sequenceLength <= characters.length) {
      const sequence = bytes.slice(index, index + sequenceLength);
      if (
        sequence.every((byte): byte is number => byte !== null) &&
        isValidUtf8Sequence(sequence)
      ) {
        try {
          output += utf8Decoder.decode(Uint8Array.from(sequence));
          index += sequenceLength;
          continue;
        } catch {
          // Preserve original text when decoding is not safe.
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
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        repairJsonValue(child),
      ]),
    );
  }
  return value;
}

const repairedFetch: typeof fetch = async (input, init) => {
  let nextInit = init;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  if (
    /^https:\/\/graph\.facebook\.com\//i.test(url) &&
    typeof init?.body === "string"
  ) {
    const contentType = new Headers(init.headers).get("content-type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        const payload = JSON.parse(init.body) as unknown;
        nextInit = { ...init, body: JSON.stringify(repairJsonValue(payload)) };
      } catch {
        // Keep original request when the body is not valid JSON.
      }
    }
  }

  return nativeFetch(input, nextInit);
};

try {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: repairedFetch,
  });
} catch {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = repairedFetch;
}

function normalizeOrderText(value: string): string {
  return value.toLowerCase().replace(/[₹,!?।]/g, " ").replace(/\s+/g, " ").trim();
}

function shopDomain(env: BotEnv): string {
  return String(env.SHOP_DOMAIN || "https://igstore.in").trim().replace(/\/+$/, "");
}

function absoluteProductUrl(env: BotEnv, product: OrderProduct): string {
  try {
    return new URL(product.url, `${shopDomain(env)}/`).toString();
  } catch {
    return shopDomain(env);
  }
}

function extractWebhookMessage(payload: any): {
  id: string;
  phone: string;
  text: string;
  profileName: string;
} | null {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const messages = Array.isArray(change?.value?.messages) ? change.value.messages : [];
      const contacts = Array.isArray(change?.value?.contacts) ? change.value.contacts : [];
      for (const message of messages) {
        const phone = String(message?.from ?? "");
        const text =
          message?.text?.body ??
          message?.button?.text ??
          message?.interactive?.button_reply?.title ??
          message?.interactive?.list_reply?.title ??
          message?.interactive?.button_reply?.id ??
          message?.interactive?.list_reply?.id;
        if (!phone || typeof text !== "string") continue;
        const contact = contacts.find((item: any) => String(item?.wa_id ?? "") === phone);
        return {
          id: String(message?.id ?? ""),
          phone,
          text,
          profileName: String(contact?.profile?.name ?? "").trim(),
        };
      }
    }
  }
  return null;
}

async function verifyMetaSignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret?.trim()) return true;
  if (!signature?.startsWith("sha256=")) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)),
  );
  const expected = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const received = signature.slice(7).toLowerCase();
  if (received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

async function ensureOrderTables(env: BotEnv): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS contacts (
        phone TEXT PRIMARY KEY,
        profile_name TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS order_flow_context (
        phone TEXT PRIMARY KEY,
        step TEXT NOT NULL,
        selected_product_json TEXT,
        selected_variant_json TEXT,
        customization_text TEXT NOT NULL DEFAULT '',
        quantity INTEGER NOT NULL DEFAULT 1,
        customer_name TEXT NOT NULL DEFAULT '',
        full_address TEXT NOT NULL DEFAULT '',
        pincode TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS last_product_suggestions (
        phone TEXT PRIMARY KEY,
        products_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS whatsapp_order_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
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
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS human_handoffs (
        phone TEXT PRIMARY KEY,
        reason TEXT NOT NULL DEFAULT 'customer_requested_support',
        status TEXT NOT NULL DEFAULT 'open',
        priority INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
  ]);
}

async function markManualMessage(env: BotEnv, messageId: string): Promise<boolean> {
  if (!messageId) return true;
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)",
  ).bind(messageId).run();
  return Number(result?.meta?.changes ?? 0) > 0;
}

async function unmarkManualMessage(env: BotEnv, messageId: string): Promise<void> {
  if (!messageId) return;
  await env.DB.prepare("DELETE FROM processed_messages WHERE message_id = ?")
    .bind(messageId)
    .run();
}

async function saveConversation(
  env: BotEnv,
  phone: string,
  direction: "in" | "out",
  body: string,
  messageId: string | null,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO conversations (phone, direction, body, whatsapp_message_id)
    VALUES (?, ?, ?, ?)
  `).bind(phone, direction, body.slice(0, 4000), messageId).run();
}

async function upsertContact(env: BotEnv, phone: string, profileName: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO contacts (phone, profile_name, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      profile_name = CASE WHEN excluded.profile_name != '' THEN excluded.profile_name ELSE contacts.profile_name END,
      updated_at = CURRENT_TIMESTAMP
  `).bind(phone, profileName.slice(0, 120)).run();
}

async function sendWhatsAppText(env: BotEnv, phone: string, body: string): Promise<void> {
  const graphVersion = String(env.META_GRAPH_VERSION || "v25.0").trim();
  const response = await repairedFetch(
    `https://graph.facebook.com/${graphVersion}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phone,
        type: "text",
        text: { preview_url: true, body: body.slice(0, 4096) },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Manual WhatsApp order reply failed: ${response.status}`);
  }
  await saveConversation(env, phone, "out", body, null);
}

async function getManualContext(env: BotEnv, phone: string): Promise<ManualOrderContext | null> {
  const row = await env.DB.prepare(`
    SELECT phone, step, selected_product_json, selected_variant_json,
           customization_text, quantity, customer_name, full_address, pincode
    FROM order_flow_context
    WHERE phone = ? AND step LIKE 'wa_%'
    LIMIT 1
  `).bind(phone).first<any>();
  if (!row) return null;
  try {
    return {
      phone: row.phone,
      step: row.step,
      selected_product: JSON.parse(row.selected_product_json),
      selected_variant: row.selected_variant_json ? JSON.parse(row.selected_variant_json) : null,
      customization_text: row.customization_text || "",
      quantity: Number(row.quantity || 1),
      customer_name: row.customer_name || "",
      full_address: row.full_address || "",
      pincode: row.pincode || "",
    };
  } catch {
    await clearManualContext(env, phone);
    return null;
  }
}

async function saveManualContext(env: BotEnv, context: ManualOrderContext): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO order_flow_context (
      phone, step, selected_product_json, selected_variant_json,
      customization_text, quantity, customer_name, full_address, pincode, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      step = excluded.step,
      selected_product_json = excluded.selected_product_json,
      selected_variant_json = excluded.selected_variant_json,
      customization_text = excluded.customization_text,
      quantity = excluded.quantity,
      customer_name = excluded.customer_name,
      full_address = excluded.full_address,
      pincode = excluded.pincode,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    context.phone,
    context.step,
    JSON.stringify(context.selected_product),
    context.selected_variant ? JSON.stringify(context.selected_variant) : null,
    context.customization_text,
    context.quantity,
    context.customer_name,
    context.full_address,
    context.pincode,
  ).run();
}

async function clearManualContext(env: BotEnv, phone: string): Promise<void> {
  await env.DB.prepare("DELETE FROM order_flow_context WHERE phone = ?")
    .bind(phone)
    .run();
}

async function getProductSuggestions(env: BotEnv, phone: string): Promise<OrderProduct[]> {
  const row = await env.DB.prepare(`
    SELECT products_json
    FROM last_product_suggestions
    WHERE phone = ? AND datetime(updated_at) >= datetime('now', '-24 hours')
    LIMIT 1
  `).bind(phone).first<{ products_json: string }>();
  if (!row?.products_json) return [];
  try {
    const products = JSON.parse(row.products_json);
    return Array.isArray(products) ? products.slice(0, 3) : [];
  } catch {
    return [];
  }
}

function parseProductOption(value: string): number | null {
  const normalized = normalizeOrderText(value);
  const exact = /^(?:option|product|design)?\s*([1-3])(?:\s*(?:order|buy|chahiye|final))?$/.exec(normalized);
  if (exact) return Number(exact[1]);
  const embedded = /(?:option|product|design)\s*([1-3])/.exec(normalized);
  return embedded ? Number(embedded[1]) : null;
}

function hasBuyIntent(value: string): boolean {
  const normalized = normalizeOrderText(value);
  return [
    "order karna", "order place", "buy now", "book kar", "ye wala chahiye",
    "final kar", "purchase", "customise now", "customize now", "confirm order",
    "order option", "option order", "ऑर्डर करना", "ऑर्डर कर दो", "बुक कर दो", "खरीदना",
  ].some((term) => normalized.includes(term));
}

async function recentMessageAskedForProductOption(env: BotEnv, phone: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT body FROM conversations
    WHERE phone = ? AND direction = 'out'
    ORDER BY id DESC LIMIT 1
  `).bind(phone).first<{ body: string }>();
  const body = repairMojibake(String(row?.body ?? "")).toLowerCase();
  return /option|design|pasand|which product|kaunsa product|कौन-सा/.test(body);
}

function ajaxPriceToRupees(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount / 100 : null;
}

function productPrice(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

async function enrichOrderProduct(env: BotEnv, product: OrderProduct): Promise<OrderProduct> {
  try {
    const url = new URL(absoluteProductUrl(env, product));
    url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\.js$/i, "")}.js`;
    url.search = "";
    const response = await nativeFetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) return product;
    const data: any = await response.json();
    const variants: OrderVariant[] = Array.isArray(data?.variants)
      ? data.variants
          .map((variant: any) => ({
            id: String(variant?.id ?? ""),
            title: String(variant?.title ?? "Default Title"),
            price: ajaxPriceToRupees(variant?.price),
            available: variant?.available !== false,
          }))
          .filter((variant: OrderVariant) => Boolean(String(variant.id).trim()))
      : [];
    return {
      ...product,
      title: String(data?.title ?? product.title),
      handle: String(data?.handle ?? product.handle ?? ""),
      available: data?.available !== false,
      price: ajaxPriceToRupees(data?.price) ?? product.price,
      price_min: ajaxPriceToRupees(data?.price_min) ?? product.price_min,
      variants,
    };
  } catch (error) {
    console.error("WhatsApp order product enrichment failed", String(error));
    return product;
  }
}

function isDefaultVariant(variant: OrderVariant): boolean {
  return normalizeOrderText(variant.title) === "default title";
}

function isCustomProduct(product: OrderProduct): boolean {
  return /(custom|personalized|personalised|name|photo|neon|cutout|engraved)/i.test(product.title);
}

function selectableVariants(product: OrderProduct): OrderVariant[] {
  const all = (product.variants ?? []).filter((variant) => Boolean(String(variant.id).trim()));
  const available = all.filter((variant) => variant.available !== false);
  return available.length > 0 ? available : all;
}

function fallbackVariant(product: OrderProduct): OrderVariant {
  return {
    id: "manual",
    title: "Standard / Team confirmation",
    price: productPrice(product.price_min ?? product.price),
    available: false,
  };
}

function variantChoiceMessage(product: OrderProduct, variants: OrderVariant[]): string {
  const options = variants.slice(0, 9).map((variant, index) => {
    const price = variant.price === null ? "" : ` — ₹${variant.price.toFixed(2)}`;
    return `${index + 1}. ${variant.title}${price}`;
  }).join("\n");
  return `*${product.title}* ke liye option select karein:\n${options}\n\nSirf option number bhejein.`;
}

function selectVariant(variants: OrderVariant[], value: string): OrderVariant | null {
  const normalized = normalizeOrderText(value);
  const number = /^(?:option\s*)?([1-9])$/.exec(normalized);
  if (number) return variants[Number(number[1]) - 1] ?? null;
  const direct = variants.find((variant) => normalizeOrderText(variant.title) === normalized);
  if (direct) return direct;
  return variants.find((variant) => normalizeOrderText(variant.title).includes(normalized)) ?? null;
}

function customizationQuestion(product: OrderProduct): string {
  return `*${product.title}* par kaunsa name/text customise karna hai? Customization nahi chahiye to *NA* likhein.`;
}

function orderVariantLabel(context: ManualOrderContext): string {
  const title = context.selected_variant?.title || "";
  return title && normalizeOrderText(title) !== "default title" && !title.startsWith("Standard /")
    ? `\nOption: ${title}`
    : "";
}

function orderTotal(context: ManualOrderContext): string {
  const price = context.selected_variant?.price;
  return price === null || price === undefined
    ? "Team confirmation ke baad"
    : `₹${(price * context.quantity).toFixed(2)}`;
}

function orderSummary(context: ManualOrderContext): string {
  const custom = context.customization_text ? `\nCustomization: ${context.customization_text}` : "";
  return `✅ *Order Summary*\n\nProduct: ${context.selected_product.title}${orderVariantLabel(context)}${custom}\nQuantity: ${context.quantity}\nTotal: ${orderTotal(context)}\n\nDelivery Name: ${context.customer_name}\nAddress: ${context.full_address}\nPIN: ${context.pincode}\n\nOrder sahi hai to *Confirm Order* likhein. Cancel ke liye *Cancel Order* likhein.`;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function canCreateDirectCheckout(variant: OrderVariant | null): boolean {
  return Boolean(variant && variant.available !== false && /^\d+$/.test(String(variant.id)));
}

function buildDirectCheckoutUrl(env: BotEnv, context: ManualOrderContext): string {
  const variantId = String(context.selected_variant?.id ?? "");
  const quantity = Math.max(1, Math.min(10, context.quantity));
  const url = new URL(`/cart/${variantId}:${quantity}`, shopDomain(env));
  const properties: Record<string, string> = {
    "WhatsApp Phone": `+${context.phone}`,
    "Order Source": "WhatsApp Bot",
  };
  if (context.customization_text) properties["Custom Text"] = context.customization_text;
  url.searchParams.set("properties", base64UrlEncode(JSON.stringify(properties)));
  url.searchParams.set("checkout[shipping_address][first_name]", context.customer_name);
  url.searchParams.set("checkout[shipping_address][address1]", context.full_address);
  url.searchParams.set("checkout[shipping_address][zip]", context.pincode);
  url.searchParams.set("checkout[shipping_address][country]", "India");
  url.searchParams.set("attributes[WhatsApp Phone]", `+${context.phone}`);
  url.searchParams.set("attributes[Order Source]", "WhatsApp Bot");
  url.searchParams.set("ref", "whatsapp-bot");
  return url.toString();
}

async function saveOrderDraft(
  env: BotEnv,
  context: ManualOrderContext,
  checkoutUrl: string,
  status: "payment_pending" | "manual_review",
): Promise<void> {
  const unitPrice = context.selected_variant?.price ?? null;
  const totalPrice = unitPrice === null ? null : unitPrice * context.quantity;
  await env.DB.prepare(`
    INSERT INTO whatsapp_order_drafts (
      phone, customer_name, product_title, product_url, variant_id, variant_title,
      customization_text, quantity, unit_price, total_price, full_address, pincode,
      checkout_url, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    context.phone,
    context.customer_name,
    context.selected_product.title,
    absoluteProductUrl(env, context.selected_product),
    String(context.selected_variant?.id ?? "manual"),
    context.selected_variant?.title || "Team confirmation",
    context.customization_text,
    context.quantity,
    unitPrice,
    totalPrice,
    context.full_address,
    context.pincode,
    checkoutUrl,
    status,
  ).run();
}

async function createOrderHandoff(env: BotEnv, phone: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO human_handoffs (phone, reason, status, priority, created_at, updated_at)
    VALUES (?, 'whatsapp_manual_order', 'open', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      reason = 'whatsapp_manual_order', status = 'open', priority = 2,
      updated_at = CURRENT_TIMESTAMP
  `).bind(phone).run();
}

async function startWhatsAppOrder(
  env: BotEnv,
  phone: string,
  text: string,
): Promise<boolean> {
  const suggestions = await getProductSuggestions(env, phone);
  if (suggestions.length === 0) return false;

  const option = parseProductOption(text);
  const buyIntent = hasBuyIntent(text);
  const recentOptionPrompt = await recentMessageAskedForProductOption(env, phone);
  if (!buyIntent && !(option !== null && recentOptionPrompt)) return false;

  let selectedIndex = option ? option - 1 : suggestions.length === 1 ? 0 : -1;
  if (selectedIndex < 0 || !suggestions[selectedIndex]) {
    const options = suggestions.map((_, index) => index + 1).join(", ");
    await sendWhatsAppText(env, phone, `Kaunsa product order karna hai? Option ${options} mein se number bhejein.`);
    return true;
  }

  const product = await enrichOrderProduct(env, suggestions[selectedIndex]);
  let variants = selectableVariants(product);
  if (variants.length === 0) variants = [fallbackVariant(product)];
  product.variants = variants;

  const meaningful = variants.filter((variant) => !isDefaultVariant(variant));
  const selectedVariant = meaningful.length <= 1 ? (meaningful[0] ?? variants[0]) : null;
  const context: ManualOrderContext = {
    phone,
    step: selectedVariant
      ? isCustomProduct(product) ? "wa_customization" : "wa_quantity"
      : "wa_variant",
    selected_product: product,
    selected_variant: selectedVariant,
    customization_text: "",
    quantity: 1,
    customer_name: "",
    full_address: "",
    pincode: "",
  };
  await saveManualContext(env, context);

  if (!selectedVariant) {
    await sendWhatsAppText(env, phone, variantChoiceMessage(product, meaningful));
  } else if (context.step === "wa_customization") {
    await sendWhatsAppText(env, phone, customizationQuestion(product));
  } else {
    await sendWhatsAppText(env, phone, "Quantity kitni chahiye? 1 se 10 ke beech number bhejein.");
  }
  return true;
}

async function continueWhatsAppOrder(
  env: BotEnv,
  context: ManualOrderContext,
  text: string,
): Promise<void> {
  const normalized = normalizeOrderText(text);
  if (["cancel", "cancel order", "stop", "nahi chahiye", "नहीं चाहिए", "रद्द"].some((term) => normalized.includes(term))) {
    await clearManualContext(env, context.phone);
    await sendWhatsAppText(env, context.phone, "Order process cancel kar diya gaya hai ✅");
    return;
  }

  if (context.step === "wa_variant") {
    const variants = context.selected_product.variants ?? [];
    const selected = selectVariant(variants, text);
    if (!selected) {
      await sendWhatsAppText(env, context.phone, variantChoiceMessage(context.selected_product, variants));
      return;
    }
    context.selected_variant = selected;
    context.step = isCustomProduct(context.selected_product) ? "wa_customization" : "wa_quantity";
    await saveManualContext(env, context);
    await sendWhatsAppText(
      env,
      context.phone,
      context.step === "wa_customization"
        ? customizationQuestion(context.selected_product)
        : "Quantity kitni chahiye? 1 se 10 ke beech number bhejein.",
    );
    return;
  }

  if (context.step === "wa_customization") {
    const value = text.trim();
    if (!value || value.length > 150) {
      await sendWhatsAppText(env, context.phone, customizationQuestion(context.selected_product));
      return;
    }
    context.customization_text = /^(na|n\/a|no|none|नहीं)$/i.test(value) ? "" : value;
    context.step = "wa_quantity";
    await saveManualContext(env, context);
    await sendWhatsAppText(env, context.phone, "Quantity kitni chahiye? 1 se 10 ke beech number bhejein.");
    return;
  }

  if (context.step === "wa_quantity") {
    const match = /(?:qty|quantity)?\s*([1-9]|10)\b/i.exec(text.trim());
    const quantity = match ? Number(match[1]) : 0;
    if (quantity < 1 || quantity > 10) {
      await sendWhatsAppText(env, context.phone, "Quantity kitni chahiye? 1 se 10 ke beech number bhejein.");
      return;
    }
    context.quantity = quantity;
    context.step = "wa_name";
    await saveManualContext(env, context);
    await sendWhatsAppText(env, context.phone, "Delivery ke liye customer ka full name bhejein.");
    return;
  }

  if (context.step === "wa_name") {
    const value = text.trim().replace(/\s+/g, " ");
    if (value.length < 2 || value.length > 80) {
      await sendWhatsAppText(env, context.phone, "Delivery ke liye customer ka full name bhejein.");
      return;
    }
    context.customer_name = value;
    context.step = "wa_address";
    await saveManualContext(env, context);
    await sendWhatsAppText(env, context.phone, "Pura delivery address bhejein: House/Street, Area, City aur State.");
    return;
  }

  if (context.step === "wa_address") {
    const value = text.trim().replace(/\s+/g, " ");
    if (value.length < 12 || value.length > 300) {
      await sendWhatsAppText(env, context.phone, "Pura delivery address bhejein: House/Street, Area, City aur State.");
      return;
    }
    context.full_address = value;
    context.step = "wa_pincode";
    await saveManualContext(env, context);
    await sendWhatsAppText(env, context.phone, "6 digit delivery PIN code bhejein.");
    return;
  }

  if (context.step === "wa_pincode") {
    const match = /\b([1-9][0-9]{5})\b/.exec(text);
    if (!match) {
      await sendWhatsAppText(env, context.phone, "6 digit delivery PIN code bhejein.");
      return;
    }
    context.pincode = match[1];
    context.step = "wa_confirm";
    await saveManualContext(env, context);
    await sendWhatsAppText(env, context.phone, orderSummary(context));
    return;
  }

  if (context.step === "wa_confirm") {
    const confirmed = [
      "confirm", "confirm order", "yes confirm", "place order", "payment link",
      "pay now", "haan confirm", "हाँ कन्फर्म",
    ].some((term) => normalized === term || normalized.includes(term));
    if (!confirmed) {
      await sendWhatsAppText(env, context.phone, "Order receive karne ke liye *Confirm Order* likhein, ya *Cancel Order* likhein.");
      return;
    }

    const directCheckout = canCreateDirectCheckout(context.selected_variant);
    const checkoutUrl = directCheckout
      ? buildDirectCheckoutUrl(env, context)
      : absoluteProductUrl(env, context.selected_product);
    await saveOrderDraft(
      env,
      context,
      checkoutUrl,
      directCheckout ? "payment_pending" : "manual_review",
    );

    if (directCheckout) {
      await sendWhatsAppText(
        env,
        context.phone,
        `✅ *Order details received*\n\n🔐 Secure payment link:\n${checkoutUrl}\n\nPayment ke baad Shopify order number milega. OTP, UPI PIN, CVV ya card PIN WhatsApp par share na karein.`,
      );
    } else {
      await createOrderHandoff(env, context.phone);
      const requestId = `WA${Date.now().toString().slice(-8)}`;
      await sendWhatsAppText(
        env,
        context.phone,
        `✅ *WhatsApp Order Received*\n\nRequest ID: ${requestId}\nProduct: ${context.selected_product.title}${orderVariantLabel(context)}${context.customization_text ? `\nCustomization: ${context.customization_text}` : ""}\nQuantity: ${context.quantity}\nCustomer: ${context.customer_name}\nPIN: ${context.pincode}\n\nIG Store team final price aur secure payment link confirm karegi. Aapka complete order request admin inbox mein receive ho gaya hai.`,
      );
    }
    await clearManualContext(env, context.phone);
  }
}

async function maybeHandleWhatsAppOrder(
  request: Request,
  env: BotEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/webhook") return null;

  const rawBody = await request.clone().text();
  if (!(await verifyMetaSignature(rawBody, request.headers.get("X-Hub-Signature-256"), env.META_APP_SECRET))) {
    return null;
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const message = extractWebhookMessage(payload);
  if (!message) return null;
  await ensureOrderTables(env);

  const context = await getManualContext(env, message.phone);
  if (!context) {
    const suggestions = await getProductSuggestions(env, message.phone);
    const option = parseProductOption(message.text);
    const recentPrompt = option !== null
      ? await recentMessageAskedForProductOption(env, message.phone)
      : false;
    if (suggestions.length === 0 || (!hasBuyIntent(message.text) && !recentPrompt)) {
      return null;
    }
  }

  const isNew = await markManualMessage(env, message.id);
  if (!isNew) return new Response("EVENT_RECEIVED", { status: 200 });

  try {
    await upsertContact(env, message.phone, message.profileName);
    await saveConversation(env, message.phone, "in", message.text, message.id || null);
    const activeContext = context ?? await getManualContext(env, message.phone);
    if (activeContext) {
      await continueWhatsAppOrder(env, activeContext, message.text);
    } else {
      const started = await startWhatsAppOrder(env, message.phone, message.text);
      if (!started) {
        await unmarkManualMessage(env, message.id);
        return null;
      }
    }
    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (error) {
    console.error("WhatsApp complete order flow failed", String(error));
    await createOrderHandoff(env, message.phone).catch(() => undefined);
    await sendWhatsAppText(
      env,
      message.phone,
      "Aapka order request IG Store support team ko forward kar diya gaya hai. Product details isi chat mein bhejte rahein; team order complete karegi.",
    ).catch(() => undefined);
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
}

let handlerPromise: Promise<WorkerHandler> | null = null;

function loadHandler(): Promise<WorkerHandler> {
  if (!handlerPromise) {
    handlerPromise = import("./index").then((module) => module.default as WorkerHandler);
  }
  return handlerPromise;
}

async function repairWorkerResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !contentType.includes("text/") &&
    !contentType.includes("application/json") &&
    !contentType.includes("application/javascript")
  ) {
    return response;
  }

  const repairedBody = repairMojibake(await response.text());
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");

  return new Response(repairedBody, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    const orderResponse = await maybeHandleWhatsAppOrder(request, env as BotEnv);
    if (orderResponse) return orderResponse;
    const handler = await loadHandler();
    return repairWorkerResponse(await handler.fetch(request, env, ctx));
  },
  scheduled(controller: unknown, env: unknown, ctx: unknown): void {
    const executionContext = ctx as { waitUntil?: (promise: Promise<unknown>) => void };
    const task = loadHandler().then((handler) => handler.scheduled?.(controller, env, ctx));
    executionContext.waitUntil?.(task);
  },
};
