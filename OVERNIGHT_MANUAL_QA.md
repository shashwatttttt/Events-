# Overnight Manual QA Handoff

Date: 22 July 2026

## Automated/local browser evidence completed

- Permanent headless Edge smoke: public events, protected account and checkout redirects, safe relative `next`, and external return-path rejection.
- Public media at 360, 390, 430, 768 and 1440 CSS pixels; final 360/390 device-scaled renders showed wrapped hero copy, bounded gallery cards, mobile navigation and no visible horizontal overflow.
- Public events at desktop width, admin login, and protected checkout/login presentation.
- Unit/route/source coverage for event state, staff, CMS stale writes, repair, rate limits, notifications, multi-ticket QR, promos, uploads and video attributes.

The in-app browser skill's required interactive runtime was unavailable. Installed local Edge was used without adding a browser dependency. No credentials were read or entered.

## Human staging checklist

### Event, auth and staff

- At 360/390/430/768/1440, exercise draft, preview, published, hidden, private-link, password, coming-soon, closed, archived and cancelled events from listing, guessed detail, apply and both checkout paths.
- Sign in through protected account/direct/allocation checkout; confirm safe return to the exact relative path and rejection of external, encoded, backslash and control-character variants.
- In two admin sessions, save different CMS/media changes from the same version; verify one save, one 409 message, preserved unsaved text and reload-latest equality.
- Create scanner-only and door-staff event assignments with active/expired windows. Confirm wrong-event redaction, scanner product-redemption denial and no CMS/payment-recovery access.
- Use a synthetic partial signup to confirm idempotent profile/customer repair, role preservation and one repair audit event.
- Trigger each protected public/auth route limit and verify stable 429 plus `Retry-After` without PII in logs.

### Notifications and QR tickets

- Preview every HTML/text template in desktop/mobile and representative email clients.
- Fulfil a synthetic order with multiple named tickets and add-ons; verify exactly one labelled QR per valid ticket, correct event/order/purchaser details and fallback/policy links.
- Refund/suspend a ticket and confirm it is not presented as valid on resend.
- Exercise local test-send, status filters, attempt history, eligible retry and pending cancellation as admin; confirm non-admin denial and redaction.
- With approved Resend staging configuration, send one test message and run one bounded worker batch; inspect idempotency, safe attempt codes and no fulfilment rollback.

### Promo codes

- Create percentage and fixed-AUD codes with every restriction/window/limit, then exercise valid and rejected customer paths with mixed ticket/add-on baskets.
- Confirm subtotal, discount and final total match reservation/order/provider snapshots and GST presentation under the current inclusive pricing policy.
- Race the last redemption and last discounted unit from two browsers; only one checkout may proceed.
- Simulate abandoned/failed Session creation, payment replay and full refund reporting; confirm release/finalization policy and no restored refund capacity.

### Media

- Upload each supported image/video format to staging; inspect progress, cancel, retry, preview, poster selection, replace, reorder, focal position and publish/unpublish.
- Attempt SVG, MIME mismatch, oversized and malformed/traversal filenames; confirm safe errors and no orphaned public object.
- Remove references and delete safely; confirm referenced objects cannot be deleted and aged orphans can be cleaned.
- On iOS Safari, Android Chrome and desktop browsers, verify muted loop, inline playback, poster/error fallback, native keyboard controls, off-screen pause, reduced-motion/data-saver pause, aspect ratio and no layout shift/overflow.

### Operational sign-off

- Inspect server logs for correlation IDs and confirm there are no authorization headers, tokens, QR values, full recipient addresses, message bodies, provider payloads or customer records.
- Record database, security, payment, email, operator and rollback owner approvals before any production promotion.
