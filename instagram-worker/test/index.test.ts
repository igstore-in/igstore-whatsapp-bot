import { describe, expect, it } from "vitest";
import { extractCommentEvents, verifyMetaSignature } from "../src/index";

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

describe("Meta webhook security", () => {
  it("accepts a valid SHA-256 signature and rejects a changed body", async () => {
    const secret = "test-secret";
    const body = new TextEncoder().encode('{"object":"instagram"}');
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = `sha256=${toHex(await crypto.subtle.sign("HMAC", key, body))}`;
    expect(await verifyMetaSignature(body.buffer, signature, secret)).toBe(true);
    expect(await verifyMetaSignature(new TextEncoder().encode("changed").buffer, signature, secret)).toBe(false);
  });
});

describe("comment event extraction", () => {
  it("extracts every comment change instead of only the first entry", () => {
    const events = extractCommentEvents({
      object: "instagram",
      entry: [
        { id: "ig-1", time: 1, changes: [{ field: "comments", value: { id: "c-1", text: "link", media: { id: "r-1", media_product_type: "REELS" }, from: { id: "u-1", username: "one" } } }] },
        { id: "ig-1", time: 2, changes: [{ field: "comments", value: { id: "c-2", text: "price", media: { id: "r-2", media_product_type: "REELS" }, from: { id: "u-2", username: "two" } } }] }
      ]
    });
    expect(events.map((event) => event.commentId)).toEqual(["c-1", "c-2"]);
  });
});
