# SKIE Events pre-launch hardening

Status: validated release candidate. Production completion requires the automated migration dry run, migration apply, deployment, and live operations-health verification on the merged commit.

## Included work

- Checkout copy and consent simplification
- Checkout button contract: `Checkout` / `Checking out...`
- Tracking-only promoter codes without a fake `No discount` value
- Accurate captured/pending/refunded/disputed promoter reporting
- Complete promo usage counts beyond 1,000 redemption rows
- Original promo creator preservation and numeric input validation
- Payment-aware post-checkout Active / Needs attention / Completed classification
- Server-side post-checkout filtering, search and cursor pagination
- Durable fulfilment-notification enqueue jobs and bounded queue draining
- Durable event-closure shutdown for open Checkout Sessions and uncaptured PaymentIntents
- Final event-state verification immediately before capture
- Immutable eligible-line promo allocation for Stripe receipts
- Durable Stripe webhook replay from immutable Stripe event IDs
- Separation of strict operations health from unrelated customer checkout availability
- Schema-readiness version 35 covering every migration in this release
- Reopened-event shutdown actions released for safe later re-queueing
- Webhook replay health failing closed when its database contract is unavailable

## Additive migrations

- 29: promo usage aggregates
- 30: durable fulfilment notification jobs
- 31: durable event payment shutdown
- 32: post-checkout admin pagination
- 33: immutable promo line discount allocation
- 34: Stripe webhook replay queue
- 35: Stripe webhook replay health and schema-readiness version 35

## Required release gate

The release candidate must remain unmerged until all of the following pass against the same commit:

1. Dependency installation
2. Lint
3. TypeScript
4. Complete test suite
5. Production build
6. Vercel Preview
7. Final SQL and diff review for payment, notification, webhook and event-closure safety

After merge, the automated production migration workflow must pass its dry run, apply, and history verification before production verification begins.

Production verification must confirm zero payment, notification, event-shutdown, webhook-replay, recovery and overdue work before the release is considered complete.
