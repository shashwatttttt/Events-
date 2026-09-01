# Test Plan

## Automated verification

```bash
npm run lint
npm run typecheck
npm run build
npm audit --omit=dev
```

## Functional test-mode checklist

### Authentication

- customer signup creates one profile
- duplicate email rejected
- invalid login rejected
- authenticated account loads
- admin login rejected for customer
- protected routes redirect unauthenticated users

### Applications

- required fields enforced
- age/terms/privacy/entry consent required
- duplicate active application blocked
- consent records include policy version/timestamp
- pending application appears in admin
- approve creates one allocation
- waitlist/rejection email appears once in outbox

### Checkout and limits

- default allocation max is 2
- customer-specific max is enforced server-side
- duplicate pending checkout cannot exceed allocation
- ticket-type/public capacity enforced
- product stock and per-customer limits enforced
- pending order reserves inventory and expires
- test checkout belongs to logged-in customer

### Fulfilment

- completion creates payment
- correct number of unique tickets created
- replay creates no duplicate tickets
- drink pass creates entitlement units
- ticket email appears once

### QR/check-in

- valid QR accepted
- wrong event rejected
- duplicate scan warned
- cancelled/refunded/expired rejected
- attendee search works
- manual check-in writes audit record
- entitlement redemption reduces balance once

### Admin and data

- customer tags/notes are private
- sponsor export contains consented customers only
- admin APIs reject unauthorised roles
- media upload rejects unsupported/oversized files
- event/product changes persist
- email/audit logs display

### Responsive/accessibility

Test widths near 360, 390, 768, 1024, 1440 and large displays. Test keyboard navigation, labels, focus visibility, form errors, reduced motion, image alternatives and camera permission failure.

## External integration tests

Run after keys are connected:

- Supabase email confirmation callback
- RLS ownership checks
- Stripe test payment/webhook replay
- Resend domain delivery
- Vercel preview and production env separation
- Namecheap DNS and HTTPS
