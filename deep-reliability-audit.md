# Deep production reliability audit

This release hardens production operations beyond the post-checkout capture incident.

## Fixed

- Resend API idempotency is passed through the supported SDK option rather than a custom email header.
- Live notification channels fail visibly instead of silently using local dry-run providers.
- Ambiguous Twilio network outcomes stop automatic retries to reduce duplicate SMS risk.
- Notification batches claim channels fairly so email backlogs cannot starve SMS, in-app, or WhatsApp work.
- Payment and notification rows with expired or missing leases are reclaimed safely.
- A durable production worker heartbeat detects when the five-minute worker has stopped running.
- New post-checkout authorisations fail closed while payment operations are unhealthy.
- Production health includes paid-but-unfulfilled reservations, orphan Stripe sessions, webhook failures, overdue lifecycle rows, stalled queues, and provider readiness.
- Invalid aggregate health responses fail closed rather than being converted into a false healthy zero.

## Safety

- Stripe state is reconciled before capture or cancellation.
- Existing idempotency and atomic fulfilment remain authoritative.
- No customer, order, payment, Stripe, or notification identifiers are exposed by health reporting.
- Direct checkout remains available when only post-checkout automation is unavailable.

Validation is enforced through lint, TypeScript, the full regression suite, the production build, migration checks and Vercel Preview before merge.
