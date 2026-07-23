import baseHandler from "./entry";

type BotEnv = {
  DB: any;
  META_APP_SECRET?: string;
  SHOP_DOMAIN?: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  META_GRAPH_VERSION?: string;
};

type WorkerHandler = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Response | Promise<Response>;
  scheduled?: (controller: unknown, env: unknown, ctx: unknown) => unknown;
};

type OrderVariant = {
  id?: string | number;
  title?: string;
  price?: number | null;
  available?: boolean;
};

type OrderProduct = {
  title?: string;
  url?: string;
  variants?: OrderVariant[];
  price?: string | number;
  price_min?: string | number;
};

type StoredOrderContext = {
  phone: string;
  step: string;
  selected_product: OrderProduct;
  selected_variant: OrderVariant | null;
  customization_text: string;
  quantity: number;
  customer_name: string;
  mobile_phone: string;
  full_address: string;
  pincode: string;
};

const handler = baseHandler as WorkerHandler;

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[₹,!?।]/g, " ").replace(/\s+/g, " ").trim();
}

function shopDomain(env: BotEnv): string {
  return String(env.SHOP_DOMAIN || "https://igstore.in").trim().replace(/\/+$/, "");
}

function absoluteProductUrl(env: BotEnv, product: OrderProduct): string {
  try {
    return new URL(String(product.url || "/"), `${shopDomain(env)}/`).toString();
  } catch {
    return shopDomain(env);
  }
}

function extractIncomingMessage(payload: any): {
  id: string;
  phone: string;
  text: string;
} | null {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const messages = Array.isArray(change?.value?.messages) ? change.value.messages : [];
      for (const message of messages) {
        const phone = String(message?.from ?? "");
        const text =
          message?.text?.body ??
          message?.button?.text ??
          message?.interactive?.button_reply?.title ??
          message?.interactive?.list_reply?.title ??
          message?.interactive?.button_reply?.id ??
          message?.interactive?.list_reply?.id;
        if (phone && typeof text === "string") {
          return { id: String(message?.id ?? ""), phone, text };
        }
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

async function ensureMobileColumns(env: BotEnv): Promise<void> {
  const statements = [
    "ALTER TABLE order_flow_context ADD COLUMN mobile_phone TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE whatsapp_order_drafts ADD COLUMN mobile_phone TEXT NOT NULL DEFAULT ''",
  ];

  for (const statement of statements) {
    try {
      await env.DB.prepare(statement).run();
    } catch (error) {
      const message = String(error).toLowerCase();
      if (!message.includes("duplicate column") && !message.includes("already exists")) {
        console.error("Mobile column migration failed", String(error));
      }
    }
  }
}

async function getOrderContext(env: BotEnv, phone: string): Promise<StoredOrderContext | null> {
  await ensureMobileColumns(env);
  const row = await env.DB.prepare(`
    SELECT phone, step, selected_product_json, selected_variant_json,
           customization_text, quantity, customer_name, mobile_phone,
           full_address, pincode
    FROM order_flow_context
    WHERE phone = ? AND step IN ('wa_name', 'wa_mobile', 'wa_confirm')
    LIMIT 1
  `).bind(phone).first<any>();

  if (!row) return null;
  try {
    return {
      phone: String(row.phone || phone),
      step: String(row.step || ""),
      selected_product: row.selected_product_json
        ? JSON.parse(row.selected_product_json)
        : {},
      selected_variant: row.selected_variant_json
        ? JSON.parse(row.selected_variant_json)
        : null,
      customization_text: String(row.customization_text || ""),
      quantity: Math.max(1, Math.min(10, Number(row.quantity || 1))),
      customer_name: String(row.customer_name || ""),
      mobile_phone: String(row.mobile_phone || ""),
      full_address: String(row.full_address || ""),
      pincode: String(row.pincode || ""),
    };
  } catch (error) {
    console.error("Order context parse failed", String(error));
    return null;
  }
}

async function claimMessage(env: BotEnv, messageId: string): Promise<boolean> {
  if (!messageId) return true;
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)",
  ).bind(messageId).run();
  return Number(result?.meta?.changes ?? 0) > 0;
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

async function sendText(env: BotEnv, phone: string, body: string): Promise<void> {
  const graphVersion = String(env.META_GRAPH_VERSION || "v25.0").trim();
  const response = await fetch(
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
    throw new Error(`WhatsApp reply failed with status ${response.status}`);
  }
  await saveConversation(env, phone, "out", body, null);
}

function parseIndianMobile(value: string): string | null {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  return /^[6-9][0-9]{9}$/.test(digits) ? digits : null;
}

function numericVariantId(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? digits : null;
}

async function resolveVariant(env: BotEnv, context: StoredOrderContext): Promise<OrderVariant | null> {
  const selectedId = numericVariantId(context.selected_variant?.id);
  if (selectedId) return { ...context.selected_variant, id: selectedId };

  const productVariants = Array.isArray(context.selected_product.variants)
    ? context.selected_product.variants
    : [];
  const localVariant = productVariants.find((variant) => numericVariantId(variant?.id));
  if (localVariant) {
    return { ...localVariant, id: numericVariantId(localVariant.id)! };
  }

  try {
    const productUrl = new URL(absoluteProductUrl(env, context.selected_product));
    productUrl.pathname = `${productUrl.pathname.replace(/\/+$/, "").replace(/\.js$/i, "")}.js`;
    productUrl.search = "";
    const response = await fetch(productUrl.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const payload: any = await response.json();
    const variants = Array.isArray(payload?.variants) ? payload.variants : [];
    const available = variants.find((variant: any) =>
      variant?.available !== false && numericVariantId(variant?.id),
    );
    const fallback = available ?? variants.find((variant: any) => numericVariantId(variant?.id));
    if (!fallback) return null;
    return {
      id: numericVariantId(fallback.id)!,
      title: String(fallback.title || "Default Title"),
      price: Number.isFinite(Number(fallback.price)) ? Number(fallback.price) / 100 : null,
      available: fallback.available !== false,
    };
  } catch (error) {
    console.error("Variant retry failed", String(error));
    return null;
  }
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildCheckoutUrl(
  env: BotEnv,
  context: StoredOrderContext,
  variant: OrderVariant,
): string {
  const variantId = numericVariantId(variant.id);
  if (!variantId) throw new Error("Shopify variant ID missing");

  const url = new URL(`/cart/${variantId}:${context.quantity}`, shopDomain(env));
  const properties: Record<string, string> = {
    "WhatsApp Phone": `+${context.phone}`,
    "Customer Mobile": `+91${context.mobile_phone}`,
    "Order Source": "WhatsApp Bot",
  };
  if (context.customization_text) properties["Custom Text"] = context.customization_text;

  url.searchParams.set("properties", base64UrlEncode(JSON.stringify(properties)));
  url.searchParams.set("checkout[shipping_address][first_name]", context.customer_name);
  url.searchParams.set("checkout[shipping_address][address1]", context.full_address);
  url.searchParams.set("checkout[shipping_address][zip]", context.pincode);
  url.searchParams.set("checkout[shipping_address][phone]", `+91${context.mobile_phone}`);
  url.searchParams.set("checkout[shipping_address][country]", "India");
  url.searchParams.set("attributes[WhatsApp Phone]", `+${context.phone}`);
  url.searchParams.set("attributes[Customer Mobile]", `+91${context.mobile_phone}`);
  url.searchParams.set("attributes[Order Source]", "WhatsApp Bot");
  url.searchParams.set("ref", "whatsapp-bot");
  return url.toString();
}

function variantTitle(variant: OrderVariant | null): string {
  const title = String(variant?.title || "").trim();
  return title && normalizeText(title) !== "default title" ? title : "";
}

function productPrice(context: StoredOrderContext, variant: OrderVariant | null): number | null {
  const variantPrice = Number(variant?.price);
  if (Number.isFinite(variantPrice)) return variantPrice;
  const productPriceValue = Number(
    context.selected_product.price_min ?? context.selected_product.price,
  );
  return Number.isFinite(productPriceValue) ? productPriceValue : null;
}

async function saveDraft(
  env: BotEnv,
  context: StoredOrderContext,
  variant: OrderVariant | null,
  checkoutUrl: string,
  status: "payment_pending" | "manual_review",
): Promise<void> {
  const unitPrice = productPrice(context, variant);
  const totalPrice = unitPrice === null ? null : unitPrice * context.quantity;
  await env.DB.prepare(`
    INSERT INTO whatsapp_order_drafts (
      phone, mobile_phone, customer_name, product_title, product_url,
      variant_id, variant_title, customization_text, quantity, unit_price,
      total_price, full_address, pincode, checkout_url, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    context.phone,
    context.mobile_phone,
    context.customer_name,
    String(context.selected_product.title || "Product"),
    absoluteProductUrl(env, context.selected_product),
    String(variant?.id || "manual"),
    variantTitle(variant) || "Default / Team confirmation",
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

async function createManualHandoff(env: BotEnv, phone: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO human_handoffs (phone, reason, status, priority, created_at, updated_at)
    VALUES (?, 'whatsapp_payment_link_review', 'open', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      reason = 'whatsapp_payment_link_review', status = 'open', priority = 2,
      updated_at = CURRENT_TIMESTAMP
  `).bind(phone).run();
}

async function clearContext(env: BotEnv, phone: string): Promise<void> {
  await env.DB.prepare("DELETE FROM order_flow_context WHERE phone = ?").bind(phone).run();
}

async function handleNameStep(
  env: BotEnv,
  context: StoredOrderContext,
  text: string,
): Promise<void> {
  const name = text.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) {
    await sendText(env, context.phone, "Delivery ke liye customer ka full name bhejein.");
    return;
  }

  await env.DB.prepare(`
    UPDATE order_flow_context
    SET customer_name = ?, step = 'wa_mobile', updated_at = CURRENT_TIMESTAMP
    WHERE phone = ?
  `).bind(name, context.phone).run();
  await sendText(
    env,
    context.phone,
    "Delivery aur order confirmation ke liye 10-digit mobile number bhejein. Example: 9587666693",
  );
}

async function handleMobileStep(
  env: BotEnv,
  context: StoredOrderContext,
  text: string,
): Promise<void> {
  const mobile = parseIndianMobile(text);
  if (!mobile) {
    await sendText(
      env,
      context.phone,
      "Sahi 10-digit Indian mobile number bhejein. Number 6, 7, 8 ya 9 se start hona chahiye.",
    );
    return;
  }

  await env.DB.prepare(`
    UPDATE order_flow_context
    SET mobile_phone = ?, step = 'wa_address', updated_at = CURRENT_TIMESTAMP
    WHERE phone = ?
  `).bind(mobile, context.phone).run();
  await sendText(
    env,
    context.phone,
    "Pura delivery address bhejein: House/Street, Area, City aur State.",
  );
}

async function handleConfirmStep(
  env: BotEnv,
  context: StoredOrderContext,
  text: string,
): Promise<void> {
  const normalized = normalizeText(text);
  const cancel = ["cancel", "cancel order", "stop", "nahi chahiye", "नहीं चाहिए", "रद्द"]
    .some((term) => normalized.includes(term));
  if (cancel) {
    await clearContext(env, context.phone);
    await sendText(env, context.phone, "Order process cancel kar diya gaya hai ✅");
    return;
  }

  const confirmed = [
    "confirm", "confirm order", "yes confirm", "place order", "payment link",
    "pay now", "haan confirm", "हाँ कन्फर्म",
  ].some((term) => normalized === term || normalized.includes(term));
  if (!confirmed) {
    await sendText(
      env,
      context.phone,
      "Payment link banane ke liye *Confirm Order* likhein, ya *Cancel Order* likhein.",
    );
    return;
  }

  if (!context.mobile_phone) {
    await env.DB.prepare(`
      UPDATE order_flow_context
      SET step = 'wa_mobile', updated_at = CURRENT_TIMESTAMP
      WHERE phone = ?
    `).bind(context.phone).run();
    await sendText(
      env,
      context.phone,
      "Payment link ke liye pehle 10-digit mobile number bhejein. Example: 9587666693",
    );
    return;
  }

  const variant = await resolveVariant(env, context);
  const productUrl = absoluteProductUrl(env, context.selected_product);
  const checkoutUrl = variant ? buildCheckoutUrl(env, context, variant) : productUrl;
  await saveDraft(
    env,
    context,
    variant,
    checkoutUrl,
    variant ? "payment_pending" : "manual_review",
  );

  const option = variantTitle(variant);
  const optionLine = option ? `\nOption: ${option}` : "";
  const customLine = context.customization_text
    ? `\nCustomization: ${context.customization_text}`
    : "";

  if (variant) {
    await sendText(
      env,
      context.phone,
      `✅ *Order Details Received*\n\nProduct: ${String(context.selected_product.title || "Product")}${optionLine}${customLine}\nQuantity: ${context.quantity}\nCustomer: ${context.customer_name}\nMobile: +91 ${context.mobile_phone}\nPIN: ${context.pincode}\n\n🔐 *Secure Payment Link:*\n${checkoutUrl}\n\nPayment complete hone ke baad Shopify order number milega. OTP, UPI PIN, CVV ya card PIN WhatsApp par share na karein.`,
    );
  } else {
    await createManualHandoff(env, context.phone);
    await sendText(
      env,
      context.phone,
      `✅ *Order Details Received*\n\nProduct: ${String(context.selected_product.title || "Product")}${customLine}\nQuantity: ${context.quantity}\nCustomer: ${context.customer_name}\nMobile: +91 ${context.mobile_phone}\nPIN: ${context.pincode}\n\n🔐 *Order & Payment Page:*\n${checkoutUrl}\n\nProduct option select karke payment complete karein. IG Store team bhi order ko admin inbox se verify karegi.`,
    );
  }

  await clearContext(env, context.phone);
}

async function maybeHandleOrderMobileAndPayment(
  request: Request,
  env: BotEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/webhook") return null;

  const rawBody = await request.clone().text();
  if (!(await verifyMetaSignature(
    rawBody,
    request.headers.get("X-Hub-Signature-256"),
    env.META_APP_SECRET,
  ))) {
    return null;
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const message = extractIncomingMessage(payload);
  if (!message) return null;
  const context = await getOrderContext(env, message.phone);
  if (!context) return null;

  if (!(await claimMessage(env, message.id))) {
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  await saveConversation(env, message.phone, "in", message.text, message.id || null);
  if (context.step === "wa_name") {
    await handleNameStep(env, context, message.text);
  } else if (context.step === "wa_mobile") {
    await handleMobileStep(env, context, message.text);
  } else if (context.step === "wa_confirm") {
    await handleConfirmStep(env, context, message.text);
  }

  return new Response("EVENT_RECEIVED", { status: 200 });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    try {
      const handled = await maybeHandleOrderMobileAndPayment(request, env as BotEnv);
      if (handled) return handled;
    } catch (error) {
      console.error("Mobile/payment order wrapper failed", String(error));
    }
    return handler.fetch(request, env, ctx);
  },
  scheduled(controller: unknown, env: unknown, ctx: unknown): unknown {
    return handler.scheduled?.(controller, env, ctx);
  },
};
