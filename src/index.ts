import { Hono } from "hono";

type Language = "en" | "hi" | "both";

type Bindings = {
  DB: D1Database;
  META_VERIFY_TOKEN: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  META_GRAPH_VERSION?: string;
  SHOP_DOMAIN?: string;
  SHOPIFY_WEBHOOK_TOKEN?: string;
  ABANDONED_TEMPLATE_NAME?: string;
  ABANDONED_TEMPLATE_LANGUAGE?: string;
  ABANDONED_FALLBACK_IMAGE_URL?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  WHATSAPP_CATALOG_ID?: string;
};

type BotUser = {
  language: Language;
  isNew: boolean;
};

type ProductVariantInfo = {
  id: string | number;
  title: string;
  price: number | null;
  available: boolean;
  option1?: string;
  option2?: string;
  option3?: string;
};

type ProductSuggestion = {
  title: string;
  url: string;
  handle?: string;
  price?: string | number;
  price_min?: string | number;
  available?: boolean;
  image?: string;
  featured_image?: {
    url?: string;
    alt?: string;
  } | string;
  body?: string;
  description?: string;
  product_type?: string;
  tags?: string[] | string;
  catalogue_id?: string;
  variants?: ProductVariantInfo[];
};

type OrderFlowContext = {
  phone: string;
  step: string;
  selected_product: ProductSuggestion | null;
  selected_variant: ProductVariantInfo | null;
  customization_text: string;
  quantity: number;
  customer_name: string;
  full_address: string;
  pincode: string;
};

type ShopifyOrderRow = {
  order_id: string;
  order_number: string;
  order_name: string;
  phone: string;
  customer_name: string;
  financial_status: string;
  fulfillment_status: string;
  shipment_status: string;
  status_label: string;
  tracking_company: string;
  tracking_number: string;
  tracking_url: string;
  order_status_url: string;
  total_price: number;
  currency: string;
  line_items_summary: string;
  cancelled_at: string;
};

type RecommendationContext = {
  query: string;
  budget: number | null;
  reference_pending: number;
};

type Category = {
  query: string;
  collectionUrl: string;
  labelEn: string;
  labelHi: string;
};

type AbandonedCheckoutRow = {
  checkout_token: string;
  phone: string;
  customer_name: string;
  product_title: string;
  product_image: string | null;
  total_price: number;
  currency: string;
  recovery_url: string;
  consent: number;
  status: string;
  due_at: number;
  attempts: number;
};

type ShopifyLineItem = {
  title?: string;
  presentment_title?: string;
  quantity?: number;
  product_id?: string | number;
  image_url?: string;
  image?: string | { src?: string; url?: string };
};

const app = new Hono<{ Bindings: Bindings }>();

const DEFAULT_SHOP_DOMAIN = "https://igstore.in";
const SUPPORT_PHONE = "+91 95876 66693";
const ABANDONED_DELAY_MINUTES = 45;
const ABANDONED_MINIMUM_AMOUNT = 499;
const ABANDONED_OFFER_CODE = "COMPLETE5";
const DEFAULT_ABANDONED_TEMPLATE = "abandoned_checkout_offer";
const DEFAULT_TEMPLATE_LANGUAGE = "en_US";
const DEFAULT_FALLBACK_IMAGE =
  "https://cdn.shopify.com/s/files/1/0600/1383/8379/collections/best-sellers-collection.jpg?v=1783692206";

const CATEGORIES: Record<string, Category> = {
  "1": {
    query: "personalized gift",
    collectionUrl: "/collections/personalized-gifts",
    labelEn: "Personalized Gifts",
    labelHi: "पर्सनलाइज़्ड गिफ्ट्स",
  },
  "2": {
    query: "name plate",
    collectionUrl: "/collections/name-plate",
    labelEn: "Name Plates & Wall Decor",
    labelHi: "नेम प्लेट और वॉल डेकोर",
  },
  "3": {
    query: "neon",
    collectionUrl: "/collections/neon",
    labelEn: "Custom Neon Signs",
    labelHi: "कस्टम नियोन साइन",
  },
  "4": {
    query: "photo lamp",
    collectionUrl: "/collections/photo-frames",
    labelEn: "Photo Gifts & Lamps",
    labelHi: "फोटो गिफ्ट्स और लैम्प",
  },
  "5": {
    query: "rakhi gift",
    collectionUrl: "/collections/rakhi-2025",
    labelEn: "Rakhi Gifts & Hampers",
    labelHi: "राखी गिफ्ट्स और हैम्पर्स",
  },
  "6": {
    query: "birthday gift",
    collectionUrl: "/collections/birthday-gifts",
    labelEn: "Birthday, Anniversary & Wedding Gifts",
    labelHi: "बर्थडे, एनिवर्सरी और वेडिंग गिफ्ट्स",
  },
};

app.get("/", (c) => c.text("IG Store WhatsApp Bot is running"));

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "igstore-whatsapp-bot",
    shop: shopDomain(c.env),
  }),
);

app.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && token === c.env.META_VERIFY_TOKEN && challenge) {
    console.log("Webhook verified successfully");
    return c.text(challenge, 200);
  }

  console.warn("Webhook verification failed");
  return c.text("Forbidden", 403);
});

app.post("/webhook", async (c) => {
  let payload: unknown;

  try {
    payload = await c.req.json();
  } catch (error) {
    console.error("Invalid webhook JSON:", error);
    return c.text("Bad Request", 400);
  }

  console.log("Incoming webhook received");
  c.executionCtx.waitUntil(processWebhook(c.env, payload));
  return c.text("EVENT_RECEIVED", 200);
});

app.post("/shopify/webhook", async (c) => {
  if (!isAuthorizedShopifyWebhook(c.env, c.req.query("token"))) {
    console.warn("Rejected unauthorized Shopify webhook");
    return c.text("Forbidden", 403);
  }

  const topic = (c.req.header("X-Shopify-Topic") || "").toLowerCase();
  const webhookId = c.req.header("X-Shopify-Webhook-Id") || crypto.randomUUID();
  const rawBody = await c.req.text();

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    console.error("Invalid Shopify webhook JSON:", error);
    return c.text("Bad Request", 400);
  }

  console.log("Shopify webhook received:", topic, webhookId);
  c.executionCtx.waitUntil(
    processShopifyWebhook(c.env, topic, webhookId, payload),
  );
  return c.text("OK", 200);
});

app.get("/shopify/health", async (c) => {
  await initializeDatabase(c.env);
  const counts = await c.env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
      COALESCE(SUM(CASE WHEN status = 'recovered' THEN 1 ELSE 0 END), 0) AS recovered,
      COALESCE(SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
    FROM abandoned_checkouts
  `).first();

  return c.json({
    ok: true,
    automation: "abandoned-checkout",
    delayMinutes: ABANDONED_DELAY_MINUTES,
    minimumAmount: ABANDONED_MINIMUM_AMOUNT,
    offerCode: ABANDONED_OFFER_CODE,
    counts: counts ?? {},
  });
});

app.get("/shopify/order-health", async (c) => {
  await initializeDatabase(c.env);
  const counts = await c.env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN financial_status = 'paid' THEN 1 ELSE 0 END), 0) AS paid,
      COALESCE(SUM(CASE WHEN tracking_number != '' OR tracking_url != '' THEN 1 ELSE 0 END), 0) AS shipped,
      COALESCE(SUM(CASE WHEN shipment_status = 'delivered' THEN 1 ELSE 0 END), 0) AS delivered
    FROM shopify_orders
  `).first();

  return c.json({ ok: true, automation: "orders-and-tracking", counts: counts ?? {} });
});

app.post("/shopify/run-abandoned", async (c) => {
  if (!isAuthorizedShopifyWebhook(c.env, c.req.query("token"))) {
    return c.text("Forbidden", 403);
  }

  c.executionCtx.waitUntil(processDueAbandonedCheckouts(c.env));
  return c.json({ ok: true, started: true });
});


app.get("/admin", (c) => c.redirect("/admin/inbox", 302));

app.use("/admin/*", async (c, next) => {
  if (!c.env.ADMIN_PASSWORD?.trim()) {
    return c.html(
      "<h2>Admin inbox is not configured</h2><p>Add ADMIN_PASSWORD as an encrypted Cloudflare secret.</p>",
      503,
    );
  }

  if (!isAdminAuthorized(c.env, c.req.header("Authorization"))) {
    c.header("WWW-Authenticate", 'Basic realm="IG Store Inbox", charset="UTF-8"');
    return c.text("Login required", 401);
  }

  await next();
});

app.get("/admin/inbox", async (c) => {
  await initializeDatabase(c.env);
  return c.html(adminInboxHtml());
});

app.get("/admin/api/chats", async (c) => {
  await initializeDatabase(c.env);

  const result = await c.env.DB.prepare(`
    SELECT
      c.phone,
      COALESCE(NULLIF(ct.profile_name, ''), NULLIF((
        SELECT a.customer_name
        FROM abandoned_checkouts a
        WHERE a.phone = c.phone
        ORDER BY a.updated_at DESC
        LIMIT 1
      ), ''), c.phone) AS customer_name,
      c.body AS last_message,
      c.direction AS last_direction,
      c.created_at AS last_at,
      COALESCE(NULLIF((
        SELECT o.status_label
        FROM shopify_orders o
        WHERE substr(o.phone, -10) = substr(c.phone, -10)
        ORDER BY o.updated_at DESC
        LIMIT 1
      ), ''), NULLIF((
        SELECT d.status
        FROM whatsapp_order_drafts d
        WHERE substr(d.phone, -10) = substr(c.phone, -10)
        ORDER BY d.updated_at DESC
        LIMIT 1
      ), ''), (
        SELECT a.status
        FROM abandoned_checkouts a
        WHERE a.phone = c.phone
        ORDER BY a.updated_at DESC
        LIMIT 1
      ), '') AS checkout_status
    FROM conversations c
    INNER JOIN (
      SELECT phone, MAX(id) AS max_id
      FROM conversations
      GROUP BY phone
    ) latest ON latest.max_id = c.id
    LEFT JOIN contacts ct ON ct.phone = c.phone
    ORDER BY c.id DESC
    LIMIT 200
  `).all();

  return c.json({ ok: true, chats: result.results ?? [] });
});

app.get("/admin/api/messages", async (c) => {
  await initializeDatabase(c.env);
  const phone = String(c.req.query("phone") ?? "").replace(/\D/g, "");

  if (!/^\d{8,15}$/.test(phone)) {
    return c.json({ ok: false, error: "Invalid phone number" }, 400);
  }

  const result = await c.env.DB.prepare(`
    SELECT id, phone, direction, body, whatsapp_message_id, created_at
    FROM conversations
    WHERE phone = ?
    ORDER BY id ASC
    LIMIT 500
  `)
    .bind(phone)
    .all();

  const contact = await c.env.DB.prepare(`
    SELECT COALESCE(NULLIF(ct.profile_name, ''), NULLIF((
      SELECT a.customer_name
      FROM abandoned_checkouts a
      WHERE a.phone = ?
      ORDER BY a.updated_at DESC
      LIMIT 1
    ), ''), ?) AS customer_name
    FROM (SELECT 1) seed
    LEFT JOIN contacts ct ON ct.phone = ?
    LIMIT 1
  `)
    .bind(phone, phone, phone)
    .first<{ customer_name: string }>();

  return c.json({
    ok: true,
    phone,
    customerName: contact?.customer_name || phone,
    messages: result.results ?? [],
  });
});

app.post("/admin/api/send", async (c) => {
  await initializeDatabase(c.env);

  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid request" }, 400);
  }

  const phone = normalizeWhatsAppPhone(String(payload?.phone ?? ""));
  const body = String(payload?.body ?? "").trim();

  if (!phone) return c.json({ ok: false, error: "Invalid phone number" }, 400);
  if (!body) return c.json({ ok: false, error: "Message cannot be empty" }, 400);
  if (body.length > 4000) {
    return c.json({ ok: false, error: "Message is too long" }, 400);
  }

  try {
    await sendText(c.env, phone, body);
    await saveConversation(c.env, phone, "out", body, null);
    return c.json({ ok: true });
  } catch (error) {
    console.error("Admin reply failed:", error);
    return c.json(
      {
        ok: false,
        error:
          "WhatsApp API rejected the message. Check account restriction, token and 24-hour messaging window.",
      },
      502,
    );
  }
});

app.onError((error, c) => {
  console.error("Unhandled Worker error:", error);
  return c.json({ ok: false, error: "Internal Server Error" }, 500);
});

async function processWebhook(env: Bindings, payload: any): Promise<void> {
  try {
    const messages = extractMessages(payload);
    if (messages.length === 0) {
      console.log("Webhook contains no incoming customer messages");
      return;
    }

    await initializeDatabase(env);

    for (const message of messages) {
      await processMessage(env, message);
    }
  } catch (error) {
    console.error("Webhook processing error:", error);
  }
}

function extractMessages(payload: any): any[] {
  const messages: any[] = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const valueMessages = Array.isArray(change?.value?.messages)
        ? change.value.messages
        : [];
      const contacts = Array.isArray(change?.value?.contacts)
        ? change.value.contacts
        : [];

      for (const message of valueMessages) {
        const from = String(message?.from ?? "");
        const contact = contacts.find(
          (item: any) => String(item?.wa_id ?? "") === from,
        );
        messages.push({
          ...message,
          _profileName: String(contact?.profile?.name ?? "").trim(),
        });
      }
    }
  }

  return messages;
}

async function processMessage(env: Bindings, message: any): Promise<void> {
  const messageId = String(message?.id ?? "");
  const from = String(message?.from ?? "");

  if (!messageId || !from) {
    console.warn("Skipped webhook message without id/from");
    return;
  }

  if (!(await markMessageAsNew(env, messageId))) {
    console.log("Duplicate WhatsApp message ignored:", messageId);
    return;
  }

  const incoming = getIncomingContent(message);
  await upsertContact(env, from, String(message?._profileName ?? ""));
  const user = await getOrCreateUser(env, from);
  await saveConversation(env, from, "in", incoming.logText, messageId);

  if (incoming.kind === "unsupported") {
    await replyAndLog(env, from, unsupportedMessage(user.language));
    return;
  }

  if (incoming.kind === "media") {
    if (incoming.mediaType === "image") {
      await saveRecommendationContext(env, from, {
        query: "",
        budget: null,
        reference_pending: 1,
      });
      await replyAndLog(env, from, referenceImageReceivedMessage(user.language));
    } else {
      await replyAndLog(env, from, mediaReply(user.language));
    }
    return;
  }

  const text = incoming.text.trim();
  const normalized = normalize(text);

  const selectedLanguage = parseLanguageCommand(normalized);
  if (selectedLanguage) {
    await setUserLanguage(env, from, selectedLanguage);
    await replyAndLog(env, from, languageConfirmation(selectedLanguage));
    await replyAndLog(env, from, mainMenu(selectedLanguage));
    return;
  }

  if (user.isNew) {
    await replyAndLog(env, from, welcomeMessage(user.language));
    if (isGreeting(normalized)) return;
  }

  if (isGreeting(normalized) || isMenuCommand(normalized)) {
    await replyAndLog(env, from, mainMenu(user.language));
    return;
  }

  if (isSupportCommand(normalized) || normalized === "9") {
    await replyAndLog(env, from, supportMessage(user.language));
    return;
  }

  if (await handleTrackingFlow(env, from, user.language, text, normalized)) {
    return;
  }

  if (await handleWhatsAppOrderFlow(env, from, user.language, text, normalized)) {
    return;
  }

  const context = await getRecommendationContext(env, from);
  const budget = extractBudget(text);

  if (context?.reference_pending) {
    const referenceQuery = buildRecommendationQuery(text);
    if (hasSpecificProductRequirement(referenceQuery)) {
      const products = await searchProducts(env, referenceQuery);
      const selected = rankAndFilterProducts(products, referenceQuery, budget).slice(0, 2);

      if (selected.length > 0) {
        await replyAndLog(env, from, referenceClosestOptionsMessage(user.language));
        await sendProductCards(env, from, user.language, selected);
        await clearRecommendationContext(env, from);
      } else {
        await replyAndLog(env, from, noVerifiedProductMessage(user.language));
      }
    } else {
      await replyAndLog(env, from, referenceDetailsNeededMessage(user.language));
    }
    return;
  }

  if (context && budget !== null && isBudgetOnlyMessage(normalized)) {
    await recommendProducts(env, from, user.language, context.query || "personalized gift", budget, 3);
    await clearRecommendationContext(env, from);
    return;
  }

  if (isGiftRecommendationIntent(normalized)) {
    const recommendationQuery = buildRecommendationQuery(text) || "personalized gift";

    if (budget === null) {
      await saveRecommendationContext(env, from, {
        query: recommendationQuery,
        budget: null,
        reference_pending: 0,
      });
      await replyAndLog(env, from, askBudgetMessage(user.language));
      return;
    }

    await recommendProducts(env, from, user.language, recommendationQuery, budget, 3);
    await clearRecommendationContext(env, from);
    return;
  }

  if (normalized === "7" || isBudgetCommand(normalized)) {
    if (budget === null) {
      await saveRecommendationContext(env, from, {
        query: "personalized gift",
        budget: null,
        reference_pending: 0,
      });
      await replyAndLog(env, from, askBudgetAndOccasionMessage(user.language));
      return;
    }

    await recommendProducts(env, from, user.language, "personalized gift", budget, 3);
    return;
  }

  const category = CATEGORIES[normalized];
  if (category) {
    const products = await searchProducts(env, category.query);
    const selected = rankAndFilterProducts(products, category.query, null).slice(0, 3);
    await replyAndLog(
      env,
      from,
      categoryIntroMessage(user.language, category, shopDomain(env)),
    );

    if (selected.length > 0) {
      await sendProductCards(env, from, user.language, selected);
    } else {
      await replyAndLog(env, from, noCategoryProductsMessage(user.language));
    }
    return;
  }

  const products = await searchProducts(env, text);
  const selected = rankAndFilterProducts(products, text, budget).slice(0, 3);
  if (selected.length > 0) {
    await replyAndLog(env, from, productSearchIntro(user.language, budget));
    await sendProductCards(env, from, user.language, selected);
    return;
  }

  await replyAndLog(env, from, noProductFoundMessage(user.language, text));
}

function getIncomingContent(message: any):
  | { kind: "text"; text: string; logText: string }
  | { kind: "media"; mediaType: string; logText: string }
  | { kind: "unsupported"; logText: string } {
  if (message?.type === "text" && typeof message?.text?.body === "string") {
    return { kind: "text", text: message.text.body, logText: message.text.body };
  }

  if (message?.type === "button" && typeof message?.button?.text === "string") {
    return { kind: "text", text: message.button.text, logText: message.button.text };
  }

  const interactiveText =
    message?.interactive?.button_reply?.title ??
    message?.interactive?.list_reply?.title ??
    message?.interactive?.button_reply?.id ??
    message?.interactive?.list_reply?.id;

  if (message?.type === "interactive" && typeof interactiveText === "string") {
    return { kind: "text", text: interactiveText, logText: interactiveText };
  }

  if (["image", "video", "document", "audio", "sticker"].includes(message?.type)) {
    return {
      kind: "media",
      mediaType: String(message.type),
      logText: `[${message.type}]`,
    };
  }

  return { kind: "unsupported", logText: `[${String(message?.type ?? "unknown")}]` };
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[₹,!?।]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLanguageCommand(value: string): Language | null {
  if (["1 english", "english", "eng", "language english"].includes(value)) return "en";
  if (["2 hindi", "hindi", "हिंदी", "हिन्दी", "language hindi"].includes(value)) return "hi";
  if (["3 both", "both", "bilingual", "hindi english", "english hindi"].includes(value)) return "both";
  return null;
}

function isGreeting(value: string): boolean {
  return ["hi", "hello", "hey", "hii", "hiii", "namaste", "नमस्ते", "start"].includes(value);
}

function isMenuCommand(value: string): boolean {
  return ["menu", "main menu", "options", "home", "back"].includes(value);
}

function isSupportCommand(value: string): boolean {
  return ["support", "human", "agent", "customer care", "call me", "help"].some(
    (term) => value.includes(term),
  );
}

function isOrderCommand(value: string): boolean {
  return ["order status", "track order", "tracking", "where is my order", "mera order"].some(
    (term) => value.includes(term),
  );
}

function isBuyIntent(value: string): boolean {
  return [
    "order karna", "order place", "buy now", "book kar", "ye wala chahiye",
    "final kar", "purchase", "customise now", "customize now", "confirm order",
    "ऑर्डर करना", "ऑर्डर कर दो", "बुक कर दो", "खरीदना",
  ].some((term) => value.includes(term));
}

function isConfirmOrderIntent(value: string): boolean {
  return ["confirm", "confirm order", "yes confirm", "place order", "payment link", "pay now", "haan confirm", "हाँ कन्फर्म"].some(
    (term) => value === term || value.includes(term),
  );
}

function isCancelOrderIntent(value: string): boolean {
  return ["cancel", "cancel order", "stop", "nahi chahiye", "नहीं चाहिए", "रद्द"].some(
    (term) => value.includes(term),
  );
}

function parseProductOptionNumber(value: string): number | null {
  const exact = /^([1-3])$/.exec(value);
  if (exact) return Number(exact[1]);
  const match = /(?:option|product|design|विकल्प)\s*([1-3])/i.exec(value);
  return match ? Number(match[1]) : null;
}

function isBudgetCommand(value: string): boolean {
  return ["budget", "under", "below", "tak", "तक", "cheap gift", "gift under"].some((term) =>
    value.includes(term),
  );
}

function isGiftRecommendationIntent(value: string): boolean {
  return [
    "gift", "suggest", "recommend", "birthday", "anniversary", "wedding", "rakhi",
    "wife", "husband", "girlfriend", "boyfriend", "mother", "father", "friend",
    "भेट", "गिफ्ट", "जन्मदिन", "सालगिरह", "शादी",
  ].some((term) => value.includes(term));
}

function extractBudget(value: string): number | null {
  const normalizedValue = value.toLowerCase().replace(/,/g, "");
  const hasBudgetLanguage = /(₹|rs\.?|inr|budget|under|below|tak|तक|के अंदर|से कम)/i.test(normalizedValue);
  const standaloneNumber = /^\s*(?:₹|rs\.?|inr)?\s*(\d{2,6})\s*$/i.exec(normalizedValue);
  const contextualNumber = /(?:₹|rs\.?|inr)?\s*(\d{2,6})(?:\s*(?:tak|तक|under|below|budget|के अंदर|से कम))?/i.exec(normalizedValue);
  const match = standaloneNumber ?? (hasBudgetLanguage ? contextualNumber : null);
  if (!match) return null;

  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount >= 50 && amount <= 500000 ? amount : null;
}

function isBudgetOnlyMessage(value: string): boolean {
  return /^(?:rs\.?\s*)?\d{2,6}(?:\s*(?:tak|under|budget|तक))?$/.test(value);
}

function buildRecommendationQuery(value: string): string {
  return value
    .replace(/₹\s*\d[\d,]*/gi, " ")
    .replace(/\b(?:rs\.?|inr)\s*\d[\d,]*/gi, " ")
    .replace(/\b\d[\d,]*\s*(?:tak|under|below|budget)\b/gi, " ")
    .replace(/\b(?:please|chahiye|dikhao|dikhaye|suggest|recommend|best|option|options)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function hasSpecificProductRequirement(value: string): boolean {
  const normalizedValue = normalize(value);
  return [
    "name", "cutout", "frame", "keychain", "plate", "neon", "lamp", "photo",
    "wooden", "acrylic", "black", "gold", "silver", "rakhi", "hamper",
    "नेम", "फ्रेम", "कीचेन", "लकड़ी", "ब्लैक", "गोल्ड",
  ].some((term) => normalizedValue.includes(term));
}

async function recommendProducts(
  env: Bindings,
  phone: string,
  language: Language,
  query: string,
  budget: number | null,
  maximum: number,
): Promise<void> {
  const products = await searchProducts(env, query);
  const selected = rankAndFilterProducts(products, query, budget).slice(0, Math.min(3, maximum));

  if (selected.length === 0) {
    await replyAndLog(env, phone, noVerifiedRecommendationMessage(language, budget));
    return;
  }

  await replyAndLog(env, phone, recommendationIntroMessage(language, budget, selected.length));
  await sendProductCards(env, phone, language, selected);
}

async function searchProducts(env: Bindings, query: string): Promise<ProductSuggestion[]> {
  const cleanedQuery = query.trim().slice(0, 120);
  if (!cleanedQuery) return [];

  const url = new URL(`${shopDomain(env)}/search/suggest.json`);
  url.searchParams.set("q", cleanedQuery);
  url.searchParams.set("resources[type]", "product");
  url.searchParams.set("resources[limit]", "10");
  url.searchParams.set("resources[limit_scope]", "each");
  url.searchParams.set("resources[options][unavailable_products]", "hide");
  url.searchParams.set(
    "resources[options][fields]",
    "title,body,product_type,tag,variants.title,vendor",
  );

  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      console.error("Shopify search failed:", response.status, await response.text());
      return [];
    }

    const data: any = await response.json();
    const products: ProductSuggestion[] = Array.isArray(data?.resources?.results?.products)
      ? data.resources.results.products
      : [];

    return await attachCatalogueIds(env, products.slice(0, 10));
  } catch (error) {
    console.error("Shopify product search error:", error);
    return [];
  }
}

async function attachCatalogueIds(
  env: Bindings,
  products: ProductSuggestion[],
): Promise<ProductSuggestion[]> {
  const enriched: ProductSuggestion[] = [];

  for (const product of products) {
    let detailed: ProductSuggestion = { ...product };

    try {
      detailed = await fetchVerifiedProductDetails(env, product);
    } catch (error) {
      console.error("Product detail enrichment failed:", product.url, error);
    }

    try {
      const productUrl = absoluteUrl(shopDomain(env), detailed.url);
      const row = await env.DB.prepare(
        "SELECT catalogue_id FROM product_catalogue_map WHERE product_url = ? LIMIT 1",
      )
        .bind(productUrl)
        .first<{ catalogue_id: string }>();
      enriched.push({ ...detailed, catalogue_id: row?.catalogue_id || undefined });
    } catch {
      enriched.push(detailed);
    }
  }

  return enriched;
}

async function fetchVerifiedProductDetails(
  env: Bindings,
  product: ProductSuggestion,
): Promise<ProductSuggestion> {
  const productUrl = new URL(absoluteUrl(shopDomain(env), product.url));
  productUrl.pathname = `${productUrl.pathname.replace(/\/$/, "").replace(/\.js$/i, "")}.js`;
  productUrl.search = "";

  const response = await fetch(productUrl.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return product;

  const data: any = await response.json();
  const variants: ProductVariantInfo[] = Array.isArray(data?.variants)
    ? data.variants
        .map((variant: any) => ({
          id: variant?.id,
          title: String(variant?.title ?? "Default Title"),
          price: ajaxMoneyToRupees(variant?.price),
          available: variant?.available !== false,
          option1: variant?.option1 ? String(variant.option1) : undefined,
          option2: variant?.option2 ? String(variant.option2) : undefined,
          option3: variant?.option3 ? String(variant.option3) : undefined,
        }))
        .filter((variant: ProductVariantInfo) => Boolean(variant.id))
    : [];

  const featuredImage = normalizePublicImageUrl(
    typeof data?.featured_image === "string"
      ? data.featured_image
      : data?.featured_image?.src ?? data?.featured_image?.url,
  );

  return {
    ...product,
    title: String(data?.title ?? product.title),
    handle: String(data?.handle ?? product.handle ?? ""),
    available: data?.available !== false,
    price: ajaxMoneyToRupees(data?.price) ?? product.price,
    price_min: ajaxMoneyToRupees(data?.price_min) ?? product.price_min,
    featured_image: featuredImage || product.featured_image,
    description: typeof data?.description === "string" ? data.description : product.description,
    variants,
  };
}

function ajaxMoneyToRupees(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return amount / 100;
}

function normalizePublicImageUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("//")) return `https:${raw}`;
  return /^https:\/\//i.test(raw) ? raw : null;
}

function rankAndFilterProducts(
  products: ProductSuggestion[],
  request: string,
  budget: number | null,
): ProductSuggestion[] {
  const normalizedRequest = normalize(request);
  const requestTokens = normalizedRequest
    .split(" ")
    .filter((token) => token.length >= 3 && !["gift", "chahiye", "best", "show"].includes(token));
  const seen = new Set<string>();

  return products
    .filter((product) => {
      if (!product?.title?.trim() || !product?.url?.trim()) return false;
      if (product.available === false) return false;

      const key = product.url.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);

      if (budget !== null) {
        const price = numericProductPrice(product);
        if (price === null || price > budget) return false;
      }

      return true;
    })
    .map((product) => {
      const title = normalize(product.title);
      let score = 0;
      if (title.includes(normalizedRequest) || normalizedRequest.includes(title)) score += 100;
      for (const token of requestTokens) {
        if (title.includes(token)) score += 15;
      }
      if (productImageUrl(product)) score += 10;
      if (numericProductPrice(product) !== null) score += 5;
      return { product, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.product);
}

function productSearchIntro(language: Language, budget: number | null): string {
  if (budget !== null) return recommendationIntroMessage(language, budget, 3);
  if (language === "hi") return "आपकी requirement के अनुसार ये verified products मिले 👇";
  if (language === "en") return "These verified products match your requirement 👇";
  return "Aapki requirement ke according ye verified products mile 👇";
}

function categoryIntroMessage(
  language: Language,
  category: Category,
  domain: string,
): string {
  const heading =
    language === "en"
      ? `*${category.labelEn}*`
      : language === "hi"
        ? `*${category.labelHi}*`
        : `*${category.labelEn} / ${category.labelHi}*`;

  return `${heading}\nVerified available options 👇`;
}

function noCategoryProductsMessage(language: Language): string {
  if (language === "hi") return "इस category में verified available product अभी नहीं मिला। Team से confirm करने के लिए *Support* लिखें।";
  if (language === "en") return "No verified available product was found in this category. Reply *Support* for confirmation.";
  return "Is category mein verified available product abhi nahi mila. Team confirmation ke liye *Support* likhein.";
}

async function sendProductCards(
  env: Bindings,
  phone: string,
  language: Language,
  products: ProductSuggestion[],
): Promise<void> {
  const safeProducts = products.slice(0, 3);
  await saveLastProductSuggestions(env, phone, safeProducts);

  for (let index = 0; index < safeProducts.length; index += 1) {
    const product = safeProducts[index];
    const caption = productCaption(language, product, shopDomain(env), index + 1);
    const imageUrl = productImageUrl(product);

    if (env.WHATSAPP_CATALOG_ID?.trim() && product.catalogue_id?.trim()) {
      try {
        await sendCatalogueProduct(env, phone, product.catalogue_id, caption);
        await saveConversation(
          env,
          phone,
          "out",
          `[catalogue:${product.catalogue_id}] ${caption}`,
          null,
        );
        continue;
      } catch (error) {
        console.error("Catalogue product send failed; falling back to image:", error);
      }
    }

    if (imageUrl) {
      try {
        await sendImage(env, phone, imageUrl, caption);
        await saveConversation(env, phone, "out", `[image:${imageUrl}] ${caption}`, null);
        continue;
      } catch (error) {
        console.error("Product image send failed; falling back to text:", error);
      }
    }

    await replyAndLog(env, phone, caption);
  }

  await replyAndLog(
    env,
    phone,
    productCardsFooter(language, safeProducts.length, safeProducts.some(isCustomProduct)),
  );
}

function productCaption(
  language: Language,
  product: ProductSuggestion,
  domain: string,
  optionNumber: number,
): string {
  const price = formatPrice(product.price_min ?? product.price);
  const url = absoluteUrl(domain, product.url);
  const description = verifiedShortDescription(product);

  if (language === "hi") {
    return `${optionNumber}. *${product.title}*\n${price ? `शुरुआती कीमत: ${price}\n` : ""}${description ? `${description}\n` : ""}🛒 ऑर्डर/जानकारी: ${url}`;
  }

  if (language === "en") {
    return `${optionNumber}. *${product.title}*\n${price ? `Starting price: ${price}\n` : ""}${description ? `${description}\n` : ""}🛒 Order/Details: ${url}`;
  }

  return `${optionNumber}. *${product.title}*\n${price ? `Starting Price: ${price}\n` : ""}${description ? `${description}\n` : ""}🛒 Order/Details: ${url}`;
}

function verifiedShortDescription(product: ProductSuggestion): string {
  const raw = typeof product.body === "string"
    ? product.body
    : typeof product.description === "string"
      ? product.description
      : "";

  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function productImageUrl(product: ProductSuggestion): string | null {
  const featured = product.featured_image;
  const url =
    typeof featured === "string"
      ? featured
      : featured?.url ?? product.image;

  return normalizePublicImageUrl(url);
}

function productCardsFooter(
  language: Language,
  productCount: number,
  hasCustomProduct: boolean,
): string {
  const variationNote = hasCustomProduct
    ? "\nCustom product handmade/personalized hone ke karan minor variation possible hai."
    : "";

  if (language === "hi") {
    const question = productCount === 1
      ? "आपको यह design पसंद है? Size और customization बता दें 😊"
      : `इनमें से कौन-सा option पसंद आया—${Array.from({ length: productCount }, (_, i) => i + 1).join(", ")}?`;
    return `${question}${variationNote}`;
  }

  if (language === "en") {
    const question = productCount === 1
      ? "Do you like this design? Please share the size and customization 😊"
      : `Which option do you like—${Array.from({ length: productCount }, (_, i) => i + 1).join(", ")}?`;
    return `${question}${variationNote}`;
  }

  const question = productCount === 1
    ? "Aapko ye design pasand hai? Size aur customization bata dein 😊"
    : `Inmein se kaunsa option pasand aaya—${Array.from({ length: productCount }, (_, i) => i + 1).join(", ")}?`;
  return `${question}${variationNote}`;
}

function numericProductPrice(product: ProductSuggestion): number | null {
  const value = Number(product.price_min ?? product.price);
  return Number.isFinite(value) ? value : null;
}

function formatPrice(value: unknown): string | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return `₹${Number.isInteger(number) ? number.toFixed(0) : number.toFixed(2)}`;
}

function isCustomProduct(product: ProductSuggestion): boolean {
  return /(custom|personalized|personalised|name|photo|neon|cutout)/i.test(product.title);
}

function recommendationIntroMessage(
  language: Language,
  budget: number | null,
  count: number,
): string {
  if (language === "hi") {
    return budget !== null
      ? `₹${budget} के budget में ये ${count} verified options best हैं 👇`
      : `ये ${count} verified options best हैं 👇`;
  }
  if (language === "en") {
    return budget !== null
      ? `These ${count} verified options are within your ₹${budget} budget 👇`
      : `These ${count} verified options are the best match 👇`;
  }
  return budget !== null
    ? `₹${budget} ke budget mein ye ${count} verified options best hain 👇`
    : `Ye ${count} verified options best match hain 👇`;
}

function askBudgetMessage(language: Language): string {
  if (language === "hi") return "बिल्कुल 😊 आपका approximate budget कितना है?";
  if (language === "en") return "Sure 😊 What is your approximate budget?";
  return "Bilkul 😊 Aapka approximate budget kitna hai?";
}

function askBudgetAndOccasionMessage(language: Language): string {
  if (language === "hi") return "अपना budget और occasion बताएं, जैसे: ‘Anniversary gift ₹1000 तक’।";
  if (language === "en") return "Please share the budget and occasion, for example: ‘Anniversary gift under ₹1000’.";
  return "Apna budget aur occasion batayein, jaise: ‘Anniversary gift ₹1000 tak’.";
}

function noVerifiedRecommendationMessage(language: Language, budget: number | null): string {
  const budgetText = budget !== null ? ` ₹${budget}` : "";
  if (language === "hi") return `${budgetText} budget में verified image, price और availability वाला matching product नहीं मिला। गलत product दिखाने के बजाय team से confirm करने के लिए *Support* लिखें।`;
  if (language === "en") return `No matching product with verified image, price and availability was found for the${budgetText} budget. Reply *Support* for team confirmation.`;
  return `${budgetText} budget mein verified image, price aur availability wala matching product nahi mila. Team confirmation ke liye *Support* likhein.`;
}

function noVerifiedProductMessage(language: Language): string {
  if (language === "hi") return "इस requirement के लिए verified matching product image अभी नहीं मिली। गलत image दिखाने के बजाय product type, colour और budget बताएं।";
  if (language === "en") return "A verified matching product image is not available yet. Please share the product type, colour and budget.";
  return "Is requirement ke liye verified matching product image abhi nahi mili. Product type, colour aur budget batayein.";
}

function referenceImageReceivedMessage(language: Language): string {
  if (language === "hi") return "Reference image मिल गई ✅ आपको same design चाहिए या इसमें changes करने हैं? Product type, colour और budget भी बता दें।";
  if (language === "en") return "Reference image received ✅ Do you need the same design or any changes? Please also share the product type, colour and budget.";
  return "Reference image mil gayi ✅ Aapko same design chahiye ya isme changes karne hain? Product type, colour aur budget bhi bata dein.";
}

function referenceDetailsNeededMessage(language: Language): string {
  if (language === "hi") return "सबसे close IG Store options दिखाने के लिए product type, colour और approximate budget बताएं।";
  if (language === "en") return "Please share the product type, colour and approximate budget so I can show the closest IG Store options.";
  return "Sabse close IG Store options dikhane ke liye product type, colour aur approximate budget batayein.";
}

function referenceClosestOptionsMessage(language: Language): string {
  if (language === "hi") return "आपकी reference requirement के सबसे close verified IG Store options ये हैं 👇";
  if (language === "en") return "These are the closest verified IG Store options for your reference requirement 👇";
  return "Aapki reference requirement ke sabse close verified IG Store options ye hain 👇";
}

function absoluteUrl(domain: string, path: string): string {
  try {
    return new URL(path, `${domain}/`).toString();
  } catch {
    return domain;
  }
}

function shopDomain(env: Pick<Bindings, "SHOP_DOMAIN">): string {
  const raw = env.SHOP_DOMAIN?.trim() || DEFAULT_SHOP_DOMAIN;
  return raw.replace(/\/$/, "");
}

function welcomeMessage(language: Language): string {
  if (language === "en") {
    return `Welcome to *IG Store* 🎁\nPersonalized gifts, custom name plates, neon signs and home decor.\n\nChoose language anytime:\n*English* | *हिंदी* | *Both*\n\n${mainMenu("en")}`;
  }

  if (language === "hi") {
    return `*IG Store* में आपका स्वागत है 🎁\nपर्सनलाइज़्ड गिफ्ट्स, कस्टम नेम प्लेट, नियोन साइन और होम डेकोर।\n\nभाषा बदलने के लिए लिखें:\n*English* | *हिंदी* | *Both*\n\n${mainMenu("hi")}`;
  }

  return `Welcome to *IG Store* 🎁\n*IG Store* में आपका स्वागत है।\n\nChoose language / भाषा चुनें:\n*English* | *हिंदी* | *Both*\n\n${mainMenu("both")}`;
}

function mainMenu(language: Language): string {
  if (language === "en") {
    return `*Main Menu*\n1. Personalized Gifts\n2. Name Plates & Wall Decor\n3. Custom Neon Signs\n4. Photo Gifts & Lamps\n5. Rakhi Gifts & Hampers\n6. Birthday, Anniversary & Wedding Gifts\n7. Gifts by Budget\n8. Order Status\n9. Customer Support\n\nReply with a number or type a product name, for example: *Wooden Name Plate*.`;
  }

  if (language === "hi") {
    return `*मुख्य मेनू*\n1. पर्सनलाइज़्ड गिफ्ट्स\n2. नेम प्लेट और वॉल डेकोर\n3. कस्टम नियोन साइन\n4. फोटो गिफ्ट्स और लैम्प\n5. राखी गिफ्ट्स और हैम्पर्स\n6. बर्थडे, एनिवर्सरी और वेडिंग गिफ्ट्स\n7. बजट के अनुसार गिफ्ट्स\n8. ऑर्डर स्टेटस\n9. कस्टमर सपोर्ट\n\nनंबर या प्रोडक्ट का नाम लिखें, जैसे: *Wooden Name Plate*।`;
  }

  return `*Main Menu / मुख्य मेनू*\n1. Personalized Gifts / पर्सनलाइज़्ड गिफ्ट्स\n2. Name Plates & Wall Decor / नेम प्लेट और वॉल डेकोर\n3. Custom Neon Signs / कस्टम नियोन साइन\n4. Photo Gifts & Lamps / फोटो गिफ्ट्स और लैम्प\n5. Rakhi Gifts & Hampers / राखी गिफ्ट्स और हैम्पर्स\n6. Birthday, Anniversary & Wedding Gifts\n7. Gifts by Budget / बजट के अनुसार गिफ्ट्स\n8. Order Status / ऑर्डर स्टेटस\n9. Customer Support / कस्टमर सपोर्ट\n\nReply with a number or product name.\nनंबर या प्रोडक्ट का नाम लिखें।`;
}

function languageConfirmation(language: Language): string {
  if (language === "en") return "Language changed to English ✅";
  if (language === "hi") return "भाषा हिंदी में बदल दी गई है ✅";
  return "Language set to English + Hindi / भाषा English + हिंदी कर दी गई है ✅";
}

function supportMessage(language: Language): string {
  if (language === "en") {
    return `Our support team will help you.\n\nCall/WhatsApp: ${SUPPORT_PHONE}\nSupport hours: 10:00 AM–7:00 PM\n\nPlease send your name, product requirement and order number (if available).`;
  }

  if (language === "hi") {
    return `हमारी सपोर्ट टीम आपकी सहायता करेगी।\n\nCall/WhatsApp: ${SUPPORT_PHONE}\nसमय: सुबह 10:00 से शाम 7:00 बजे तक\n\nअपना नाम, प्रोडक्ट की जरूरत और ऑर्डर नंबर (यदि उपलब्ध हो) भेजें।`;
  }

  return `Our support team will help you. / हमारी सपोर्ट टीम आपकी सहायता करेगी।\n\nCall/WhatsApp: ${SUPPORT_PHONE}\nTiming: 10:00 AM–7:00 PM\n\nSend your name, product requirement and order number.\nअपना नाम, प्रोडक्ट की जरूरत और ऑर्डर नंबर भेजें।`;
}

function orderStatusMessage(language: Language): string {
  if (language === "en") {
    return "Please send your *order number* (example: #1234). I will check it using this WhatsApp number.";
  }

  if (language === "hi") {
    return "कृपया अपना *ऑर्डर नंबर* भेजें, जैसे #1234। इसी WhatsApp नंबर से स्टेटस चेक किया जाएगा।";
  }

  return "Apna *order number* bhejein, jaise #1234. Isi WhatsApp number se status check hoga.";
}

function budgetMessage(language: Language, domain: string): string {
  const links = `Under ₹99: ${domain}/collections/under-99-gifts\nUnder ₹599: ${domain}/collections/under-599-gifts\nUnder ₹999: ${domain}/collections/under-999-gifts`;

  if (language === "en") return `Choose gifts by budget 🎁\n\n${links}`;
  if (language === "hi") return `बजट के अनुसार गिफ्ट चुनें 🎁\n\n${links}`;
  return `Choose gifts by budget / बजट के अनुसार गिफ्ट चुनें 🎁\n\n${links}`;
}

function mediaReply(language: Language): string {
  if (language === "en") {
    return "Thank you for the photo/reference. Please also type the product name, required size, custom name/text and delivery pincode.";
  }

  if (language === "hi") {
    return "फोटो/रेफरेंस भेजने के लिए धन्यवाद। कृपया प्रोडक्ट का नाम, साइज, कस्टम नाम/टेक्स्ट और डिलीवरी पिनकोड भी लिखें।";
  }

  return "Thank you for the photo/reference.\nफोटो/रेफरेंस भेजने के लिए धन्यवाद।\n\nPlease type product name, size, custom text and delivery pincode.\nप्रोडक्ट नाम, साइज, कस्टम टेक्स्ट और पिनकोड लिखें।";
}

function unsupportedMessage(language: Language): string {
  if (language === "en") return "Please send a text message or type *Menu* to see options.";
  if (language === "hi") return "कृपया टेक्स्ट मैसेज भेजें या विकल्प देखने के लिए *Menu* लिखें।";
  return "Please send text or type *Menu*. / कृपया टेक्स्ट भेजें या *Menu* लिखें।";
}

function noProductFoundMessage(language: Language, query: string): string {
  const safeQuery = query.slice(0, 80);
  if (language === "en") {
    return `I could not find an exact product for “${safeQuery}”. Please try a shorter product name or reply *9* for customer support.`;
  }

  if (language === "hi") {
    return `“${safeQuery}” के लिए सही प्रोडक्ट नहीं मिला। छोटा प्रोडक्ट नाम लिखें या कस्टमर सपोर्ट के लिए *9* भेजें।`;
  }

  return `No exact product found for “${safeQuery}”.\n“${safeQuery}” के लिए सही प्रोडक्ट नहीं मिला।\n\nTry a shorter product name or reply *9* for support.`;
}

function isAuthorizedShopifyWebhook(
  env: Bindings,
  suppliedToken: string | undefined,
): boolean {
  const expected = env.SHOPIFY_WEBHOOK_TOKEN?.trim();
  return Boolean(expected && suppliedToken && timingSafeEqual(expected, suppliedToken));
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < aBytes.length; index += 1) {
    difference |= aBytes[index] ^ bBytes[index];
  }
  return difference === 0;
}

async function processShopifyWebhook(
  env: Bindings,
  topic: string,
  webhookId: string,
  payload: any,
): Promise<void> {
  try {
    await initializeDatabase(env);

    if (!(await markShopifyWebhookAsNew(env, webhookId))) {
      console.log("Duplicate Shopify webhook ignored:", webhookId);
      return;
    }

    if (topic === "checkouts/create" || topic === "checkouts/update") {
      await upsertAbandonedCheckout(env, payload);
      return;
    }

    if (
      topic === "orders/create" ||
      topic === "orders/paid" ||
      topic === "orders/updated"
    ) {
      await upsertShopifyOrder(env, payload);
      await markCheckoutRecovered(env, String(payload?.checkout_token ?? ""));
      await notifyOrderUpdateInsideCustomerWindow(env, topic, payload);
      return;
    }

    if (topic === "fulfillments/create" || topic === "fulfillments/update") {
      await updateShopifyOrderFromFulfillment(env, payload);
      await notifyFulfillmentUpdateInsideCustomerWindow(env, payload);
      return;
    }

    console.log("Shopify topic ignored:", topic);
  } catch (error) {
    console.error("Shopify webhook processing failed:", error);
  }
}

async function markShopifyWebhookAsNew(
  env: Bindings,
  webhookId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_shopify_webhooks (webhook_id) VALUES (?)",
  )
    .bind(webhookId)
    .run();

  return Number(result.meta?.changes ?? 0) > 0;
}

async function upsertAbandonedCheckout(env: Bindings, payload: any): Promise<void> {
  const checkoutToken = String(payload?.token ?? "").trim();
  if (!checkoutToken) {
    console.warn("Checkout webhook skipped because token is missing");
    return;
  }

  if (payload?.completed_at) {
    await markCheckoutRecovered(env, checkoutToken);
    return;
  }

  const lineItems: ShopifyLineItem[] = Array.isArray(payload?.line_items)
    ? payload.line_items
    : [];
  if (lineItems.length === 0) {
    console.log("Checkout skipped because cart has no line items:", checkoutToken);
    return;
  }

  const totalPrice = Number(payload?.total_price ?? payload?.subtotal_price ?? 0);
  const recoveryUrl = String(payload?.abandoned_checkout_url ?? "").trim();
  const phone = checkoutPhone(payload);
  const consent = hasWhatsAppMarketingConsent(payload);
  const customerName = checkoutCustomerName(payload);
  const productTitle = checkoutProductTitle(lineItems);
  const productImage =
    directLineItemImage(lineItems[0]) ??
    (await findProductImage(
      env,
      lineItems[0]?.title ?? lineItems[0]?.presentment_title ?? "",
    ));
  const now = Date.now();
  const dueAt = now + ABANDONED_DELAY_MINUTES * 60_000;

  const alreadyRecovered = await env.DB.prepare(
    "SELECT checkout_token FROM recovered_checkout_tokens WHERE checkout_token = ? LIMIT 1",
  )
    .bind(checkoutToken)
    .first();
  if (alreadyRecovered) return;

  const existing = await env.DB.prepare(
    "SELECT status FROM abandoned_checkouts WHERE checkout_token = ? LIMIT 1",
  )
    .bind(checkoutToken)
    .first<{ status: string }>();

  if (existing?.status === "sent" || existing?.status === "recovered") {
    return;
  }

  let status = "pending";
  let skipReason: string | null = null;

  if (!phone) {
    status = "skipped";
    skipReason = "phone_missing";
  } else if (!consent) {
    status = "skipped";
    skipReason = "whatsapp_marketing_opt_in_missing";
  } else if (!recoveryUrl) {
    status = "skipped";
    skipReason = "recovery_url_missing";
  } else if (!Number.isFinite(totalPrice) || totalPrice < ABANDONED_MINIMUM_AMOUNT) {
    status = "skipped";
    skipReason = "below_minimum_amount";
  }

  await env.DB.prepare(`
    INSERT INTO abandoned_checkouts (
      checkout_token, phone, customer_name, product_title, product_image,
      total_price, currency, recovery_url, consent, status, skip_reason,
      due_at, attempts, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(checkout_token) DO UPDATE SET
      phone = excluded.phone,
      customer_name = excluded.customer_name,
      product_title = excluded.product_title,
      product_image = excluded.product_image,
      total_price = excluded.total_price,
      currency = excluded.currency,
      recovery_url = excluded.recovery_url,
      consent = excluded.consent,
      status = excluded.status,
      skip_reason = excluded.skip_reason,
      due_at = excluded.due_at,
      updated_at = excluded.updated_at
  `)
    .bind(
      checkoutToken,
      phone ?? "",
      customerName,
      productTitle,
      productImage,
      totalPrice,
      String(payload?.currency ?? "INR"),
      recoveryUrl,
      consent ? 1 : 0,
      status,
      skipReason,
      dueAt,
      now,
      now,
    )
    .run();

  console.log("Checkout stored:", checkoutToken, status, skipReason ?? "");
}

function checkoutPhone(payload: any): string | null {
  const candidates = [
    payload?.sms_marketing_phone,
    payload?.phone,
    payload?.shipping_address?.phone,
    payload?.billing_address?.phone,
    payload?.customer?.phone,
  ];

  for (const value of candidates) {
    const normalized = normalizeWhatsAppPhone(String(value ?? ""));
    if (normalized) return normalized;
  }

  return null;
}

function normalizeWhatsAppPhone(value: string): string | null {
  let digits = value.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) {
    digits = `91${digits.slice(1)}`;
  }

  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

function hasWhatsAppMarketingConsent(payload: any): boolean {
  if (payload?.buyer_accepts_sms_marketing === true) return true;

  const attributes = Array.isArray(payload?.note_attributes)
    ? payload.note_attributes
    : [];

  return attributes.some((attribute: any) => {
    const name = normalize(String(attribute?.name ?? ""));
    const value = normalize(String(attribute?.value ?? ""));
    const consentField =
      name === "whatsapp opt in" ||
      name === "whatsapp_opt_in" ||
      name === "whatsapp marketing consent";

    return consentField && ["yes", "true", "1", "accepted"].includes(value);
  });
}

function checkoutCustomerName(payload: any): string {
  const name =
    payload?.customer?.first_name ??
    payload?.shipping_address?.first_name ??
    payload?.billing_address?.first_name ??
    "there";

  return String(name).trim().slice(0, 80) || "there";
}

function checkoutProductTitle(lineItems: ShopifyLineItem[]): string {
  const first =
    lineItems[0]?.title ??
    lineItems[0]?.presentment_title ??
    "your selected product";
  const more = lineItems.length - 1;
  return more > 0 ? `${String(first)} + ${more} more` : String(first);
}

function directLineItemImage(item: ShopifyLineItem | undefined): string | null {
  if (!item) return null;

  const image =
    item.image_url ??
    (typeof item.image === "string"
      ? item.image
      : item.image?.url ?? item.image?.src);

  return image && /^https:\/\//i.test(image) ? image : null;
}

async function findProductImage(env: Bindings, title: string): Promise<string | null> {
  if (!title.trim()) return null;
  const products = await searchProducts(env, title);
  return products.length > 0 ? productImageUrl(products[0]) : null;
}

async function markCheckoutRecovered(
  env: Bindings,
  checkoutToken: string,
): Promise<void> {
  if (!checkoutToken) return;

  const now = Date.now();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO recovered_checkout_tokens (checkout_token, recovered_at)
    VALUES (?, ?)
  `)
    .bind(checkoutToken, now)
    .run();

  await env.DB.prepare(`
    UPDATE abandoned_checkouts
    SET status = 'recovered', recovered_at = ?, updated_at = ?
    WHERE checkout_token = ? AND status != 'sent'
  `)
    .bind(now, now, checkoutToken)
    .run();

  console.log("Checkout marked recovered:", checkoutToken);
}

async function processDueAbandonedCheckouts(env: Bindings): Promise<void> {
  await initializeDatabase(env);

  const now = Date.now();
  const result = await env.DB.prepare(`
    SELECT
      checkout_token, phone, customer_name, product_title, product_image,
      total_price, currency, recovery_url, consent, status, due_at, attempts
    FROM abandoned_checkouts
    WHERE status = 'pending' AND due_at <= ?
    ORDER BY due_at ASC
    LIMIT 25
  `)
    .bind(now)
    .all<AbandonedCheckoutRow>();

  for (const checkout of result.results ?? []) {
    try {
      await sendAbandonedCheckoutTemplate(env, checkout);
      await env.DB.prepare(`
        UPDATE abandoned_checkouts
        SET status = 'sent', sent_at = ?, updated_at = ?, last_error = NULL
        WHERE checkout_token = ? AND status = 'pending'
      `)
        .bind(Date.now(), Date.now(), checkout.checkout_token)
        .run();

      await saveConversation(
        env,
        checkout.phone,
        "out",
        `[image:${checkout.product_image || env.ABANDONED_FALLBACK_IMAGE_URL?.trim() || DEFAULT_FALLBACK_IMAGE}] Abandoned checkout offer sent\nProduct: ${checkout.product_title}\nCart: ${formatCheckoutAmount(checkout.total_price, checkout.currency)}\nOffer: 5% OFF above ₹499 with ${ABANDONED_OFFER_CODE}\nComplete order: ${checkout.recovery_url}`,
        null,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextAttempts = Number(checkout.attempts ?? 0) + 1;
      const nextStatus = nextAttempts >= 3 ? "failed" : "pending";
      const nextDueAt = Date.now() + 30 * 60_000;

      await env.DB.prepare(`
        UPDATE abandoned_checkouts
        SET status = ?, attempts = ?, due_at = ?, last_error = ?, updated_at = ?
        WHERE checkout_token = ?
      `)
        .bind(
          nextStatus,
          nextAttempts,
          nextDueAt,
          message.slice(0, 1000),
          Date.now(),
          checkout.checkout_token,
        )
        .run();

      console.error("Abandoned checkout send failed:", checkout.checkout_token, message);
    }
  }
}

async function sendAbandonedCheckoutTemplate(
  env: Bindings,
  checkout: AbandonedCheckoutRow,
): Promise<void> {
  if (!checkout.phone || !checkout.recovery_url || checkout.consent !== 1) {
    throw new Error("Checkout is missing phone, recovery URL or consent");
  }

  const graphVersion = env.META_GRAPH_VERSION?.trim() || "v25.0";
  const endpoint = `https://graph.facebook.com/${graphVersion}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const imageUrl =
    checkout.product_image ||
    env.ABANDONED_FALLBACK_IMAGE_URL?.trim() ||
    DEFAULT_FALLBACK_IMAGE;
  const total = formatCheckoutAmount(checkout.total_price, checkout.currency);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: checkout.phone,
      type: "template",
      template: {
        name: env.ABANDONED_TEMPLATE_NAME?.trim() || DEFAULT_ABANDONED_TEMPLATE,
        language: {
          code:
            env.ABANDONED_TEMPLATE_LANGUAGE?.trim() ||
            DEFAULT_TEMPLATE_LANGUAGE,
        },
        components: [
          {
            type: "header",
            parameters: [
              {
                type: "image",
                image: { link: imageUrl },
              },
            ],
          },
          {
            type: "body",
            parameters: [
              { type: "text", text: checkout.customer_name.slice(0, 80) },
              { type: "text", text: checkout.product_title.slice(0, 160) },
              { type: "text", text: total },
              { type: "text", text: checkout.recovery_url.slice(0, 1900) },
            ],
          },
        ],
      },
    }),
  });

  const responseBody = await response.text();
  console.log(`Abandoned template status: ${response.status}`, responseBody);

  if (!response.ok) {
    throw new Error(
      `WhatsApp template failed (${response.status}): ${responseBody.slice(0, 500)}`,
    );
  }
}

function formatCheckoutAmount(amount: number, currency: string): string {
  const safeAmount = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  if (String(currency).toUpperCase() === "INR") {
    return `₹${safeAmount.toFixed(2)}`;
  }
  return `${String(currency || "INR").toUpperCase()} ${safeAmount.toFixed(2)}`;
}

async function sendCatalogueProduct(
  env: Bindings,
  to: string,
  catalogueId: string,
  bodyText: string,
): Promise<void> {
  const graphVersion = env.META_GRAPH_VERSION?.trim() || "v25.0";
  const endpoint = `https://graph.facebook.com/${graphVersion}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const catalogId = env.WHATSAPP_CATALOG_ID?.trim();
  if (!catalogId) throw new Error("WHATSAPP_CATALOG_ID is not configured");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "product",
        body: { text: bodyText.slice(0, 1024) },
        action: {
          catalog_id: catalogId,
          product_retailer_id: catalogueId,
        },
      },
    }),
  });

  const responseBody = await response.text();
  console.log(`WhatsApp catalogue product status: ${response.status}`, responseBody);
  if (!response.ok) {
    throw new Error(`WhatsApp catalogue product request failed with status ${response.status}`);
  }
}

async function sendText(env: Bindings, to: string, body: string): Promise<void> {
  const graphVersion = env.META_GRAPH_VERSION?.trim() || "v25.0";
  const endpoint = `https://graph.facebook.com/${graphVersion}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: {
        preview_url: true,
        body: body.slice(0, 4096),
      },
    }),
  });

  const responseBody = await response.text();
  console.log(`WhatsApp reply status: ${response.status}`, responseBody);

  if (!response.ok) {
    throw new Error(`WhatsApp API request failed with status ${response.status}`);
  }
}

async function sendImage(
  env: Bindings,
  to: string,
  imageUrl: string,
  caption: string,
): Promise<void> {
  const graphVersion = env.META_GRAPH_VERSION?.trim() || "v25.0";
  const endpoint = `https://graph.facebook.com/${graphVersion}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "image",
      image: {
        link: imageUrl,
        caption: caption.slice(0, 1024),
      },
    }),
  });

  const responseBody = await response.text();
  console.log(`WhatsApp image status: ${response.status}`, responseBody);

  if (!response.ok) {
    throw new Error(`WhatsApp image request failed with status ${response.status}`);
  }
}

async function replyAndLog(env: Bindings, phone: string, body: string): Promise<void> {
  await sendText(env, phone, body);
  await saveConversation(env, phone, "out", body, null);
}

async function initializeDatabase(env: Bindings): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS bot_users (
        phone TEXT PRIMARY KEY,
        language TEXT NOT NULL DEFAULT 'both',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
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
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS recommendation_context (
        phone TEXT PRIMARY KEY,
        query TEXT NOT NULL DEFAULT '',
        budget REAL,
        reference_pending INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS product_catalogue_map (
        product_url TEXT PRIMARY KEY,
        catalogue_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS processed_shopify_webhooks (
        webhook_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS recovered_checkout_tokens (
        checkout_token TEXT PRIMARY KEY,
        recovered_at INTEGER NOT NULL
      )
    `),
    env.DB.prepare(`
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
      CREATE TABLE IF NOT EXISTS order_tracking_context (
        phone TEXT PRIMARY KEY,
        pending INTEGER NOT NULL DEFAULT 1,
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
      CREATE INDEX IF NOT EXISTS idx_whatsapp_order_drafts_phone
      ON whatsapp_order_drafts(phone, updated_at)
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS shopify_orders (
        order_id TEXT PRIMARY KEY,
        order_number TEXT NOT NULL DEFAULT '',
        order_name TEXT NOT NULL DEFAULT '',
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
      )
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_shopify_orders_lookup
      ON shopify_orders(order_number, phone, updated_at)
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_abandoned_due
      ON abandoned_checkouts(status, due_at)
    `),
  ]);
}

async function saveLastProductSuggestions(
  env: Bindings,
  phone: string,
  products: ProductSuggestion[],
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO last_product_suggestions (phone, products_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      products_json = excluded.products_json,
      updated_at = CURRENT_TIMESTAMP
  `)
    .bind(phone, JSON.stringify(products.slice(0, 3)))
    .run();
}

async function getLastProductSuggestions(
  env: Bindings,
  phone: string,
): Promise<ProductSuggestion[]> {
  const row = await env.DB.prepare(`
    SELECT products_json, updated_at
    FROM last_product_suggestions
    WHERE phone = ?
      AND datetime(updated_at) >= datetime('now', '-24 hours')
    LIMIT 1
  `)
    .bind(phone)
    .first<{ products_json: string }>();

  if (!row?.products_json) return [];
  try {
    const products = JSON.parse(row.products_json);
    return Array.isArray(products) ? products.slice(0, 3) : [];
  } catch {
    return [];
  }
}

async function handleTrackingFlow(
  env: Bindings,
  phone: string,
  language: Language,
  text: string,
  normalized: string,
): Promise<boolean> {
  const pending = await env.DB.prepare(
    "SELECT pending FROM order_tracking_context WHERE phone = ? LIMIT 1",
  )
    .bind(phone)
    .first<{ pending: number }>();

  if (!isOrderCommand(normalized) && normalized !== "8" && !pending?.pending) {
    return false;
  }

  const orderNumber = extractOrderNumber(text);
  if (!orderNumber) {
    await env.DB.prepare(`
      INSERT INTO order_tracking_context (phone, pending, updated_at)
      VALUES (?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(phone) DO UPDATE SET pending = 1, updated_at = CURRENT_TIMESTAMP
    `)
      .bind(phone)
      .run();
    await replyAndLog(env, phone, orderStatusMessage(language));
    return true;
  }

  const order = await findShopifyOrder(env, phone, orderNumber);
  await env.DB.prepare("DELETE FROM order_tracking_context WHERE phone = ?")
    .bind(phone)
    .run();

  if (!order) {
    await replyAndLog(env, phone, orderNotFoundMessage(language, orderNumber));
    return true;
  }

  await replyAndLog(env, phone, formatOrderStatusMessage(language, order));
  return true;
}

function extractOrderNumber(value: string): string | null {
  const explicit = /(?:order|ऑर्डर)?\s*(?:number|no\.?|#)?\s*#?([0-9]{3,10})/i.exec(value);
  if (explicit) return explicit[1];
  const exact = /^\s*#?([0-9]{3,10})\s*$/.exec(value);
  return exact ? exact[1] : null;
}

async function findShopifyOrder(
  env: Bindings,
  phone: string,
  orderNumber: string,
): Promise<ShopifyOrderRow | null> {
  const digits = orderNumber.replace(/\D/g, "");
  const row = await env.DB.prepare(`
    SELECT order_id, order_number, order_name, phone, customer_name,
           financial_status, fulfillment_status, shipment_status, status_label,
           tracking_company, tracking_number, tracking_url, order_status_url,
           total_price, currency, line_items_summary, cancelled_at
    FROM shopify_orders
    WHERE (order_number = ? OR REPLACE(REPLACE(order_name, '#', ''), 'IG', '') = ?)
      AND substr(phone, -10) = substr(?, -10)
    ORDER BY updated_at DESC
    LIMIT 1
  `)
    .bind(digits, digits, phone)
    .first<ShopifyOrderRow>();
  return row ?? null;
}

function orderNotFoundMessage(language: Language, orderNumber: string): string {
  if (language === "hi") {
    return `ऑर्डर #${orderNumber} इस WhatsApp नंबर से नहीं मिला। नंबर दोबारा check करें या *Support* लिखें।`;
  }
  if (language === "en") {
    return `Order #${orderNumber} was not found for this WhatsApp number. Check the number or reply *Support*.`;
  }
  return `Order #${orderNumber} is WhatsApp number se nahi mila. Number check karein ya *Support* likhein.`;
}

function formatOrderStatusMessage(language: Language, order: ShopifyOrderRow): string {
  const orderName = order.order_name || `#${order.order_number}`;
  const total = formatCheckoutAmount(Number(order.total_price || 0), order.currency || "INR");
  const tracking = order.tracking_number
    ? `\nTracking Number: ${order.tracking_number}`
    : "";
  const courier = order.tracking_company
    ? `\nCourier: ${order.tracking_company}`
    : "";
  const trackingUrl = order.tracking_url
    ? `\n🚚 Track shipment: ${order.tracking_url}`
    : "";
  const statusUrl = order.order_status_url
    ? `\n📦 Shopify order page: ${order.order_status_url}`
    : "";

  if (language === "hi") {
    return `📦 *ऑर्डर स्टेटस*\n\nऑर्डर: ${orderName}\nप्रोडक्ट: ${order.line_items_summary || "Order items"}\nकुल: ${total}\nपेमेंट: ${humanizeStatus(order.financial_status || "pending")}\nस्टेटस: *${order.status_label}*${courier}${tracking}${trackingUrl}${statusUrl}`;
  }

  if (language === "en") {
    return `📦 *Order Status*\n\nOrder: ${orderName}\nProduct: ${order.line_items_summary || "Order items"}\nTotal: ${total}\nPayment: ${humanizeStatus(order.financial_status || "pending")}\nStatus: *${order.status_label}*${courier}${tracking}${trackingUrl}${statusUrl}`;
  }

  return `📦 *Order Status / ऑर्डर स्टेटस*\n\nOrder: ${orderName}\nProduct: ${order.line_items_summary || "Order items"}\nTotal: ${total}\nPayment: ${humanizeStatus(order.financial_status || "pending")}\nStatus: *${order.status_label}*${courier}${tracking}${trackingUrl}${statusUrl}`;
}

async function handleWhatsAppOrderFlow(
  env: Bindings,
  phone: string,
  language: Language,
  text: string,
  normalized: string,
): Promise<boolean> {
  let context = await getOrderFlowContext(env, phone);
  const suggestions = await getLastProductSuggestions(env, phone);
  const optionNumber = parseProductOptionNumber(normalized);
  const optionSelection = optionNumber !== null && suggestions.length >= optionNumber;

  if (!context && !isBuyIntent(normalized) && !optionSelection) return false;

  if (isCancelOrderIntent(normalized)) {
    await clearOrderFlowContext(env, phone);
    await replyAndLog(env, phone, orderCancelledMessage(language));
    return true;
  }

  if (!context) {
    if (suggestions.length === 0) {
      await replyAndLog(env, phone, noSelectedProductForOrderMessage(language));
      return true;
    }

    let selectedIndex = optionNumber ? optionNumber - 1 : suggestions.length === 1 ? 0 : -1;
    if (selectedIndex < 0 || !suggestions[selectedIndex]) {
      await replyAndLog(env, phone, askProductOptionForOrderMessage(language, suggestions.length));
      return true;
    }

    let product = suggestions[selectedIndex];
    if (!product.variants?.length) {
      product = await fetchVerifiedProductDetails(env, product);
    }

    const variants = (product.variants ?? []).filter((variant) => variant.available);
    if (variants.length === 0) {
      await replyAndLog(env, phone, productUnavailableForOrderMessage(language));
      return true;
    }

    const meaningfulVariants = variants.filter(
      (variant) => normalize(variant.title) !== "default title",
    );
    const firstVariant = meaningfulVariants.length === 0 ? variants[0] : null;

    context = {
      phone,
      step: firstVariant ? (isCustomProduct(product) ? "customization" : "quantity") : "variant",
      selected_product: product,
      selected_variant: firstVariant,
      customization_text: "",
      quantity: 1,
      customer_name: "",
      full_address: "",
      pincode: "",
    };
    await saveOrderFlowContext(env, context);

    if (!firstVariant) {
      await replyAndLog(env, phone, variantSelectionMessage(language, product, meaningfulVariants));
    } else if (isCustomProduct(product)) {
      await replyAndLog(env, phone, customizationQuestionMessage(language, product.title));
    } else {
      await replyAndLog(env, phone, quantityQuestionMessage(language));
    }
    return true;
  }

  if (context.step === "variant") {
    const variants = (context.selected_product?.variants ?? []).filter(
      (variant) => variant.available && normalize(variant.title) !== "default title",
    );
    const selected = selectVariantFromReply(variants, text);
    if (!selected) {
      await replyAndLog(env, phone, variantSelectionMessage(language, context.selected_product!, variants));
      return true;
    }
    context.selected_variant = selected;
    context.step = context.selected_product && isCustomProduct(context.selected_product)
      ? "customization"
      : "quantity";
    await saveOrderFlowContext(env, context);
    await replyAndLog(
      env,
      phone,
      context.step === "customization"
        ? customizationQuestionMessage(language, context.selected_product?.title || "product")
        : quantityQuestionMessage(language),
    );
    return true;
  }

  if (context.step === "customization") {
    const value = text.trim();
    if (!value || value.length > 150) {
      await replyAndLog(env, phone, customizationQuestionMessage(language, context.selected_product?.title || "product"));
      return true;
    }
    context.customization_text = /^(na|n\/a|no|none|नहीं)$/i.test(value) ? "" : value;
    context.step = "quantity";
    await saveOrderFlowContext(env, context);
    await replyAndLog(env, phone, quantityQuestionMessage(language));
    return true;
  }

  if (context.step === "quantity") {
    const quantity = parseQuantity(text);
    if (!quantity) {
      await replyAndLog(env, phone, quantityQuestionMessage(language));
      return true;
    }
    context.quantity = quantity;
    context.step = "customer_name";
    await saveOrderFlowContext(env, context);
    await replyAndLog(env, phone, customerNameQuestionMessage(language));
    return true;
  }

  if (context.step === "customer_name") {
    const value = text.trim().replace(/\s+/g, " ");
    if (value.length < 2 || value.length > 80) {
      await replyAndLog(env, phone, customerNameQuestionMessage(language));
      return true;
    }
    context.customer_name = value;
    context.step = "address";
    await saveOrderFlowContext(env, context);
    await replyAndLog(env, phone, addressQuestionMessage(language));
    return true;
  }

  if (context.step === "address") {
    const value = text.trim().replace(/\s+/g, " ");
    if (value.length < 12 || value.length > 300) {
      await replyAndLog(env, phone, addressQuestionMessage(language));
      return true;
    }
    context.full_address = value;
    context.step = "pincode";
    await saveOrderFlowContext(env, context);
    await replyAndLog(env, phone, pincodeQuestionMessage(language));
    return true;
  }

  if (context.step === "pincode") {
    const pincode = extractIndianPincode(text);
    if (!pincode) {
      await replyAndLog(env, phone, pincodeQuestionMessage(language));
      return true;
    }
    context.pincode = pincode;
    context.step = "confirm";
    await saveOrderFlowContext(env, context);
    await replyAndLog(env, phone, orderSummaryMessage(language, context));
    return true;
  }

  if (context.step === "confirm") {
    if (!isConfirmOrderIntent(normalized)) {
      await replyAndLog(env, phone, confirmOrderAgainMessage(language));
      return true;
    }

    try {
      const checkoutUrl = buildShopifyCheckoutUrl(env, context, phone);
      await saveWhatsAppOrderDraft(env, context, checkoutUrl, phone);
      await replyAndLog(env, phone, paymentLinkMessage(language, checkoutUrl));
      await clearOrderFlowContext(env, phone);
    } catch (error) {
      console.error("Checkout link creation failed:", error);
      await replyAndLog(env, phone, checkoutLinkFailureMessage(language));
    }
    return true;
  }

  return true;
}

function selectVariantFromReply(
  variants: ProductVariantInfo[],
  value: string,
): ProductVariantInfo | null {
  const normalizedValue = normalize(value);
  const number = /^(?:option\s*)?([1-9])$/.exec(normalizedValue);
  if (number) return variants[Number(number[1]) - 1] ?? null;

  const direct = variants.find((variant) => normalize(variant.title) === normalizedValue);
  if (direct) return direct;

  return variants.find((variant) => normalize(variant.title).includes(normalizedValue)) ?? null;
}

function parseQuantity(value: string): number | null {
  const match = /(?:qty|quantity)?\s*([1-9]|10)\b/i.exec(value.trim());
  if (!match) return null;
  const quantity = Number(match[1]);
  return quantity >= 1 && quantity <= 10 ? quantity : null;
}

function extractIndianPincode(value: string): string | null {
  const match = /\b([1-9][0-9]{5})\b/.exec(value);
  return match ? match[1] : null;
}

function variantSelectionMessage(
  language: Language,
  product: ProductSuggestion,
  variants: ProductVariantInfo[],
): string {
  const options = variants.slice(0, 9).map((variant, index) => {
    const price = variant.price === null ? "" : ` — ${formatPrice(variant.price)}`;
    return `${index + 1}. ${variant.title}${price}`;
  }).join("\n");
  if (language === "hi") return `*${product.title}* के लिए option चुनें:\n${options}\n\nसिर्फ option number भेजें।`;
  if (language === "en") return `Choose an option for *${product.title}*:\n${options}\n\nReply with the option number.`;
  return `*${product.title}* ke liye option select karein:\n${options}\n\nSirf option number bhejein.`;
}

function customizationQuestionMessage(language: Language, title: string): string {
  if (language === "hi") return `*${title}* पर कौन-सा नाम/टेक्स्ट चाहिए? Customization नहीं चाहिए तो *NA* लिखें।`;
  if (language === "en") return `What name/text should be customised on *${title}*? Reply *NA* if not required.`;
  return `*${title}* par kaunsa name/text customise karna hai? Nahi chahiye to *NA* likhein.`;
}

function quantityQuestionMessage(language: Language): string {
  if (language === "hi") return "Quantity कितनी चाहिए? 1 से 10 के बीच number भेजें।";
  if (language === "en") return "What quantity do you need? Send a number from 1 to 10.";
  return "Quantity kitni chahiye? 1 se 10 ke beech number bhejein.";
}

function customerNameQuestionMessage(language: Language): string {
  if (language === "hi") return "Delivery के लिए पूरा नाम भेजें।";
  if (language === "en") return "Please send the full name for delivery.";
  return "Delivery ke liye customer ka full name bhejein.";
}

function addressQuestionMessage(language: Language): string {
  if (language === "hi") return "पूरा delivery address भेजें: House/Street, Area, City और State।";
  if (language === "en") return "Send the complete delivery address: house/street, area, city and state.";
  return "Pura delivery address bhejein: House/Street, Area, City aur State.";
}

function pincodeQuestionMessage(language: Language): string {
  if (language === "hi") return "6 अंकों का delivery PIN code भेजें।";
  if (language === "en") return "Please send the 6-digit delivery PIN code.";
  return "6 digit delivery PIN code bhejein.";
}

function askProductOptionForOrderMessage(language: Language, count: number): string {
  const options = Array.from({ length: count }, (_, i) => i + 1).join(", ");
  if (language === "hi") return `कौन-सा product order करना है? Option ${options} में से number भेजें।`;
  if (language === "en") return `Which product would you like to order? Reply with option ${options}.`;
  return `Kaunsa product order karna hai? Option ${options} mein se number bhejein.`;
}

function noSelectedProductForOrderMessage(language: Language): string {
  if (language === "hi") return "पहले product का नाम भेजें। Product दिखने के बाद *Option 1 order* जैसा reply करें।";
  if (language === "en") return "Please send the product name first. After products appear, reply like *Order option 1*.";
  return "Pehle product ka naam bhejein. Products dikhne ke baad *Option 1 order* likhein.";
}

function productUnavailableForOrderMessage(language: Language): string {
  if (language === "hi") return "यह product/variant अभी verified availability में नहीं है। दूसरा option चुनें।";
  if (language === "en") return "This product/variant is not currently available. Please choose another option.";
  return "Ye product/variant abhi available nahi hai. Dusra option choose karein.";
}

function orderCancelledMessage(language: Language): string {
  if (language === "hi") return "Order process cancel कर दिया गया है ✅";
  if (language === "en") return "The order process has been cancelled ✅";
  return "Order process cancel kar diya gaya hai ✅";
}

function orderSummaryMessage(language: Language, context: OrderFlowContext): string {
  const variantPrice = context.selected_variant?.price;
  const total = variantPrice === null || variantPrice === undefined
    ? "Checkout पर confirm होगा"
    : formatPrice(variantPrice * context.quantity) || "Checkout पर confirm होगा";
  const customization = context.customization_text
    ? `\nCustomization: ${context.customization_text}`
    : "";
  const variant = context.selected_variant?.title && normalize(context.selected_variant.title) !== "default title"
    ? `\nOption: ${context.selected_variant.title}`
    : "";

  return `✅ *Order Summary*\n\nProduct: ${context.selected_product?.title || "Product"}${variant}${customization}\nQuantity: ${context.quantity}\nTotal: ${total}\n\nDelivery Name: ${context.customer_name}\nAddress: ${context.full_address}\nPIN: ${context.pincode}\n\nCustom products ke liye COD available nahi hai. Final price aur shipping checkout par verify karein.\n\nOrder sahi hai to *Confirm Order* likhein. Cancel ke liye *Cancel Order* likhein.`;
}

function confirmOrderAgainMessage(language: Language): string {
  if (language === "hi") return "Payment link बनाने के लिए *Confirm Order* लिखें या रोकने के लिए *Cancel Order* लिखें।";
  if (language === "en") return "Reply *Confirm Order* to create the payment link, or *Cancel Order* to stop.";
  return "Payment link ke liye *Confirm Order* likhein, ya rokne ke liye *Cancel Order*.";
}

function paymentLinkMessage(language: Language, checkoutUrl: string): string {
  if (language === "hi") {
    return `आपका order checkout ready है ✅\n\n🔐 Secure payment link:\n${checkoutUrl}\n\nCustom products पर COD उपलब्ध नहीं है। OTP, UPI PIN, CVV या card details WhatsApp पर कभी share न करें। Payment के बाद Shopify order number मिलेगा।`;
  }
  if (language === "en") {
    return `Your checkout is ready ✅\n\n🔐 Secure payment link:\n${checkoutUrl}\n\nCOD is unavailable for customised products. Never share OTP, UPI PIN, CVV or card details on WhatsApp. Shopify will provide the order number after payment.`;
  }
  return `Aapka checkout ready hai ✅\n\n🔐 Secure payment link:\n${checkoutUrl}\n\nCustom products par COD available nahi hai. OTP, UPI PIN, CVV ya card details WhatsApp par share na karein. Payment ke baad Shopify order number milega.`;
}

function checkoutLinkFailureMessage(language: Language): string {
  if (language === "hi") return "Verified checkout link नहीं बन पाया। कृपया *Support* लिखें; team order complete करेगी।";
  if (language === "en") return "A verified checkout link could not be created. Reply *Support* for assistance.";
  return "Verified checkout link create nahi ho paya. *Support* likhein; team help karegi.";
}

function buildShopifyCheckoutUrl(
  env: Bindings,
  context: OrderFlowContext,
  phone: string,
): string {
  const variantId = String(context.selected_variant?.id ?? "").replace(/\D/g, "");
  if (!variantId) throw new Error("Numeric Shopify variant ID is missing");

  const quantity = Math.max(1, Math.min(10, Number(context.quantity || 1)));
  const url = new URL(`/cart/${variantId}:${quantity}`, shopDomain(env));
  const properties: Record<string, string> = {
    "WhatsApp Phone": `+${phone}`,
    "Order Source": "WhatsApp Bot",
  };
  if (context.customization_text) properties["Custom Text"] = context.customization_text;

  url.searchParams.set("properties", base64UrlEncode(JSON.stringify(properties)));
  url.searchParams.set("checkout[shipping_address][first_name]", context.customer_name);
  url.searchParams.set("checkout[shipping_address][address1]", context.full_address);
  url.searchParams.set("checkout[shipping_address][zip]", context.pincode);
  url.searchParams.set("checkout[shipping_address][country]", "India");
  url.searchParams.set("attributes[WhatsApp Phone]", `+${phone}`);
  url.searchParams.set("attributes[Order Source]", "WhatsApp Bot");
  url.searchParams.set("ref", "whatsapp-bot");
  return url.toString();
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function getOrderFlowContext(
  env: Bindings,
  phone: string,
): Promise<OrderFlowContext | null> {
  const row = await env.DB.prepare(`
    SELECT phone, step, selected_product_json, selected_variant_json,
           customization_text, quantity, customer_name, full_address, pincode
    FROM order_flow_context
    WHERE phone = ?
    LIMIT 1
  `)
    .bind(phone)
    .first<any>();
  if (!row) return null;

  try {
    return {
      phone: row.phone,
      step: row.step,
      selected_product: row.selected_product_json ? JSON.parse(row.selected_product_json) : null,
      selected_variant: row.selected_variant_json ? JSON.parse(row.selected_variant_json) : null,
      customization_text: row.customization_text || "",
      quantity: Number(row.quantity || 1),
      customer_name: row.customer_name || "",
      full_address: row.full_address || "",
      pincode: row.pincode || "",
    };
  } catch {
    await clearOrderFlowContext(env, phone);
    return null;
  }
}

async function saveOrderFlowContext(env: Bindings, context: OrderFlowContext): Promise<void> {
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
  `)
    .bind(
      context.phone,
      context.step,
      context.selected_product ? JSON.stringify(context.selected_product) : null,
      context.selected_variant ? JSON.stringify(context.selected_variant) : null,
      context.customization_text,
      context.quantity,
      context.customer_name,
      context.full_address,
      context.pincode,
    )
    .run();
}

async function clearOrderFlowContext(env: Bindings, phone: string): Promise<void> {
  await env.DB.prepare("DELETE FROM order_flow_context WHERE phone = ?").bind(phone).run();
}

async function saveWhatsAppOrderDraft(
  env: Bindings,
  context: OrderFlowContext,
  checkoutUrl: string,
  phone: string,
): Promise<void> {
  const unitPrice = context.selected_variant?.price ?? null;
  const totalPrice = unitPrice === null ? null : unitPrice * context.quantity;
  await env.DB.prepare(`
    INSERT INTO whatsapp_order_drafts (
      phone, customer_name, product_title, product_url, variant_id, variant_title,
      customization_text, quantity, unit_price, total_price, full_address, pincode,
      checkout_url, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'payment_pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `)
    .bind(
      phone,
      context.customer_name,
      context.selected_product?.title || "Product",
      context.selected_product ? absoluteUrl(shopDomain(env), context.selected_product.url) : "",
      String(context.selected_variant?.id ?? ""),
      context.selected_variant?.title || "",
      context.customization_text,
      context.quantity,
      unitPrice,
      totalPrice,
      context.full_address,
      context.pincode,
      checkoutUrl,
    )
    .run();
}

async function upsertShopifyOrder(env: Bindings, payload: any): Promise<void> {
  const orderId = String(payload?.id ?? payload?.admin_graphql_api_id ?? "").trim();
  if (!orderId) return;

  const phone = orderPhone(payload) ?? "";
  const fulfillments = Array.isArray(payload?.fulfillments) ? payload.fulfillments : [];
  const fulfillment = [...fulfillments].reverse().find((item: any) =>
    item?.tracking_number || item?.tracking_url || item?.shipment_status,
  ) ?? fulfillments[fulfillments.length - 1] ?? {};
  const trackingNumber = String(
    fulfillment?.tracking_number ?? fulfillment?.tracking_numbers?.[0] ?? "",
  );
  const trackingUrl = String(
    fulfillment?.tracking_url ?? fulfillment?.tracking_urls?.[0] ?? "",
  );
  const shipmentStatus = String(fulfillment?.shipment_status ?? "");
  const financialStatus = String(payload?.financial_status ?? "");
  const fulfillmentStatus = String(payload?.fulfillment_status ?? "");
  const cancelledAt = String(payload?.cancelled_at ?? "");
  const statusLabel = deriveOrderStatusLabel({
    financialStatus,
    fulfillmentStatus,
    shipmentStatus,
    cancelledAt,
    trackingNumber,
    trackingUrl,
  });
  const orderNumber = String(payload?.order_number ?? "").replace(/\D/g, "");
  const orderName = String(payload?.name ?? (orderNumber ? `#${orderNumber}` : ""));
  const customerName = String(
    payload?.shipping_address?.name ??
    [payload?.customer?.first_name, payload?.customer?.last_name].filter(Boolean).join(" ") ??
    "",
  ).trim();
  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
  const lineItemsSummary = lineItems.slice(0, 3).map((item: any) => {
    const quantity = Number(item?.quantity ?? 1);
    return `${String(item?.title ?? item?.name ?? "Product")}${quantity > 1 ? ` × ${quantity}` : ""}`;
  }).join(", ");

  await env.DB.prepare(`
    INSERT INTO shopify_orders (
      order_id, order_number, order_name, phone, customer_name, financial_status,
      fulfillment_status, shipment_status, status_label, tracking_company,
      tracking_number, tracking_url, order_status_url, total_price, currency,
      line_items_summary, cancelled_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(order_id) DO UPDATE SET
      order_number = excluded.order_number,
      order_name = excluded.order_name,
      phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE shopify_orders.phone END,
      customer_name = CASE WHEN excluded.customer_name != '' THEN excluded.customer_name ELSE shopify_orders.customer_name END,
      financial_status = excluded.financial_status,
      fulfillment_status = excluded.fulfillment_status,
      shipment_status = excluded.shipment_status,
      status_label = excluded.status_label,
      tracking_company = excluded.tracking_company,
      tracking_number = excluded.tracking_number,
      tracking_url = excluded.tracking_url,
      order_status_url = excluded.order_status_url,
      total_price = excluded.total_price,
      currency = excluded.currency,
      line_items_summary = excluded.line_items_summary,
      cancelled_at = excluded.cancelled_at,
      updated_at = CURRENT_TIMESTAMP
  `)
    .bind(
      orderId,
      orderNumber,
      orderName,
      phone,
      customerName,
      financialStatus,
      fulfillmentStatus,
      shipmentStatus,
      statusLabel,
      String(fulfillment?.tracking_company ?? ""),
      trackingNumber,
      trackingUrl,
      String(payload?.order_status_url ?? ""),
      Number(payload?.current_total_price ?? payload?.total_price ?? 0),
      String(payload?.currency ?? "INR"),
      lineItemsSummary,
      cancelledAt,
    )
    .run();

  if (phone && financialStatus === "paid") {
    await env.DB.prepare(`
      UPDATE whatsapp_order_drafts
      SET status = 'paid', updated_at = CURRENT_TIMESTAMP
      WHERE substr(phone, -10) = substr(?, -10) AND status = 'payment_pending'
    `).bind(phone).run();
  }
}

function orderPhone(payload: any): string | null {
  const attributes = Array.isArray(payload?.note_attributes) ? payload.note_attributes : [];
  const attributePhone = attributes.find((attribute: any) =>
    normalize(String(attribute?.name ?? "")) === "whatsapp phone",
  )?.value;
  const candidates = [
    attributePhone,
    payload?.phone,
    payload?.shipping_address?.phone,
    payload?.billing_address?.phone,
    payload?.customer?.phone,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWhatsAppPhone(String(candidate ?? ""));
    if (normalized) return normalized;
  }
  return null;
}

function deriveOrderStatusLabel(input: {
  financialStatus: string;
  fulfillmentStatus: string;
  shipmentStatus: string;
  cancelledAt: string;
  trackingNumber: string;
  trackingUrl: string;
}): string {
  const shipment = normalize(input.shipmentStatus);
  if (input.cancelledAt) return "Cancelled";
  if (shipment === "delivered") return "Delivered";
  if (["out for delivery", "out_for_delivery"].includes(shipment)) return "Out for delivery";
  if (["in transit", "in_transit"].includes(shipment)) return "In transit";
  if (input.trackingNumber || input.trackingUrl) return "Dispatched";
  if (normalize(input.fulfillmentStatus) === "fulfilled") return "Fulfilled";
  if (normalize(input.fulfillmentStatus) === "partial") return "Partially fulfilled";
  if (normalize(input.financialStatus) === "paid") return "Payment received — processing";
  if (["pending", "authorized", "partially paid", "partially_paid"].includes(normalize(input.financialStatus))) {
    return "Payment pending";
  }
  return "Order confirmed";
}

async function updateShopifyOrderFromFulfillment(env: Bindings, payload: any): Promise<void> {
  const orderId = String(payload?.order_id ?? "").trim();
  if (!orderId) return;
  const trackingNumber = String(payload?.tracking_number ?? payload?.tracking_numbers?.[0] ?? "");
  const trackingUrl = String(payload?.tracking_url ?? payload?.tracking_urls?.[0] ?? "");
  const shipmentStatus = String(payload?.shipment_status ?? "");
  const statusLabel = deriveOrderStatusLabel({
    financialStatus: "paid",
    fulfillmentStatus: "fulfilled",
    shipmentStatus,
    cancelledAt: "",
    trackingNumber,
    trackingUrl,
  });
  await env.DB.prepare(`
    UPDATE shopify_orders
    SET fulfillment_status = 'fulfilled', shipment_status = ?, status_label = ?,
        tracking_company = ?, tracking_number = ?, tracking_url = ?, updated_at = CURRENT_TIMESTAMP
    WHERE order_id = ? OR order_id = ?
  `)
    .bind(
      shipmentStatus,
      statusLabel,
      String(payload?.tracking_company ?? ""),
      trackingNumber,
      trackingUrl,
      orderId,
      `gid://shopify/Order/${orderId}`,
    )
    .run();
}

async function notifyOrderUpdateInsideCustomerWindow(
  env: Bindings,
  topic: string,
  payload: any,
): Promise<void> {
  if (topic !== "orders/paid") return;
  const phone = orderPhone(payload);
  if (!phone || !(await hasOpenCustomerServiceWindow(env, phone))) return;
  const orderName = String(payload?.name ?? `#${payload?.order_number ?? ""}`);
  const total = formatCheckoutAmount(Number(payload?.current_total_price ?? payload?.total_price ?? 0), String(payload?.currency ?? "INR"));
  const message = `🎉 Payment successful!\n\nOrder: ${orderName}\nPaid amount: ${total}\nStatus: Payment received — processing\n\nTracking details dispatch ke baad isi order status mein milengi.`;
  try {
    await replyAndLog(env, phone, message);
  } catch (error) {
    console.error("Payment confirmation WhatsApp send skipped/failed:", error);
  }
}

async function notifyFulfillmentUpdateInsideCustomerWindow(
  env: Bindings,
  payload: any,
): Promise<void> {
  const orderId = String(payload?.order_id ?? "");
  if (!orderId) return;
  const order = await env.DB.prepare(`
    SELECT phone, order_name, order_number, tracking_company, tracking_number, tracking_url, status_label
    FROM shopify_orders
    WHERE order_id = ? OR order_id = ?
    LIMIT 1
  `).bind(orderId, `gid://shopify/Order/${orderId}`).first<any>();
  if (!order?.phone || !(await hasOpenCustomerServiceWindow(env, order.phone))) return;
  const message = `📦 Order update\n\nOrder: ${order.order_name || `#${order.order_number}`}\nStatus: ${order.status_label || "Dispatched"}${order.tracking_company ? `\nCourier: ${order.tracking_company}` : ""}${order.tracking_number ? `\nTracking: ${order.tracking_number}` : ""}${order.tracking_url ? `\nTrack: ${order.tracking_url}` : ""}`;
  try {
    await replyAndLog(env, order.phone, message);
  } catch (error) {
    console.error("Fulfillment notification WhatsApp send skipped/failed:", error);
  }
}

async function hasOpenCustomerServiceWindow(env: Bindings, phone: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT created_at
    FROM conversations
    WHERE phone = ? AND direction = 'in'
    ORDER BY id DESC
    LIMIT 1
  `).bind(phone).first<{ created_at: string }>();
  if (!row?.created_at) return false;
  const timestamp = Date.parse(row.created_at.includes("T") ? row.created_at : `${row.created_at.replace(" ", "T")}Z`);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= 24 * 60 * 60 * 1000;
}

function humanizeStatus(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function getRecommendationContext(
  env: Bindings,
  phone: string,
): Promise<RecommendationContext | null> {
  const row = await env.DB.prepare(
    `SELECT query, budget, reference_pending
     FROM recommendation_context
     WHERE phone = ?
     LIMIT 1`,
  )
    .bind(phone)
    .first<{ query: string; budget: number | null; reference_pending: number }>();

  return row
    ? {
        query: row.query || "",
        budget: row.budget === null ? null : Number(row.budget),
        reference_pending: Number(row.reference_pending || 0),
      }
    : null;
}

async function saveRecommendationContext(
  env: Bindings,
  phone: string,
  context: RecommendationContext,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO recommendation_context (phone, query, budget, reference_pending, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      query = excluded.query,
      budget = excluded.budget,
      reference_pending = excluded.reference_pending,
      updated_at = CURRENT_TIMESTAMP
  `)
    .bind(phone, context.query.slice(0, 160), context.budget, context.reference_pending)
    .run();
}

async function clearRecommendationContext(env: Bindings, phone: string): Promise<void> {
  await env.DB.prepare("DELETE FROM recommendation_context WHERE phone = ?")
    .bind(phone)
    .run();
}

async function markMessageAsNew(env: Bindings, messageId: string): Promise<boolean> {
  const existing = await env.DB.prepare(
    "SELECT message_id FROM processed_messages WHERE message_id = ? LIMIT 1",
  )
    .bind(messageId)
    .first();

  if (existing) return false;

  await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)",
  )
    .bind(messageId)
    .run();

  return true;
}


async function upsertContact(
  env: Bindings,
  phone: string,
  profileName: string,
): Promise<void> {
  const cleanName = profileName.trim().slice(0, 120);

  await env.DB.prepare(`
    INSERT INTO contacts (phone, profile_name, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      profile_name = CASE
        WHEN excluded.profile_name != '' THEN excluded.profile_name
        ELSE contacts.profile_name
      END,
      updated_at = CURRENT_TIMESTAMP
  `)
    .bind(phone, cleanName)
    .run();
}

async function getOrCreateUser(env: Bindings, phone: string): Promise<BotUser> {
  const existing = await env.DB.prepare(
    "SELECT language FROM bot_users WHERE phone = ? LIMIT 1",
  )
    .bind(phone)
    .first<{ language: string }>();

  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO bot_users (phone, language) VALUES (?, 'both')",
    )
      .bind(phone)
      .run();
    return { language: "both", isNew: true };
  }

  await env.DB.prepare(
    "UPDATE bot_users SET last_seen_at = CURRENT_TIMESTAMP WHERE phone = ?",
  )
    .bind(phone)
    .run();

  return {
    language: isLanguage(existing.language) ? existing.language : "both",
    isNew: false,
  };
}

async function setUserLanguage(
  env: Bindings,
  phone: string,
  language: Language,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bot_users (phone, language)
     VALUES (?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       language = excluded.language,
       last_seen_at = CURRENT_TIMESTAMP`,
  )
    .bind(phone, language)
    .run();
}

function isLanguage(value: string): value is Language {
  return value === "en" || value === "hi" || value === "both";
}


function isAdminAuthorized(env: Bindings, authorization?: string): boolean {
  const expectedPassword = env.ADMIN_PASSWORD?.trim();
  if (!expectedPassword || !authorization?.startsWith("Basic ")) return false;

  try {
    const decoded = atob(authorization.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    const expectedUsername = env.ADMIN_USERNAME?.trim() || "admin";

    return username === expectedUsername && password === expectedPassword;
  } catch {
    return false;
  }
}

function adminInboxHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>IG Store WhatsApp Inbox</title>
  <style>
    *{box-sizing:border-box}body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#dfe5e7;color:#111827;height:100vh;overflow:hidden}
    .app{height:100vh;max-width:1500px;margin:auto;background:#fff;display:grid;grid-template-columns:360px 1fr;box-shadow:0 0 30px rgba(0,0,0,.14)}
    .sidebar{border-right:1px solid #d8dde1;display:flex;flex-direction:column;min-width:0;background:#fff}
    .brand{height:68px;padding:12px 16px;background:#f0f2f5;display:flex;align-items:center;gap:12px;border-bottom:1px solid #d8dde1}
    .logo{width:42px;height:42px;border-radius:50%;background:#00a884;color:#fff;display:grid;place-items:center;font-weight:800}
    .brand strong{display:block;font-size:17px}.brand small{color:#667781}
    .search{padding:10px 12px;background:#fff;border-bottom:1px solid #eef0f2}.search input{width:100%;border:0;background:#f0f2f5;border-radius:9px;padding:11px 14px;outline:none;font-size:14px}
    .chat-list{overflow:auto;flex:1}.empty{padding:30px 18px;text-align:center;color:#667781}
    .chat-item{padding:12px 14px;display:grid;grid-template-columns:48px 1fr auto;gap:11px;cursor:pointer;border-bottom:1px solid #f0f2f5}.chat-item:hover,.chat-item.active{background:#f0f2f5}
    .avatar{width:48px;height:48px;border-radius:50%;background:#d9fdd3;display:grid;place-items:center;font-weight:700;color:#087b62;text-transform:uppercase}
    .chat-main{min-width:0}.chat-name{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chat-preview{font-size:13px;color:#667781;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chat-time{font-size:11px;color:#667781;white-space:nowrap}.badge{display:inline-block;margin-top:6px;padding:3px 6px;border-radius:10px;background:#e7fce8;color:#087b62;font-size:10px;text-transform:capitalize}
    .main{display:flex;flex-direction:column;min-width:0;background:#efeae2}.topbar{height:68px;background:#f0f2f5;border-bottom:1px solid #d8dde1;padding:10px 16px;display:flex;align-items:center;gap:12px}.topbar .details{min-width:0}.topbar strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.topbar small{color:#667781}.back{display:none;border:0;background:transparent;font-size:24px;cursor:pointer}
    .placeholder{flex:1;display:grid;place-items:center;text-align:center;color:#667781;padding:30px}.placeholder h2{color:#41525d;font-weight:400}
    .messages{flex:1;overflow:auto;padding:22px 7%;background-color:#efeae2;background-image:radial-gradient(rgba(17,24,39,.035) 1px,transparent 1px);background-size:18px 18px;display:none}
    .row{display:flex;margin:4px 0}.row.in{justify-content:flex-start}.row.out{justify-content:flex-end}.bubble{max-width:min(70%,720px);padding:8px 10px 6px;border-radius:8px;box-shadow:0 1px 1px rgba(0,0,0,.09);white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.42}.in .bubble{background:#fff;border-top-left-radius:2px}.out .bubble{background:#d9fdd3;border-top-right-radius:2px}.msg-time{display:block;text-align:right;color:#667781;font-size:10px;margin-top:4px}
    .composer{display:none;background:#f0f2f5;padding:10px 14px;gap:10px;align-items:flex-end}.composer textarea{flex:1;resize:none;max-height:120px;min-height:42px;border:0;border-radius:9px;padding:11px 13px;font:inherit;outline:none}.composer button{height:42px;border:0;border-radius:50%;width:42px;background:#00a884;color:#fff;font-size:18px;cursor:pointer}.composer button:disabled{opacity:.5}.status{position:fixed;right:18px;bottom:18px;background:#111827;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;display:none;z-index:10}
    @media(max-width:760px){.app{display:block}.sidebar,.main{height:100vh}.main{display:none}.app.open-chat .sidebar{display:none}.app.open-chat .main{display:flex}.back{display:block}.messages{padding:18px 10px}.bubble{max-width:88%}}
  </style>
</head>
<body>
  <div class="app" id="app">
    <aside class="sidebar">
      <div class="brand"><div class="logo">IG</div><div><strong>IG Store Inbox</strong><small>WhatsApp conversations</small></div></div>
      <div class="search"><input id="search" placeholder="Search name or phone"></div>
      <div class="chat-list" id="chatList"><div class="empty">Loading conversations…</div></div>
    </aside>
    <main class="main">
      <header class="topbar">
        <button class="back" id="back" aria-label="Back">‹</button>
        <div class="avatar" id="headerAvatar">IG</div>
        <div class="details"><strong id="headerName">Select a customer</strong><small id="headerPhone">Chat history will appear here</small></div>
      </header>
      <section class="placeholder" id="placeholder"><div><h2>IG Store WhatsApp Inbox</h2><p>Select a customer from the left to view messages.</p></div></section>
      <section class="messages" id="messages"></section>
      <form class="composer" id="composer"><textarea id="messageInput" rows="1" placeholder="Type a message"></textarea><button id="sendButton" type="submit">➤</button></form>
    </main>
  </div>
  <div class="status" id="status"></div>
  <script>
    var chats = [];
    var selectedPhone = '';
    var selectedName = '';
    var loadingMessages = false;
    var app = document.getElementById('app');
    var chatList = document.getElementById('chatList');
    var messages = document.getElementById('messages');
    var placeholder = document.getElementById('placeholder');
    var composer = document.getElementById('composer');
    var search = document.getElementById('search');
    var messageInput = document.getElementById('messageInput');
    var sendButton = document.getElementById('sendButton');

    function initials(value){
      var words = String(value || 'IG').trim().split(/\\s+/).filter(Boolean);
      return words.slice(0,2).map(function(word){return word.charAt(0)}).join('').toUpperCase() || 'IG';
    }
    function dateValue(value){
      if(!value) return null;
      var normalized = String(value).indexOf('T') >= 0 ? String(value) : String(value).replace(' ','T') + 'Z';
      var date = new Date(normalized);
      return isNaN(date.getTime()) ? null : date;
    }
    function formatListTime(value){
      var date = dateValue(value); if(!date) return '';
      var now = new Date();
      if(date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      return date.toLocaleDateString([], {day:'2-digit',month:'short'});
    }
    function formatMessageTime(value){
      var date = dateValue(value); if(!date) return '';
      return date.toLocaleString([], {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
    }
    function showStatus(text){
      var box = document.getElementById('status'); box.textContent = text; box.style.display = 'block';
      clearTimeout(showStatus.timer); showStatus.timer = setTimeout(function(){box.style.display='none'}, 3500);
    }
    async function api(url, options){
      var response = await fetch(url, options || {});
      var data = await response.json().catch(function(){return {ok:false,error:'Invalid server response'}});
      if(!response.ok || !data.ok) throw new Error(data.error || 'Request failed');
      return data;
    }
    async function loadChats(){
      try{
        var data = await api('/admin/api/chats');
        chats = data.chats || [];
        renderChats();
      }catch(error){chatList.innerHTML='';var e=document.createElement('div');e.className='empty';e.textContent=error.message;chatList.appendChild(e)}
    }
    function renderChats(){
      var term = search.value.trim().toLowerCase();
      var filtered = chats.filter(function(chat){return String(chat.customer_name || '').toLowerCase().indexOf(term)>=0 || String(chat.phone || '').indexOf(term)>=0});
      chatList.innerHTML='';
      if(!filtered.length){var e=document.createElement('div');e.className='empty';e.textContent='No conversations found';chatList.appendChild(e);return}
      filtered.forEach(function(chat){
        var item=document.createElement('div');item.className='chat-item'+(chat.phone===selectedPhone?' active':'');item.onclick=function(){selectChat(chat)};
        var avatar=document.createElement('div');avatar.className='avatar';avatar.textContent=initials(chat.customer_name);
        var main=document.createElement('div');main.className='chat-main';
        var name=document.createElement('div');name.className='chat-name';name.textContent=chat.customer_name || chat.phone;
        var preview=document.createElement('div');preview.className='chat-preview';preview.textContent=(chat.last_direction==='out'?'You: ':'')+(chat.last_message || '');
        main.appendChild(name);main.appendChild(preview);
        var meta=document.createElement('div');var time=document.createElement('div');time.className='chat-time';time.textContent=formatListTime(chat.last_at);meta.appendChild(time);
        if(chat.checkout_status){var badge=document.createElement('span');badge.className='badge';badge.textContent=chat.checkout_status;meta.appendChild(badge)}
        item.appendChild(avatar);item.appendChild(main);item.appendChild(meta);chatList.appendChild(item);
      });
    }
    async function selectChat(chat){
      selectedPhone=String(chat.phone);selectedName=chat.customer_name || selectedPhone;app.classList.add('open-chat');
      document.getElementById('headerName').textContent=selectedName;document.getElementById('headerPhone').textContent='+'+selectedPhone;document.getElementById('headerAvatar').textContent=initials(selectedName);
      placeholder.style.display='none';messages.style.display='block';composer.style.display='flex';renderChats();await loadMessages(true);
    }
    async function loadMessages(scroll){
      if(!selectedPhone || loadingMessages) return; loadingMessages=true;
      try{
        var data=await api('/admin/api/messages?phone='+encodeURIComponent(selectedPhone));
        selectedName=data.customerName || selectedName;document.getElementById('headerName').textContent=selectedName;document.getElementById('headerAvatar').textContent=initials(selectedName);
        messages.innerHTML='';(data.messages || []).forEach(function(message){
          var row=document.createElement('div');row.className='row '+(message.direction==='out'?'out':'in');
          var bubble=document.createElement('div');bubble.className='bubble';var body=document.createElement('div');
          var raw=String(message.body || '');var imageMatch=raw.match(/^\[image:(https:\/\/[^\]]+)\]\s*/);
          if(imageMatch){var image=document.createElement('img');image.src=imageMatch[1];image.alt='Product image';image.loading='lazy';image.style.cssText='display:block;max-width:100%;max-height:320px;border-radius:7px;margin-bottom:7px;object-fit:cover';bubble.appendChild(image);raw=raw.slice(imageMatch[0].length)}
          body.textContent=raw;var time=document.createElement('span');time.className='msg-time';time.textContent=formatMessageTime(message.created_at)+(message.direction==='out'?'  Sent':'');bubble.appendChild(body);bubble.appendChild(time);row.appendChild(bubble);messages.appendChild(row);
        });
        if(scroll) messages.scrollTop=messages.scrollHeight;
      }catch(error){showStatus(error.message)}finally{loadingMessages=false}
    }
    composer.addEventListener('submit',async function(event){
      event.preventDefault();var body=messageInput.value.trim();if(!body || !selectedPhone) return;
      sendButton.disabled=true;
      try{await api('/admin/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:selectedPhone,body:body})});messageInput.value='';await loadMessages(true);await loadChats();showStatus('Message sent')}
      catch(error){showStatus(error.message)}finally{sendButton.disabled=false;messageInput.focus()}
    });
    messageInput.addEventListener('keydown',function(event){if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();composer.requestSubmit()}});
    search.addEventListener('input',renderChats);
    document.getElementById('back').onclick=function(){app.classList.remove('open-chat')};
    loadChats();setInterval(function(){loadChats();if(selectedPhone) loadMessages(false)},5000);
  </script>
</body>
</html>`;
}

async function saveConversation(
  env: Bindings,
  phone: string,
  direction: "in" | "out",
  body: string,
  messageId: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO conversations (phone, direction, body, whatsapp_message_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(phone, direction, body.slice(0, 4000), messageId)
      .run();
  } catch (error) {
    console.error("Failed to save conversation:", error);
  }
}

export default {
  fetch: app.fetch,
  scheduled(
    _controller: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(processDueAbandonedCheckouts(env));
  },
} satisfies ExportedHandler<Bindings>;
