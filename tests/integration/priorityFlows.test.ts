import { describe, expect, it } from "vitest";
import {
  abandonedRecoveryButtonSuffix,
  allOrderVariants,
  buildAbandonedTemplatePayload,
  canonicalOrderStep,
  extractOrderNumber,
  isAngryMessage,
  nextAbandonedReminderAt,
  parseIndianMobile,
  requiresHumanSupport,
} from "../../src/index";
import { repairMojibake } from "../../src/entry";

describe("priority WhatsApp flows", () => {
  it.each([
    ["4510", "4510"],
    ["#4510", "4510"],
    ["IG4510", "4510"],
    ["IG-4510", "4510"],
    ["Order number #4510", "4510"],
  ])("extracts Shopify order number from %s", (input, expected) => {
    expect(extractOrderNumber(input)).toBe(expected);
  });

  it("keeps unrelated product numbers out of tracking", () => {
    expect(extractOrderNumber("budget 499")).toBe("499");
    expect(extractOrderNumber("hello")).toBeNull();
  });

  it("detects customer-requested and priority human handoffs", () => {
    expect(requiresHumanSupport("human agent please")).toBe(true);
    expect(requiresHumanSupport("payment deducted but order not confirmed")).toBe(true);
    expect(requiresHumanSupport("bulk order quotation")).toBe(true);
    expect(isAngryMessage("this is a fraud, consumer court complaint")).toBe(true);
    expect(requiresHumanSupport("show birthday gifts")).toBe(false);
  });

  it("accepts Indian mobile numbers and rejects invalid customer numbers", () => {
    expect(parseIndianMobile("+91 95876 66693")).toBe("9587666693");
    expect(parseIndianMobile("9587666693")).toBe("9587666693");
    expect(parseIndianMobile("5587666693")).toBeNull();
    expect(parseIndianMobile("958766669")).toBeNull();
  });

  it("resumes legacy wrapper contexts in the consolidated order flow", () => {
    expect(canonicalOrderStep("wa_mobile")).toBe("mobile");
    expect(canonicalOrderStep("vx_confirm")).toBe("confirm");
    expect(canonicalOrderStep("quantity")).toBe("quantity");
  });

  it("keeps unavailable variants selectable and creates a manual fallback", () => {
    const unavailable = allOrderVariants({
      title: "Name Plate",
      url: "/products/name-plate",
      variants: [{ id: "123", title: "18 Inch", price: 399, available: false }],
    });
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({ id: "123", available: false });

    const fallback = allOrderVariants({
      title: "Custom Gift",
      url: "/products/custom-gift",
      price: 299,
    });
    expect(fallback[0]).toMatchObject({ title: "Team confirmation", available: false });
  });

  it("repairs outgoing Hindi, rupee and emoji mojibake without damaging plain text", () => {
    expect(repairMojibake("â‚¹229")).toBe("₹229");
    expect(repairMojibake("ðŸ“¦ Order")).toBe("📦 Order");
    expect(repairMojibake("Plain order text")).toBe("Plain order text");
  });

  it("builds the approved abandoned-checkout template payload", () => {
    const payload = buildAbandonedTemplatePayload(
      {
        checkout_token: "checkout-1",
        phone: "919876543210",
        customer_name: "Asha",
        product_title: "Custom Name Plate",
        product_image: "https://cdn.example.com/name-plate.jpg",
        total_price: 799,
        currency: "INR",
        recovery_url: "https://igstore.in/checkouts/recover/example",
        consent: 1,
        status: "pending",
        due_at: Date.now(),
        attempts: 0,
        created_at: Date.now(),
      },
      {
        templateName: "ig_abandoned_checkout_r1_image",
        language: "en",
        fallbackImage: "https://cdn.example.com/fallback.jpg",
      },
    ) as any;

    expect(payload.to).toBe("919876543210");
    expect(payload.template.name).toBe("ig_abandoned_checkout_r1_image");
    expect(payload.template.language.code).toBe("en");
    expect(payload.template.components[0].parameters[0].image.link).toContain(
      "name-plate.jpg",
    );
    expect(payload.template.components[1].parameters.map((item: any) => item.text)).toEqual([
      "Custom Name Plate",
      "₹799.00",
    ]);
    expect(payload.template.components[2]).toMatchObject({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: "checkouts/recover/example" }],
    });
  });

  it("matches approved offer-template variables and recovery button suffix", () => {
    expect(
      abandonedRecoveryButtonSuffix(
        "https://igstore.in/checkouts/recover/cart-token?key=secret",
      ),
    ).toBe("checkouts/recover/cart-token?key=secret");

    const payload = buildAbandonedTemplatePayload(
      {
        checkout_token: "checkout-2",
        phone: "919876543210",
        customer_name: "Asha",
        product_title: "Name Plate",
        product_image: null,
        total_price: 499,
        currency: "INR",
        recovery_url: "https://igstore.in/checkouts/recover/cart-token",
        consent: 1,
        status: "pending",
        due_at: Date.now(),
        attempts: 1,
        created_at: Date.now(),
      },
      {
        templateName: "ig_abandoned_cart_5",
        language: "en",
        fallbackImage: "https://cdn.example.com/fallback.jpg",
        offerCode: "CART5",
      },
    ) as any;

    expect(payload.template.components[1].parameters.map((item: any) => item.text)).toEqual([
      "Name Plate",
      "₹499.00",
    ]);
    expect(payload.template.components[2].parameters[0].text).toContain(
      "discount/CART5?redirect=",
    );
    expect(payload.template.components[2].parameters[0].text).not.toContain("CART10");
  });

  it("spaces delayed abandoned reminders from the actual send time", () => {
    const sentAt = Date.parse("2026-08-10T10:00:00.000Z");
    expect(nextAbandonedReminderAt(1, sentAt)).toBe(sentAt + 12 * 60 * 60_000);
    expect(nextAbandonedReminderAt(2, sentAt)).toBe(sentAt + 24 * 60 * 60_000);
  });
});


