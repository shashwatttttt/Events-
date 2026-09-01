# SKIE EVENTS Manual Production Checklist

This checklist is for a later approved staging/production change window. It does not authorize the current session to contact production services.

## Hard launch gate

- [ ] All Phase 2 staging migration/RLS/concurrency drills in `MIGRATION_RUNBOOK.md` pass.
- [ ] All required payment, security, notification, promo and media suites exist and pass (fixture-only placeholder suites do not count).
- [ ] `npm run verify`, `npm audit --omit=dev`, and `git diff --check` pass on the release candidate.
- [ ] No open P0/P1 finding; every claimed fix has regression evidence.
- [ ] Named incident owner, database owner, payment owner and rollback owner approve launch.
- [ ] Backup restore, recovery time and reconciliation drills are complete.

## Phase 3 local evidence (complete, not production sign-off)

- [x] Complete baseline restarted and passed from branch/checkpoint through dependency audit and diff check.
- [x] Canonical state and Melbourne/DST unit tests pass.
- [x] Protected account/checkout redirects and safe return paths pass in local Edge.
- [x] Event staff assignment windows, capability separation, RLS/grants, audit, wrong-event redaction, and concurrent door behavior pass locally.
- [x] CMS stale-save CAS and event-close/checkout lock races pass on independent PostgreSQL connections.
- [x] Idempotent customer repair, shared rate-limit final slot, strict request contracts, safe errors, and correlation IDs have permanent tests.

## Controlled Stripe test checklist

- [ ] Stripe test-mode keys and webhook secret prefixes are validated without logging values.
- [ ] Subscribe to: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `refund.created`, `refund.updated`, `charge.dispute.created`, `charge.dispute.closed`, `payment_intent.payment_failed`, and `payment_intent.canceled`.
- [ ] Complete one low-value test payment and prove amount/currency/order/Session/PaymentIntent reconciliation.
- [ ] Replay the webhook and prove no duplicate payment/ticket/entitlement/email.
- [ ] Inject fulfilment failure, recover it, and prove payment evidence survives.
- [ ] Exercise expiry, cancellation race, full refund, partial refund/manual review and dispute suspend/restore/invalidate.
- [ ] Confirm live environment never emits a fake checkout URL.

## Phase 4 local evidence (complete, not provider sign-off)

- [x] Branded HTML/plain-text templates and multi-ticket/add-on/QR rendering have permanent tests.
- [x] Idempotent enqueue, concurrent claim, bounded retry, terminal failure, dry-run/local delivery, safe error retention and admin authorization pass locally.
- [x] Payment fulfilment remains committed when notification enqueue/delivery fails.

## Resend staging setup

- [ ] Verify sending domain, from/reply-to addresses and support mailbox.
- [ ] Configure credentials server-side only; no `NEXT_PUBLIC_` credential.
- [ ] Verify CID logo/QR support, one multi-ticket order email, plain text, retry/outbox idempotency, retention/redaction and admin test recipient controls.

## Twilio/SMS setup (not implemented yet)

- [ ] Configure `SMS_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_SENDER_ID`, `TWILIO_STATUS_CALLBACK_SECRET`, and `CRON_SECRET` only after implementation/review.
- [ ] Validate callback signatures and replay, use approved test recipients, and prove no raw ticket token/QR enters SMS.
- [ ] Verify transactional vs marketing consent, unsubscribe link, opt-out and event-only recipient scope.
- [ ] Confirm Australia/Melbourne 24-hour/3-hour scheduling through DST boundaries.

## Notification cron staging setup (route implemented; external schedule not enabled)

- [ ] Create only the reviewed server-to-server scheduled route.
- [ ] Protect it with the approved cron authentication/`CRON_SECRET`.
- [ ] Confirm atomic claims, bounded retries and test-mode dry-run outbox before enabling the schedule.

## Phase 6 local evidence (complete, not provider sign-off)

- [x] Percentage/fixed AUD, rounding/caps, restrictions, Melbourne windows, case, per-customer and first-purchase rules pass locally.
- [x] Concurrent final redemption/unit, failure release, paid finalization, replay, refund reporting and tampering tests pass locally.

## Promo controlled staging checklist

- [ ] Test percentage/fixed AUD calculations, restrictions, minimum/first-purchase rules and case-insensitive uniqueness.
- [ ] Prove concurrent final redemption and final discounted-ticket-unit claims.
- [ ] Prove Session failure/expiry release and paid finalization.
- [ ] Verify refund reporting policy does not silently restore inventory.

## Phase 7 local evidence (complete, not hosted Storage sign-off)

- [x] Authorization/origin, signature/MIME/size/name/path controls and service-only Storage grants pass locally.
- [x] Progress/cancel/retry, poster/metadata, CAS conflict, orphan/reference-aware deletion and public playback fallbacks have permanent tests.
- [x] Local Edge renders at 360/390/430/768/1440 show bounded media/gallery presentation with no visible horizontal overflow.

## Media staging checklist

- [ ] Admin/origin checks, direct-upload design, separate size limits and magic-byte validation pass.
- [ ] SVG, MIME mismatch, traversal and oversized uploads are rejected.
- [ ] Progress/cancel/retry/orphan cleanup/reference deletion are verified.
- [ ] Video loop/muted/playsInline/poster/offscreen pause/reduced-motion/data-saving/mobile overflow fallbacks pass.

## Door-entry recovery drill

- [ ] Event assignments restrict scanner/door staff to their events.
- [ ] Wrong-event scan/search/redemption exposes no unrelated email or entitlement.
- [ ] Duplicate scan is atomic under concurrency.
- [ ] Refunded/suspended tickets and entitlements reject entry/redemption.
- [ ] Document offline/no-network procedure, escalation contact and reconciliation after connectivity returns.

## Exact go-live containment

- [ ] Close sales, inventory active Sessions, apply migrations, deploy compatible reads then writes, enable recovery/webhooks, reconcile, run one controlled test, obtain sign-off, then reopen.
- [ ] Rollback closes sales first, preserves webhook/payment evidence, reconciles Sessions, rolls back app traffic only to a schema-compatible revision, and never drops transaction history.

## Phase 3 staging promotion gate

- [ ] Use a separately approved isolated staging project with synthetic identities; record reviewed migration hashes and do not use production customer/payment data.
- [ ] Apply all nine migrations in `MIGRATION_RUNBOOK.md` order and repeat Phase 2-7 catalog, RLS, grant, RPC, and all 16 concurrency cases.
- [ ] Rehearse two-operator stale CMS conflict/reload without lost edits.
- [ ] Assign, expire, and revoke scanner/door access for two synthetic events; verify wrong-event search/scan/redeem redaction.
- [ ] Verify deployed Vercel proxy/header behavior, correlation-ID lookup, rate-limit cleanup scheduling, alerts, and store-failure 503 behavior.
- [ ] Under separate Stripe test-mode authorization, inventory/expire active Sessions during an event close and prove payment-wins races retain immutable evidence.
- [ ] Obtain database, security, payment, incident, and rollback owner sign-off before any production proposal.

## Phase 4/6/7 staging promotion gate

- [ ] Apply all nine migrations in `MIGRATION_RUNBOOK.md` order and repeat Phase 2-7 assertions plus all 16 concurrency races using synthetic data.
- [ ] Complete authenticated notification/promo/media administration and two-session stale-save QA.
- [ ] Verify real Storage uploads/playback/lifecycle with no public write grant.
- [ ] Configure a reviewed Resend staging sender and worker secret, then prove one bounded approved test delivery without duplicate tickets or QR values in logs.
- [ ] Reconcile a discounted Stripe test-mode order, replay, Session failure/expiry and refund reporting under separate authorization.
- [ ] Complete the browser, accessibility, device and scanner items in `OVERNIGHT_MANUAL_QA.md`.
