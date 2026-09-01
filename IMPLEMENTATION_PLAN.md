# SKIE EVENTS Launch Hardening Implementation Plan

Date: 2026-07-21 (Australia/Sydney)
Branch: `feature/launch-hardening-notifications-promos-media`

## Safety boundary

- Local `APP_MODE=test` fixtures and mocks only.
- Do not contact or mutate production Supabase, Stripe, Resend, Twilio, or Vercel.
- Do not commit, stage, push, deploy, reset, revert, or delete files.
- Preserve the audit reports, all `visual-*.txt` files, and generated `next-env.d.ts`.
- Never expose environment values or provider/customer payloads.

## Architecture decision

The paid-launch foundation will be a non-destructive normalized Supabase migration with constrained rows and transactional RPCs. The migration will not be applied by this programme. Local test mode will retain a deterministic fixture-backed adapter so permanent tests never require provider access. Existing JSON documents remain available for CMS/backward compatibility, but they are not considered a safe production transaction boundary for new paid operations.

Already-created, valid reservations use an honour-reserved policy: fulfilment consumes their immutable snapshot even if ordinary capacity or CMS configuration later changes. Emergency event cancellation must explicitly expire active Sessions; if payment wins the race, it is durably recorded and enters recovery/manual review rather than disappearing.

## Phase gates

1. Permanent Vitest TypeScript test foundation, fixtures, provider mocks, and suite scripts.
2. Payment durability: immutable reservations, normalized migration/RPCs, webhook inbox, paid-unfulfilled recovery, refunds/disputes, allocation Session policy, and protected recovery UI.
3. Canonical event state, safe login redirects, event-scoped door roles, stale CMS writes, signup repair, shared production rate-limit interface.
4. Email outbox, branded safe templates, one multi-ticket email/order with canonical ticket QRs, admin delivery tools.
5. SMS provider/outbox abstraction, consent data, Twilio callback validation, scheduling, messaging UI and opt-out policy.
6. Atomic promo-code reservation/finalization, Stripe linkage, checkout UI, reporting and refund policy.
7. Hardened media upload lifecycle, normalized image/video model, admin controls and accessible public playback.
8. Remaining confirmed audit defects and operational documentation.
9. Complete regression suites.
10. Final static/security scans, local browser QA and launch report.

Every phase requires its targeted tests, `git diff --check`, `npm run verify`, progress update, and unrelated-diff inspection. Optional phases stop if a P0/P1 regression remains.

## Current gate decision

- Phase 1 passed.
- Phase 2 local TypeScript/test/build work passed, but PostgreSQL execution, RLS and concurrency proof are unavailable.
- Work stopped at this foundational gate. Phases 3-10 remain planned, not completed; optional email/SMS/promo/media work must not proceed until the isolated-staging database rehearsal passes.
