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
  //   publicReply: "Thank you! Details aapke DM mein bhej di hain.",
  //   privateReply: "Hi {{username}}\nYeh raha is Reel ka link: https://igstore.in/"
  // },
  default: {
    enabled: true,
    // Empty means every new top-level comment on a Reel without its own rule.
    keywords: [],
    publicReply: "Thank you! Details aapke DM mein bhej di hain.",
    privateReply:
      "Hi {{username}},\nComment karne ke liye thank you!\n\n[ IGStore.in ] https://igstore.in/\nCustom order ke liye isi message ka reply karein.\nPan-India delivery available."
  }
};

export function configFor(mediaId: string): ReelConfig | undefined {
  const config = REEL_CONFIG[mediaId] ?? REEL_CONFIG.default;
  return config?.enabled ? config : undefined;
}

export function defaultConfig(): ReelConfig {
  return REEL_CONFIG.default;
}

