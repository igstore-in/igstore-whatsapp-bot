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
};

type BotUser = {
  language: Language;
  isNew: boolean;
};

type ProductSuggestion = {
  title: string;
  url: string;
  price?: string | number;
  price_min?: string | number;
  available?: boolean;
  image?: string;
  featured_image?: {
    url?: string;
    alt?: string;
  } | string;
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
      COALESCE((
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
    await replyAndLog(env, from, mediaReply(user.language));
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

  if (isOrderCommand(normalized) || normalized === "8") {
    await replyAndLog(env, from, orderStatusMessage(user.language));
    return;
  }

  if (normalized === "7" || isBudgetCommand(normalized)) {
    await replyAndLog(env, from, budgetMessage(user.language, shopDomain(env)));
    return;
  }

  const category = CATEGORIES[normalized];
  if (category) {
    const products = await searchProducts(env, category.query);
    await replyAndLog(
      env,
      from,
      categoryIntroMessage(user.language, category, shopDomain(env)),
    );

    if (products.length > 0) {
      await sendProductCards(env, from, user.language, products.slice(0, 3));
    } else {
      await replyAndLog(env, from, noCategoryProductsMessage(user.language));
    }
    return;
  }

  const products = await searchProducts(env, text);
  if (products.length > 0) {
    await replyAndLog(env, from, productSearchIntro(user.language));
    await sendProductCards(env, from, user.language, products.slice(0, 3));
    return;
  }

  await replyAndLog(env, from, noProductFoundMessage(user.language, text));
}

function getIncomingContent(message: any):
  | { kind: "text"; text: string; logText: string }
  | { kind: "media"; logText: string }
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
    return { kind: "media", logText: `[${message.type}]` };
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

function isBudgetCommand(value: string): boolean {
  return ["budget", "under", "below", "cheap gift", "gift under"].some((term) =>
    value.includes(term),
  );
}

async function searchProducts(env: Bindings, query: string): Promise<ProductSuggestion[]> {
  const cleanedQuery = query.trim().slice(0, 120);
  if (!cleanedQuery) return [];

  const url = new URL(`${shopDomain(env)}/search/suggest.json`);
  url.searchParams.set("q", cleanedQuery);
  url.searchParams.set("resources[type]", "product");
  url.searchParams.set("resources[limit]", "5");
  url.searchParams.set("resources[limit_scope]", "each");
  url.searchParams.set("resources[options][unavailable_products]", "hide");
  url.searchParams.set(
    "resources[options][fields]",
    "title,product_type,tag,variants.title,vendor",
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
    const products = data?.resources?.results?.products;
    return Array.isArray(products) ? products.slice(0, 5) : [];
  } catch (error) {
    console.error("Shopify product search error:", error);
    return [];
  }
}

function productSearchIntro(language: Language): string {
  if (language === "hi") return "आपके लिए ये प्रोडक्ट मिले 🎁";
  if (language === "en") return "Here are the matching products 🎁";
  return "Matching products / आपके लिए प्रोडक्ट 🎁";
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

  const browseLabel =
    language === "hi"
      ? "सभी प्रोडक्ट देखें"
      : language === "en"
        ? "Browse all products"
        : "Browse all products / सभी प्रोडक्ट देखें";

  return `${heading}
${browseLabel}:
${absoluteUrl(domain, category.collectionUrl)}

Top products with images:`;
}

function noCategoryProductsMessage(language: Language): string {
  if (language === "hi") return "इस कैटेगरी में अभी कोई प्रोडक्ट नहीं मिला। कृपया ऊपर दिया collection link खोलें।";
  if (language === "en") return "No products were found in this category right now. Please open the collection link above.";
  return "No products found right now. / अभी कोई प्रोडक्ट नहीं मिला। कृपया ऊपर दिया collection link खोलें।";
}

async function sendProductCards(
  env: Bindings,
  phone: string,
  language: Language,
  products: ProductSuggestion[],
): Promise<void> {
  for (const product of products) {
    const caption = productCaption(language, product, shopDomain(env));
    const imageUrl = productImageUrl(product);

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

  await replyAndLog(env, phone, productCardsFooter(language));
}

function productCaption(
  language: Language,
  product: ProductSuggestion,
  domain: string,
): string {
  const price = formatPrice(product.price_min ?? product.price);
  const url = absoluteUrl(domain, product.url);

  if (language === "hi") {
    return `*${product.title}*
${price ? `शुरुआती कीमत: ${price}
` : ""}ऑर्डर करें: ${url}`;
  }

  if (language === "en") {
    return `*${product.title}*
${price ? `Starting price: ${price}
` : ""}Order now: ${url}`;
  }

  return `*${product.title}*
${price ? `Starting price / शुरुआती कीमत: ${price}
` : ""}Order now / ऑर्डर करें: ${url}`;
}

function productImageUrl(product: ProductSuggestion): string | null {
  const featured = product.featured_image;
  const url =
    typeof featured === "string"
      ? featured
      : featured?.url ?? product.image;

  if (!url || !/^https:\/\//i.test(url)) return null;
  return url;
}

function productCardsFooter(language: Language): string {
  if (language === "hi") return "मुख्य मेनू के लिए *Menu* लिखें या किसी दूसरे प्रोडक्ट का नाम भेजें।";
  if (language === "en") return "Reply *Menu* for the main menu or send another product name.";
  return `Reply *Menu* for the main menu or send another product name.
मुख्य मेनू के लिए *Menu* लिखें।`;
}

function formatPrice(value: unknown): string | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return `₹${Number.isInteger(number) ? number.toFixed(0) : number.toFixed(2)}`;
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
    return "Please send your *order number* and *registered mobile number*. Our support team will check and share the latest status.";
  }

  if (language === "hi") {
    return "कृपया अपना *ऑर्डर नंबर* और *रजिस्टर्ड मोबाइल नंबर* भेजें। हमारी सपोर्ट टीम नवीनतम स्टेटस बताएगी।";
  }

  return "Please send your *order number* and *registered mobile number*.\nकृपया अपना *ऑर्डर नंबर* और *रजिस्टर्ड मोबाइल नंबर* भेजें।";
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
      await markCheckoutRecovered(env, String(payload?.checkout_token ?? ""));
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
      CREATE INDEX IF NOT EXISTS idx_abandoned_due
      ON abandoned_checkouts(status, due_at)
    `),
  ]);
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
