# Overnight Remaining Blockers

Date: 22 July 2026

## Promotion verdict

The local implementation has no open P0 or P1 defect in the delivered Phase 3, 4, 6 or 7 scope. Production promotion remains blocked on external, operator-owned evidence that this local-only run was not authorized to obtain.

## P0

None.

## P1

None.

## P2 promotion blockers

1. Replay the complete additive migration chain in a new isolated Supabase staging project, using synthetic data, and repeat catalog/RLS/grant/RPC/concurrency verification.
2. Complete authenticated two-session CMS stale-write, staff capability/event-scope, profile reconciliation, notification, promo and media admin journeys in a human-controlled browser.
3. Configure and validate the staging Storage bucket and service-only upload path. Prove real image/video upload, poster playback, orphan cleanup and reference-aware deletion without hosted production data.
4. Configure a verified Resend staging sender and protected worker secret, perform an approved test delivery, inspect multi-ticket QR rendering across target mail clients, and verify retry/terminal handling. Do not enable cron until this passes.
5. Run the existing Stripe staging/test-mode payment, discounted-total, replay, refund/dispute and paid-unfulfilled recovery drills. This implementation deliberately did not call Stripe.
6. Complete keyboard, screen-reader, 200% zoom/reflow, real mobile playback/data-saver/reduced-motion, camera permission and scanner hardware QA.

## P3 follow-up

- Phase 5 may add SMS/Twilio as a new channel worker over the existing notification outbox. It was intentionally excluded.
- Media transcoding, automatic poster extraction and advanced responsive rendition generation are optional future enhancements; the current allowlist requires browser-compatible source files.

## Safety blockers encountered

None. Docker, local Supabase, clean database reset, migrations, RLS and payment invariants all remained recoverable and passed. No test required production credentials or a weakened security assertion.
