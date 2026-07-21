import { Hono } from "hono";

type Language = "en" | "hi" | "both";

type Bindings = {
  DB: D1Database;
  META_VERIFY_TOKEN: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  META_GRAPH_VERSION?: string;
  SHOP_DOMAIN?: string;
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
};

type Category = {
  query: string;
  collectionUrl: string;
  labelEn: string;
  labelHi: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const DEFAULT_SHOP_DOMAIN = "https://igstore.in";
const SUPPORT_PHONE = "+91 95876 66693";

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
      messages.push(...valueMessages);
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
      categoryMessage(user.language, category, products, shopDomain(env)),
    );
    return;
  }

  const products = await searchProducts(env, text);
  if (products.length > 0) {
    await replyAndLog(env, from, productResultsMessage(user.language, products, shopDomain(env)));
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

function productResultsMessage(
  language: Language,
  products: ProductSuggestion[],
  domain: string,
): string {
  const lines = products.slice(0, 5).map((product, index) => {
    const price = formatPrice(product.price_min ?? product.price);
    const url = absoluteUrl(domain, product.url);
    return `${index + 1}. *${product.title}*\n${price ? `Starting price: ${price}\n` : ""}${url}`;
  });

  if (language === "hi") {
    return `आपके लिए ये प्रोडक्ट मिले 🎁\n\n${lines.join(
      "\n\n",
    )}\n\nऑर्डर करने के लिए प्रोडक्ट लिंक खोलें। मुख्य मेनू के लिए *Menu* लिखें।`;
  }

  if (language === "en") {
    return `Here are the matching products 🎁\n\n${lines.join(
      "\n\n",
    )}\n\nOpen a product link to order. Reply *Menu* for the main menu.`;
  }

  return `Matching products / आपके लिए प्रोडक्ट 🎁\n\n${lines.join(
    "\n\n",
  )}\n\nOpen the product link to order.\nऑर्डर के लिए प्रोडक्ट लिंक खोलें।\n\nReply *Menu* for the main menu.`;
}

function categoryMessage(
  language: Language,
  category: Category,
  products: ProductSuggestion[],
  domain: string,
): string {
  const heading =
    language === "en"
      ? `*${category.labelEn}*`
      : language === "hi"
        ? `*${category.labelHi}*`
        : `*${category.labelEn} / ${category.labelHi}*`;

  const results = products.length
    ? `\n\n${productResultsMessage(language, products.slice(0, 3), domain)}`
    : "";

  const browseLabel =
    language === "hi"
      ? "सभी प्रोडक्ट देखें"
      : language === "en"
        ? "Browse all products"
        : "Browse all products / सभी प्रोडक्ट देखें";

  return `${heading}\n${browseLabel}:\n${absoluteUrl(domain, category.collectionUrl)}${results}`;
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

export default app;
