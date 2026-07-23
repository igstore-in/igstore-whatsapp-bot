import baseHandler from "./order-entry";

type BotEnv = {
  DB: any;
  META_APP_SECRET?: string;
  META_GRAPH_VERSION?: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  SHOP_DOMAIN?: string;
};

type WorkerHandler = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Response | Promise<Response>;
  scheduled?: (controller: unknown, env: unknown, ctx: unknown) => unknown;
};

type Variant = {
  id: string;
  title: string;
  price: number | null;
  available: boolean;
};

type Product = {
  title: string;
  url: string;
  price?: string | number;
  price_min?: string | number;
  variants?: Variant[];
};

type VariantOrderContext = {
  phone: string;
  step: string;
  selected_product: Product;
  selected_variant: Variant | null;
  customization_text: string;
  quantity: number;
  customer_name: string;
  mobile_phone: string;
  full_address: string;
  pincode: string;
};

const handler = baseHandler as WorkerHandler;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[₹,!?।]/g, " ").replace(/\s+/g, " ").trim();
}

function shopDomain(env: BotEnv): string {
  return String(env.SHOP_DOMAIN || "https://igstore.in").trim().replace(/\/+$/, "");
}

function absoluteProductUrl(env: BotEnv, product: Product): string {
  try {
    return new URL(product.url, `${shopDomain(env)}/`).toString();
  } catch {
    return shopDomain(env);
  }
}

function extractMessage(payload: any): { id: string; phone: string; text: string } | null {
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      for (const message of Array.isArray(change?.value?.messages) ? change.value.messages : []) {
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
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  const expected = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const received = signature.slice(7).toLowerCase();
  if (received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

async function ensureColumns(env: BotEnv): Promise<void> {
  for (const sql of [
    "ALTER TABLE order_flow_context ADD COLUMN mobile_phone TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE whatsapp_order_drafts ADD COLUMN mobile_phone TEXT NOT NULL DEFAULT ''",
  ]) {
    try {
      await env.DB.prepare(sql).run();
    } catch (error) {
      const message = String(error).toLowerCase();
      if (!message.includes("duplicate column") && !message.includes("already exists")) {
        console.error("Variant order migration failed", String(error));
      }
    }
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
  if (!response.ok) throw new Error(`WhatsApp variant reply failed: ${response.status}`);
  await saveConversation(env, phone, "out", body, null);
}

async function getSuggestions(env: BotEnv, phone: string): Promise<Product[]> {
  const row = await env.DB.prepare(`
    SELECT products_json FROM last_product_suggestions
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

async function recentOptionPrompt(env: BotEnv, phone: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT body FROM conversations
    WHERE phone = ? AND direction = 'out'
    ORDER BY id DESC LIMIT 1
  `).bind(phone).first<{ body: string }>();
  return /option|design|pasand|which product|kaunsa product|कौन-सा/i.test(String(row?.body ?? ""));
}

function optionNumber(value: string): number | null {
  const text = normalize(value);
  const exact = /^(?:option|product|design)?\s*([1-3])(?:\s*(?:order|buy|chahiye|final))?$/.exec(text);
  if (exact) return Number(exact[1]);
  const embedded = /(?:option|product|design)\s*([1-3])/.exec(text);
  return embedded ? Number(embedded[1]) : null;
}

function hasBuyIntent(value: string): boolean {
  const text = normalize(value);
  return [
    "order karna", "order place", "buy now", "book kar", "ye wala chahiye",
    "final kar", "purchase", "customise now", "customize now", "confirm order",
    "order option", "option order", "ऑर्डर करना", "ऑर्डर कर दो", "बुक कर दो", "खरीदना",
  ].some((term) => text.includes(term));
}

function ajaxPrice(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount / 100 : null;
}

async function fetchLiveProduct(env: BotEnv, product: Product): Promise<Product> {
  try {
    const url = new URL(absoluteProductUrl(env, product));
    url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\.js$/i, "")}.js`;
    url.search = "";
    const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) return product;
    const data: any = await response.json();
    const variants: Variant[] = Array.isArray(data?.variants)
      ? data.variants
          .map((variant: any) => ({
            id: String(variant?.id ?? "").replace(/\D/g, ""),
            title: String(variant?.title ?? "Default Title").trim(),
            price: ajaxPrice(variant?.price),
            available: variant?.available !== false,
          }))
          .filter((variant: Variant) => Boolean(variant.id))
      : [];
    return {
      ...product,
      title: String(data?.title ?? product.title),
      price: ajaxPrice(data?.price) ?? product.price,
      price_min: ajaxPrice(data?.price_min) ?? product.price_min,
      variants,
    };
  } catch (error) {
    console.error("Live variant fetch failed", String(error));
    return product;
  }
}

function meaningfulVariants(product: Product): Variant[] {
  return (product.variants ?? []).filter(
    (variant) => variant.id && normalize(variant.title) !== "default title",
  );
}

function isCustomProduct(product: Product): boolean {
  return /(custom|personalized|personalised|name|photo|neon|cutout|engraved)/i.test(product.title);
}

function variantLines(variants: Variant[]): string[] {
  return variants.map((variant, index) => {
    const price = variant.price === null ? "" : ` — ₹${variant.price.toFixed(2)}`;
    const status = variant.available ? " ✅" : " 📝 Manual order";
    return `${index + 1}. ${variant.title}${price}${status}`;
  });
}

async function sendAllVariants(env: BotEnv, phone: string, product: Product): Promise<void> {
  const lines = variantLines(meaningfulVariants(product));
  const chunks: string[] = [];
  let current = `*${product.title}* ke sabhi variants:\n`;
  for (const line of lines) {
    if (`${current}${line}\n`.length > 3400) {
      chunks.push(current.trim());
      current = "";
    }
    current += `${line}\n`;
  }
  if (current.trim()) chunks.push(current.trim());
  chunks[chunks.length - 1] += "\n\n✅ Available variant par direct payment link milega.\n📝 Manual order variant bhi select kar sakte hain.\n\nSirf option number bhejein.";
  for (const chunk of chunks) await sendText(env, phone, chunk);
}

async function getContext(env: BotEnv, phone: string): Promise<VariantOrderContext | null> {
  await ensureColumns(env);
  const row = await env.DB.prepare(`
    SELECT phone, step, selected_product_json, selected_variant_json,
           customization_text, quantity, customer_name, mobile_phone,
           full_address, pincode
    FROM order_flow_context
    WHERE phone = ? AND step LIKE 'vx_%'
    LIMIT 1
  `).bind(phone).first<any>();
  if (!row) return null;
  try {
    return {
      phone: String(row.phone || phone),
      step: String(row.step || ""),
      selected_product: JSON.parse(row.selected_product_json),
      selected_variant: row.selected_variant_json ? JSON.parse(row.selected_variant_json) : null,
      customization_text: String(row.customization_text || ""),
      quantity: Math.max(1, Math.min(10, Number(row.quantity || 1))),
      customer_name: String(row.customer_name || ""),
      mobile_phone: String(row.mobile_phone || ""),
      full_address: String(row.full_address || ""),
      pincode: String(row.pincode || ""),
    };
  } catch {
    await clearContext(env, phone);
    return null;
  }
}

async function saveContext(env: BotEnv, context: VariantOrderContext): Promise<void> {
  await ensureColumns(env);
  await env.DB.prepare(`
    INSERT INTO order_flow_context (
      phone, step, selected_product_json, selected_variant_json,
      customization_text, quantity, customer_name, mobile_phone,
      full_address, pincode, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      step = excluded.step,
      selected_product_json = excluded.selected_product_json,
      selected_variant_json = excluded.selected_variant_json,
      customization_text = excluded.customization_text,
      quantity = excluded.quantity,
      customer_name = excluded.customer_name,
      mobile_phone = excluded.mobile_phone,
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
    context.mobile_phone,
    context.full_address,
    context.pincode,
  ).run();
}

async function clearContext(env: BotEnv, phone: string): Promise<void> {
  await env.DB.prepare("DELETE FROM order_flow_context WHERE phone = ?").bind(phone).run();
}

function selectVariant(product: Product, value: string): Variant | null {
  const variants = meaningfulVariants(product);
  const text = normalize(value);
  const number = /^(?:option\s*)?([1-9][0-9]?)$/.exec(text);
  if (number) return variants[Number(number[1]) - 1] ?? null;
  const direct = variants.find((variant) => normalize(variant.title) === text);
  if (direct) return direct;
  return variants.find((variant) => normalize(variant.title).includes(text)) ?? null;
}

function parseMobile(value: string): string | null {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) digits = digits.slice(2);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  return /^[6-9][0-9]{9}$/.test(digits) ? digits : null;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function checkoutUrl(env: BotEnv, context: VariantOrderContext): string {
  const variant = context.selected_variant;
  if (!variant?.id) throw new Error("Variant ID missing");
  const url = new URL(`/cart/${variant.id}:${context.quantity}`, shopDomain(env));
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

function manualOrderUrl(env: BotEnv, context: VariantOrderContext): string {
  const url = new URL(absoluteProductUrl(env, context.selected_product));
  if (context.selected_variant?.id) url.searchParams.set("variant", context.selected_variant.id);
  url.searchParams.set("ref", "whatsapp-manual-order");
  return url.toString();
}

async function saveDraft(
  env: BotEnv,
  context: VariantOrderContext,
  url: string,
  status: "payment_pending" | "manual_review",
): Promise<void> {
  await ensureColumns(env);
  const unitPrice = context.selected_variant?.price ?? null;
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
    context.selected_product.title,
    absoluteProductUrl(env, context.selected_product),
    context.selected_variant?.id || "manual",
    context.selected_variant?.title || "Team confirmation",
    context.customization_text,
    context.quantity,
    unitPrice,
    totalPrice,
    context.full_address,
    context.pincode,
    url,
    status,
  ).run();
}

async function createHandoff(env: BotEnv, phone: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO human_handoffs (phone, reason, status, priority, created_at, updated_at)
    VALUES (?, 'variant_manual_order', 'open', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      reason = 'variant_manual_order', status = 'open', priority = 2,
      updated_at = CURRENT_TIMESTAMP
  `).bind(phone).run();
}

function orderSummary(context: VariantOrderContext): string {
  const custom = context.customization_text ? `\nCustomization: ${context.customization_text}` : "";
  const price = context.selected_variant?.price;
  const total = price === null || price === undefined
    ? "Team confirmation ke baad"
    : `₹${(price * context.quantity).toFixed(2)}`;
  return `✅ *Order Summary*\n\nProduct: ${context.selected_product.title}\nVariant: ${context.selected_variant?.title || "Standard"}${custom}\nQuantity: ${context.quantity}\nTotal: ${total}\n\nCustomer: ${context.customer_name}\nMobile: +91 ${context.mobile_phone}\nAddress: ${context.full_address}\nPIN: ${context.pincode}\n\nOrder sahi hai to *Confirm Order* likhein. Cancel ke liye *Cancel Order* likhein.`;
}

async function startVariantFlow(
  env: BotEnv,
  message: { id: string; phone: string; text: string },
): Promise<Response | null> {
  const suggestions = await getSuggestions(env, message.phone);
  if (suggestions.length === 0) return null;
  const option = optionNumber(message.text);
  const canUseNumber = option !== null && await recentOptionPrompt(env, message.phone);
  if (!hasBuyIntent(message.text) && !canUseNumber) return null;

  const selectedIndex = option ? option - 1 : suggestions.length === 1 ? 0 : -1;
  if (selectedIndex < 0 || !suggestions[selectedIndex]) return null;

  const product = await fetchLiveProduct(env, suggestions[selectedIndex]);
  if (meaningfulVariants(product).length === 0) return null;
  if (!(await claimMessage(env, message.id))) return new Response("EVENT_RECEIVED", { status: 200 });

  await saveConversation(env, message.phone, "in", message.text, message.id || null);
  await saveContext(env, {
    phone: message.phone,
    step: "vx_variant",
    selected_product: product,
    selected_variant: null,
    customization_text: "",
    quantity: 1,
    customer_name: "",
    mobile_phone: "",
    full_address: "",
    pincode: "",
  });
  await sendAllVariants(env, message.phone, product);
  return new Response("EVENT_RECEIVED", { status: 200 });
}

async function continueVariantFlow(
  env: BotEnv,
  context: VariantOrderContext,
  message: { id: string; phone: string; text: string },
): Promise<Response> {
  if (!(await claimMessage(env, message.id))) return new Response("EVENT_RECEIVED", { status: 200 });
  await saveConversation(env, message.phone, "in", message.text, message.id || null);
  const text = normalize(message.text);

  if (["cancel", "cancel order", "stop", "nahi chahiye", "नहीं चाहिए", "रद्द"].some((term) => text.includes(term))) {
    await clearContext(env, message.phone);
    await sendText(env, message.phone, "Order process cancel kar diya gaya hai ✅");
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  if (context.step === "vx_variant") {
    const selected = selectVariant(context.selected_product, message.text);
    if (!selected) {
      await sendAllVariants(env, message.phone, context.selected_product);
      return new Response("EVENT_RECEIVED", { status: 200 });
    }
    context.selected_variant = selected;
    context.step = isCustomProduct(context.selected_product) ? "vx_customization" : "vx_quantity";
    await saveContext(env, context);
    await sendText(
      env,
      message.phone,
      context.step === "vx_customization"
        ? `*${context.selected_product.title}* par kaunsa name/text customise karna hai? Nahi chahiye to *NA* likhein.`
        : "Quantity kitni chahiye? 1 se 10 ke beech number bhejein.",
    );
  } else if (context.step === "vx_customization") {
    const value = message.text.trim();
    if (!value || value.length > 150) {
      await sendText(env, message.phone, "Customization ka name/text bhejein, ya *NA* likhein.");
      return new Response("EVENT_RECEIVED", { status: 200 });
    }
    context.customization_text = /^(na|n\/a|no|none|नहीं)$/i.test(value) ? "" : value;
    context.step = "vx_quantity";
    await saveContext(env, context);
    await sendText(env, message.phone, "Quantity kitni chahiye? 1 se 10 ke beech number bhejein.");
  } else if (context.step === "vx_quantity") {
    const match = /(?:qty|quantity)?\s*([1-9]|10)\b/i.exec(message.text.trim());
    if (!match) {
      await sendText(env, message.phone, "Quantity kitni chahiye? 1 se 10 ke beech number bhejein.");
      return new Response("EVENT_RECEIVED", { status: 200 });
    }
    context.quantity = Number(match[1]);
    context.step = "vx_name";
    await saveContext(env, context);
    await sendText(env, message.phone, "Delivery ke liye customer ka full name bhejein.");
  } else if (context.step === "vx_name") {
    const name = message.text.trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 80) {
      await sendText(env, message.phone, "Delivery ke liye customer ka full name bhejein.");
      return new Response("EVENT_RECEIVED", { status: 200 });
    }
    context.customer_name = name;
    context.step = "vx_mobile";
    await saveContext(env, context);
    await sendText(env, message.phone, "Delivery aur order confirmation ke liye 10-digit mobile number bhejein.");
  } else if (context.step === "vx_mobile") {
    const mobile = parseMobile(message.text);
    if (!mobile) {
      await sendText(env, message.phone, "Sahi 10-digit Indian mobile number bhejein. Number 6, 7, 8 ya 9 se start ho.");
      return new Response("EVENT_RECEIVED", { status: 200 });
    }
    context.mobile_phone = mobile;
    context.step = "vx_address";
    await saveContext(env, context);
    await sendText(env, message.phone, "Pura delivery address bhejein: House/Street, Area, City aur State.");
  } else if (context.step === "vx_address") {
    const address = message.text.trim().replace(/\s+/g, " ");
    if (address.length < 12 || address.length > 300) {
      await sendText(env, message.phone, "Pura delivery address bhejein: House/Street, Area, City aur State.");
      return new Response("EVENT_RECEIVED", { status: 200 });
    }
    context.full_address = address;
    context.step = "vx_pincode";
    await saveContext(env, context);
    await sendText(env, message.phone, "6 digit delivery PIN code bhejein.");
  } else if (context.step === "vx_pincode") {
    const match = /\b([1-9][0-9]{5})\b/.exec(message.text);
    if (!match) {
      await sendText(env, message.phone, "6 digit delivery PIN code bhejein.");
      return new Response("EVENT_RECEIVED", { status: 200 });
    }
    context.pincode = match[1];
    context.step = "vx_confirm";
    await saveContext(env, context);
    await sendText(env, message.phone, orderSummary(context));
  } else if (context.step === "vx_confirm") {
    const confirmed = ["confirm", "confirm order", "yes confirm", "place order", "payment link", "pay now", "haan confirm", "हाँ कन्फर्म"]
      .some((term) => text === term || text.includes(term));
    if (!confirmed) {
      await sendText(env, message.phone, "Payment link ke liye *Confirm Order* likhein, ya *Cancel Order* likhein.");
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const direct = context.selected_variant?.available === true;
    const url = direct ? checkoutUrl(env, context) : manualOrderUrl(env, context);
    await saveDraft(env, context, url, direct ? "payment_pending" : "manual_review");
    if (!direct) await createHandoff(env, message.phone);

    await sendText(
      env,
      message.phone,
      direct
        ? `✅ *Order Details Received*\n\nProduct: ${context.selected_product.title}\nVariant: ${context.selected_variant?.title}\nQuantity: ${context.quantity}\nCustomer: ${context.customer_name}\nMobile: +91 ${context.mobile_phone}\nPIN: ${context.pincode}\n\n🔐 *Secure Payment Link:*\n${url}\n\nPayment complete hone ke baad Shopify order number milega.`
        : `✅ *Manual Variant Order Received*\n\nProduct: ${context.selected_product.title}\nVariant: ${context.selected_variant?.title}\nQuantity: ${context.quantity}\nCustomer: ${context.customer_name}\nMobile: +91 ${context.mobile_phone}\nPIN: ${context.pincode}\n\n🔐 *Order & Payment Page:*\n${url}\n\nIG Store team selected variant verify karke final secure payment link confirm karegi.`,
    );
    await clearContext(env, message.phone);
  }

  return new Response("EVENT_RECEIVED", { status: 200 });
}

async function maybeHandleVariants(request: Request, env: BotEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/webhook") return null;
  const rawBody = await request.clone().text();
  if (!(await verifyMetaSignature(rawBody, request.headers.get("X-Hub-Signature-256"), env.META_APP_SECRET))) return null;

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const message = extractMessage(payload);
  if (!message) return null;
  const context = await getContext(env, message.phone);
  if (context) return continueVariantFlow(env, context, message);
  return startVariantFlow(env, message);
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    try {
      const handled = await maybeHandleVariants(request, env as BotEnv);
      if (handled) return handled;
    } catch (error) {
      console.error("Variant wrapper failed", String(error));
    }
    return handler.fetch(request, env, ctx);
  },
  scheduled(controller: unknown, env: unknown, ctx: unknown): unknown {
    return handler.scheduled?.(controller, env, ctx);
  },
};
