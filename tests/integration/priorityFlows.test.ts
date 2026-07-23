import { describe, expect, it } from "vitest";
import {
  buildAbandonedTemplatePayload,
  extractOrderNumber,
  isAngryMessage,
  requiresHumanSupport,
} from "../../src/index";

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
      },
      {
        templateName: "abandoned_checkout_offer",
        language: "en_US",
        fallbackImage: "https://cdn.example.com/fallback.jpg",
      },
    ) as any;

    expect(payload.to).toBe("919876543210");
    expect(payload.template.name).toBe("abandoned_checkout_offer");
    expect(payload.template.components[0].parameters[0].image.link).toContain(
      "name-plate.jpg",
    );
    expect(payload.template.components[1].parameters.map((item: any) => item.text)).toEqual([
      "Asha",
      "Custom Name Plate",
      "₹799.00",
      "https://igstore.in/checkouts/recover/example",
    ]);
  });
});

