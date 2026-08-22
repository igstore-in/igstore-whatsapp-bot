import { describe, expect, it } from "vitest";
import {
  ABANDONED_NEW_ONLY_SINCE,
  adminInboxHtml,
  abandonedDestinationUrl,
  abandonedRecoveryButtonSuffix,
  allOrderVariants,
  buildAbandonedTemplatePayload,
  buildSupportOwnerAlert,
  buildWhatsAppFlowPayload,
  canonicalOrderStep,
  deliveryStatusRank,
  extractMessageStatuses,
  extractWhatsAppFlowSubmission,
  extractWhatsAppMessageId,
  hasWhatsAppMarketingConsent,
  IG_STORE_FLOW_ID,
  IG_STORE_FLOW_RESULT_SCREENS,
  configuredAbandonedNewOnlySince,
  isPostPurchaseReengagementEnabled,
  extractOrderNumber,
  isAngryMessage,
  nextAbandonedReminderAt,
  parseIndianMobile,
  requiresHumanSupport,
  supportOwnerAlertParameters,
  SHOPIFY_AUTOMATION_WEBHOOK_TOPICS,
  welcomeMessage,
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

    const finalPayload = buildAbandonedTemplatePayload(
      {
        checkout_token: "checkout-3",
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
        attempts: 2,
        created_at: Date.now(),
      },
      {
        templateName: "ig_abandoned_checkout_final_10off",
        language: "en",
        fallbackImage: "https://cdn.example.com/fallback.jpg",
        offerCode: "CART10",
      },
    ) as any;

    expect(finalPayload.template.name).toBe("ig_abandoned_checkout_final_10off");
    expect(finalPayload.template.components[2].parameters[0].text).toContain(
      "discount/CART10?redirect=",
    );
    expect(finalPayload.template.components[2].parameters[0].text).not.toContain("CART5");
  });

  it("spaces delayed abandoned reminders from the actual send time", () => {
    const sentAt = Date.parse("2026-08-10T10:00:00.000Z");
    expect(nextAbandonedReminderAt(1, sentAt)).toBe(sentAt + 12 * 60 * 60_000);
    expect(nextAbandonedReminderAt(2, sentAt)).toBe(sentAt + 24 * 60 * 60_000);
  });

  it("starts abandoned checkout targeting from the new-only rollout cutoff", () => {
    expect(ABANDONED_NEW_ONLY_SINCE).toBe("2026-08-22T08:06:01.120Z");
    expect(Date.parse(ABANDONED_NEW_ONLY_SINCE)).toBeGreaterThan(
      Date.parse("2026-08-22T08:00:00.000Z"),
    );
    expect(configuredAbandonedNewOnlySince("not-a-date")).toBe(
      ABANDONED_NEW_ONLY_SINCE,
    );
    expect(configuredAbandonedNewOnlySince("2026-08-23T00:00:00Z")).toBe(
      "2026-08-23T00:00:00.000Z",
    );
  });

  it("keeps the old 30-day customer campaign off unless explicitly enabled", () => {
    expect(isPostPurchaseReengagementEnabled()).toBe(false);
    expect(isPostPurchaseReengagementEnabled("false")).toBe(false);
    expect(isPostPurchaseReengagementEnabled("true")).toBe(true);
  });

  it("renders executable inbox JavaScript and a read-only refresh action", () => {
    const html = adminInboxHtml();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    expect(html).toContain("Inbox refreshed");
    expect(html).not.toContain("api('/admin/api/run-abandoned'");
  });

  it("extracts Meta read receipts and preserves WhatsApp status order", () => {
    const statuses = extractMessageStatuses({
      entry: [{
        changes: [{
          value: {
            statuses: [{
              id: "wamid.read-1",
              status: "read",
              recipient_id: "919876543210",
              timestamp: "1786500000",
            }],
          },
        }],
      }],
    });
    expect(statuses).toEqual([{
      id: "wamid.read-1",
      status: "read",
      recipientId: "919876543210",
      timestamp: 1786500000,
      errorCode: "",
      errorMessage: "",
    }]);
    expect(deliveryStatusRank("read")).toBeGreaterThan(deliveryStatusRank("delivered"));
    expect(deliveryStatusRank("delivered")).toBeGreaterThan(deliveryStatusRank("sent"));
  });

  it("records Meta failure details for delivery troubleshooting", () => {
    const [status] = extractMessageStatuses({
      entry: [{ changes: [{ value: { statuses: [{
        id: "wamid.failed-1",
        status: "failed",
        recipient_id: "919876543210",
        errors: [{ code: 131049, error_data: { details: "Message not delivered" } }],
      }] } }] }],
    });
    expect(status).toMatchObject({
      status: "failed",
      errorCode: "131049",
      errorMessage: "Message not delivered",
    });
  });

  it("uses Shopify WhatsApp consent, never SMS consent, for marketing reminders", () => {
    expect(hasWhatsAppMarketingConsent({
      whatsapp_marketing_consent_state: "SUBSCRIBED",
    })).toBe(true);
    expect(hasWhatsAppMarketingConsent({ buyer_accepts_sms_marketing: true })).toBe(false);
    expect(hasWhatsAppMarketingConsent({
      note_attributes: [{ name: "WhatsApp opt in", value: "yes" }],
    })).toBe(true);
  });

  it("subscribes to cart, checkout, purchase and fulfillment lifecycle webhooks", () => {
    expect(SHOPIFY_AUTOMATION_WEBHOOK_TOPICS).toEqual(expect.arrayContaining([
      "CARTS_CREATE",
      "CARTS_UPDATE",
      "CHECKOUTS_CREATE",
      "CHECKOUTS_UPDATE",
      "ORDERS_CREATE",
      "ORDERS_PAID",
      "ORDERS_UPDATED",
    ]));
  });

  it("builds the exact recovery destination and accepts a click-tracking token", () => {
    expect(abandonedDestinationUrl(
      "https://igstore.in/checkouts/recover/cart-token?key=secret",
      "CART5",
    )).toContain("https://igstore.in/discount/CART5?redirect=");
    const payload = buildAbandonedTemplatePayload(
      {
        checkout_token: "checkout-track",
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
        attempts: 0,
        created_at: Date.now(),
      },
      {
        templateName: "ig_abandoned_checkout_tracked_r1",
        language: "en",
        fallbackImage: "https://cdn.example.com/fallback.jpg",
        buttonSuffix: "0123456789abcdef0123456789abcdef",
      },
    ) as any;
    expect(payload.template.components[2].parameters[0].text)
      .toBe("0123456789abcdef0123456789abcdef");
  });

  it("stores the outgoing Meta message id used by blue ticks", () => {
    expect(extractWhatsAppMessageId(JSON.stringify({ messages: [{ id: "wamid.123" }] })))
      .toBe("wamid.123");
    expect(extractWhatsAppMessageId("not-json")).toBeNull();
  });

  it("parses the published IG Store WhatsApp Flow response", () => {
    expect(IG_STORE_FLOW_ID).toBe("1068611185637149");
    expect(extractWhatsAppFlowSubmission({
      type: "interactive",
      interactive: {
        type: "nfm_reply",
        nfm_reply: {
          response_json: JSON.stringify({
            screen: "IG_STORE_HELP",
            flow_token: "customer-session-1",
            request_type: "track",
            product_category: "name_plate",
            customer_name: "Asha Sharma",
            mobile_number: "+91 98765 43210",
            order_number: "#4897",
            details: "Please share current delivery status",
          }),
        },
      },
    })).toEqual({
      requestType: "track",
      productCategory: "name_plate",
      customerName: "Asha Sharma",
      mobileNumber: "+91 98765 43210",
      orderNumber: "#4897",
      details: "Please share current delivery status",
      flowToken: "customer-session-1",
    });
  });

  it("accepts each customer-specific Flow result screen", () => {
    expect(IG_STORE_FLOW_RESULT_SCREENS).toContain("IG_STORE_SHOP");
    expect(IG_STORE_FLOW_RESULT_SCREENS).toContain("IG_STORE_TRACK");
    expect(IG_STORE_FLOW_RESULT_SCREENS).toContain("IG_STORE_SUPPORT");
    expect(extractWhatsAppFlowSubmission({
      type: "interactive",
      interactive: {
        nfm_reply: {
          response_json: JSON.stringify({
            screen: "IG_STORE_SUPPORT",
            request_type: "support",
            customer_name: "Asha",
            mobile_number: "9876543210",
            details: "Product arrived damaged",
          }),
        },
      },
    })?.requestType).toBe("support");
  });

  it("builds the support alert for the IG Store owner", () => {
    const alert = buildSupportOwnerAlert("919876543210", "whatsapp_flow_customer_support", {
      requestType: "support",
      customerName: "Asha Sharma",
      mobileNumber: "9876543210",
      orderNumber: "#4897",
      details: "Product arrived damaged",
    });
    expect(alert).toContain("IG Store customer needs support");
    expect(alert).toContain("Customer WhatsApp: +919876543210");
    expect(alert).toContain("Order: #4897");
    expect(alert).toContain("Product arrived damaged");
    expect(supportOwnerAlertParameters("919876543210", "whatsapp_flow_customer_support", {
      requestType: "support",
      customerName: "Asha Sharma",
      orderNumber: "#4897",
      details: "Product arrived damaged",
    })).toEqual([
      "Asha Sharma",
      "+919876543210",
      "Customer support",
      "#4897",
      "Product arrived damaged",
    ]);
  });

  it("rejects malformed or unrelated Flow responses", () => {
    expect(extractWhatsAppFlowSubmission({
      type: "interactive",
      interactive: { nfm_reply: { response_json: "not-json" } },
    })).toBeNull();
    expect(extractWhatsAppFlowSubmission({
      type: "interactive",
      interactive: {
        nfm_reply: {
          response_json: JSON.stringify({
            screen: "ANOTHER_FLOW",
            request_type: "shop",
          }),
        },
      },
    })).toBeNull();
  });

  it("builds the WhatsApp button that opens the published Flow", () => {
    const payload = buildWhatsAppFlowPayload(
      "919876543210",
      "igstore_customer_session_1",
    ) as any;
    expect(payload).toMatchObject({
      messaging_product: "whatsapp",
      to: "919876543210",
      type: "interactive",
      interactive: {
        type: "flow",
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: "igstore_customer_session_1",
            flow_id: "1068611185637149",
            flow_cta: "Open IG Store",
            flow_action: "navigate",
            flow_action_payload: { screen: "IG_STORE_HELP" },
          },
        },
      },
    });
    expect(payload.interactive.body.text).not.toContain("Main Menu");
    expect(payload.interactive.action.parameters.flow_cta).toBe("Open IG Store");
  });

  it("does not embed the old numbered menu in the welcome message", () => {
    const welcome = welcomeMessage("both");
    expect(welcome).toContain("Open IG Store");
    expect(welcome).not.toContain("Main Menu");
    expect(welcome).not.toContain("1. Personalized Gifts");
  });
});



