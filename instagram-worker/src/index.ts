export interface Env {
  META_VERIFY_TOKEN: string;
  META_ACCESS_TOKEN: string;
  META_GRAPH_VERSION?: string;
  IG_USER_ID?: string;
}

type ReelConfig = {
  keywords: string[];
  publicReply: string;
  privateReply: string;
};

const REEL_CONFIG: Record<string, ReelConfig> = {
  default: {
    keywords: ["link", "price", "buy", "order", "details", "custom", "dm"],
    publicReply: "Thank you ❤️ Details aapke DM me bhej di hain.",
    privateReply:
      "Hi {{username}} 👋\nComment karne ke liye thank you!\n\n🛍️ IG Store: https://igstore.in/\n📩 Custom order ke liye isi message ka reply karein.\n🚚 Pan-India delivery available.",
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function text(data: string, status = 200): Response {
  return new Response(data, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function render(template: string, username: string): string {
  return template.replaceAll("{{username}}", username || "there");
}

async function graphPost(env: Env, path: string, body: unknown): Promise<void> {
  const version = env.META_GRAPH_VERSION || "v23.0";
  const response = await fetch(`https://graph.facebook.com/${version}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Meta API ${response.status}: ${message}`);
  }
}

async function processComment(env: Env, entry: any, change: any): Promise<void> {
  if (change?.field !== "comments") return;

  const value = change?.value || {};
  const media = value?.media || {};
  const commentId = String(value?.id || "");
  const commenterId = String(value?.from?.id || "");
  const commenterUsername = String(value?.from?.username || "");
  const commentText = String(value?.text || "").toLowerCase();
  const mediaId = String(media?.id || "");
  const mediaProductType = String(media?.media_product_type || "");
  const igUserId = String(entry?.id || env.IG_USER_ID || "");

  if (!commentId || !igUserId) return;
  if (mediaProductType !== "REELS") return;
  if (commenterId && commenterId === igUserId) return;

  const config = REEL_CONFIG[mediaId] || REEL_CONFIG.default;
  const matched = config.keywords.length === 0 || config.keywords.some((word) => commentText.includes(word.toLowerCase()));
  if (!matched) return;

  await graphPost(env, `${commentId}/replies`, {
    message: render(config.publicReply, commenterUsername),
  });

  await graphPost(env, `${igUserId}/messages`, {
    recipient: { comment_id: commentId },
    message: { text: render(config.privateReply, commenterUsername) },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "igstore-instagram-comment-bot" });
    }

    if (url.pathname !== "/instagram-comments") {
      return text("Not found", 404);
    }

    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const verifyToken = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge") || "";

      if (mode === "subscribe" && verifyToken === env.META_VERIFY_TOKEN) {
        return text(challenge, 200);
      }
      return text("Forbidden", 403);
    }

    if (request.method !== "POST") {
      return text("Method not allowed", 405);
    }

    let payload: any;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    for (const entry of payload?.entry || []) {
      for (const change of entry?.changes || []) {
        ctx.waitUntil(
          processComment(env, entry, change).catch((error) => {
            console.error("Instagram comment processing failed", error);
          }),
        );
      }
    }

    return json({ received: true });
  },
};
