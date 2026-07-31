# Shopify WhatsApp consent checkbox

The bot accepts abandoned-cart marketing only when the cart or checkout explicitly contains `WhatsApp Opt In = Yes`, `whatsapp_opt_in = true`, or the customer has sent `START` in WhatsApp. Shopify SMS marketing consent is deliberately ignored.

## Add the snippet

1. In Shopify Admin, open **Online Store → Themes → … → Edit code**.
2. Create `snippets/ig-whatsapp-consent.liquid` and copy the repository file with the same name.
3. Find the active cart form. Depending on the theme, it is usually in `sections/main-cart-footer.liquid`, `sections/main-cart-items.liquid`, or a cart-drawer snippet.
4. Inside the cart `<form>`, immediately before the checkout button, add:

```liquid
{% render 'ig-whatsapp-consent' %}
```

5. Repeat the placement in the cart drawer if the theme has a separate drawer checkout button.
6. Save, preview, and verify that the checkbox is unchecked on every fresh cart.

The checkbox records these cart attributes only after selection:

- `WhatsApp Opt In = Yes`
- `WhatsApp Opt In Source = cart_checkbox`
- `WhatsApp Opt In At = <ISO-8601 timestamp>`

If the customer leaves it unchecked, checkout continues normally and no WhatsApp marketing consent is stored.

## Verification

Place a test checkout with the box unchecked and confirm that no abandoned reminder is queued. Repeat with the box checked and confirm that the custom attributes appear on the abandoned checkout and the first reminder becomes due five minutes after abandonment.
