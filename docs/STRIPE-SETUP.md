# Stripe Setup

## Environment values

```env
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_...
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

The publishable key is reserved for future embedded payment UI. Current checkout creation is server-side.

## Webhook endpoint

Production endpoint:

```text
https://skieevents.com/api/stripe/webhook
```

Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

The route verifies the Stripe signature using the raw request body.

## Checkout metadata

Sessions include:

- order ID
- event ID
- user ID
- allocation ID where applicable

The local order is the source of line items and totals. The webhook uses the order ID to perform idempotent fulfilment.

## Test procedure

1. Set Stripe test keys.
2. Set `APP_MODE=live` only in a protected preview environment when testing real Stripe test mode.
3. Forward Stripe CLI events to the local webhook if testing locally.
4. Complete a test checkout.
5. Confirm one payment, the correct ticket quantity, entitlements and one email log.
6. Replay the same webhook and confirm no duplicate tickets are created.

## Refunds

The data model includes refund/cancellation states, but automated Stripe refund initiation is intentionally not enabled in this delivery. Add it only with a protected admin confirmation flow and webhook handling for refund/chargeback events.

## Alcohol-linked products

Describe drink passes as event entitlements and verify the venue/liquor-licence arrangement before selling them. Confirm Stripe account eligibility and product wording before live launch.
