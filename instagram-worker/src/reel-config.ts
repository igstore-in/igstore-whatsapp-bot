Exit code: 0
Wall time: 0.9 seconds
Output:
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
  //   publicReply: "Thank you â¤ï¸ Details aapke DM mein bhej di hain.",
  //   privateReply: "Hi {{username}} ðŸ‘‹\nYeh raha is Reel ka link: https://igstore.in/"
  // },
  default: {
    enabled: true,
    keywords: ["link", "price", "buy", "order", "details", "custom", "dm"],
    publicReply: "Thank you â¤ï¸ Details aapke DM mein bhej di hain.",
    privateReply:
      "Hi {{username}} ðŸ‘‹\nComment karne ke liye thank you!\n\nðŸ›ï¸ IG Store: https://igstore.in/\nðŸ“© Custom order ke liye isi message ka reply karein.\nðŸšš Pan-India delivery available."
  }
};

export function configFor(mediaId: string): ReelConfig | undefined {
  const config = REEL_CONFIG[mediaId] ?? REEL_CONFIG.default;
  return config?.enabled ? config : undefined;
}

export function defaultConfig(): ReelConfig {
  return REEL_CONFIG.default;
}

