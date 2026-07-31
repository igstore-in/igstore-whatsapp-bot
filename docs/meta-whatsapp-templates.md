# Meta WhatsApp abandoned-cart templates

Create and approve three **Marketing** templates in WhatsApp Manager. Names and language must match Worker configuration exactly.

## Shared setup

- Default language: `en_US`
- Header: image, supplied dynamically
- URL button index: `0`
- Recommended fixed URL base: `https://igstore.in/`
- The Worker passes only the same-origin recovery path/query as the dynamic suffix.
- If a recovery link is not representable as that suffix, configure `ABANDONED_FALLBACK_BODY_TEMPLATE` as a separately approved template whose final body variable is the complete URL.
- Include STOP wording in every template.

## Stage 1 — `ig_abandoned_cart_1`

Body variables:

1. Customer first name
2. Product title
3. Formatted cart total

```text
Hi {{1}} 👋

Your {{2}} is still waiting in your IG Store cart.
Cart total: {{3}}

Complete your order now 👇
Need help? Reply to this WhatsApp message.

Reply STOP to stop promotional reminders.
```

Buttons:

- Dynamic URL: `Complete Order`
- Optional quick reply: `Need Help`

Stage 1 has no discount variable and must not display “No discount”.

## Stage 2 — `ig_abandoned_cart_5`

Body variables:

1. Customer first name
2. Product title
3. Formatted cart total
4. Offer code, default `CART5`

```text
Hi {{1}} 😊

Your {{2}} is still saved in your cart.
Cart total: {{3}}

Complete your order today and get 5% OFF.
Code: {{4}}

Offer availability will be verified at checkout.
Reply STOP to stop reminders.
```

Dynamic URL button: `Get 5% OFF`

## Stage 3 — `ig_abandoned_cart_10`

Body variables:

1. Customer first name
2. Product title
3. Formatted cart total
4. Offer code, default `CART10`

```text
Hi {{1}} 🎁

This is the final reminder for your {{2}} order.
Cart total: {{3}}

Complete your order now with 10% OFF.
Code: {{4}}

This is the last automated reminder for this cart.
Reply STOP to stop messages.
```

Dynamic URL button: `Get 10% OFF`

## Approval verification

Before enabling automation:

1. Confirm the exact template names and `en_US` language.
2. Confirm header type is Image.
3. Confirm body variable counts are 3, 4, and 4.
4. Confirm the URL button is the first button (`index 0`).
5. Send a test for each template with a real IGStore.in recovery suffix.
6. Confirm CART5 and CART10 health before testing Stages 2 and 3.
