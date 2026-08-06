export type ReelConfig = {
  enabled: boolean;
  keywords: string[];
  publicReply: string;
  privateReply: string;
};

// Add a Reel media ID as a key to override the default message for that Reel.
// No credentials belong in this file.
export const REEL_CONFIG: Record<string, ReelConfig> = {
  // "REEL_MEDIA_ID": {
  //   enabled: true,
  //   keywords: ["link", "price"],
  //   publicReply: "Thank you ❤️ Details aapke DM mein bhej di hain.",
  //   privateReply: "Hi {{username}} 👋\nYeh raha is Reel ka link: https://igstore.in/"
  // },
  default: {
    enabled: true,
    keywords: ["link", "price", "buy", "order", "details", "custom", "dm"],
    publicReply: "Thank you ❤️ Details aapke DM mein bhej di hain.",
    privateReply:
      "Hi {{username}} 👋\nComment karne ke liye thank you!\n\n🛍️ IG Store: https://igstore.in/\n📩 Custom order ke liye isi message ka reply karein.\n🚚 Pan-India delivery available."
  }
};

export function configFor(mediaId: string): ReelConfig | undefined {
  const config = REEL_CONFIG[mediaId] ?? REEL_CONFIG.default;
  return config?.enabled ? config : undefined;
}
