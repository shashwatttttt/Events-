# SKIE EVENTS Overnight Local-Only Implementation Plan

Date: 2026-07-22 (Australia/Sydney)
Required branch: `feature/launch-hardening-notifications-promos-media`
Required checkpoint: `4d1df39 Harden payment lifecycle and verify local transactions`

## Safety boundary

- Use only repository files, local Docker, local Supabase, and localhost browser tooling.
- Do not link, push, or contact hosted Supabase or any external provider.
- Do not call Stripe, Resend, Twilio, Vercel, or hosted Storage.
- Do not stage, commit, push, deploy, rebase, merge, reset, or delete project files.
- Preserve existing audit/evidence files, `public/email`, `visual-*.txt`, `next-env.d.ts`, and `tsconfig.tsbuildinfo`.
- Keep payment evidence, identities, roles, prices, totals, inventory, discounts, and state server-authoritative.

## Baseline and source review

- [x] Confirm required branch and Phase 2 checkpoint at HEAD.
- [x] Confirm zero staged files and preserve the existing Phase 3 implementation/evidence.
- [x] Confirm Docker and local Supabase availability without printing credentials.
- [x] Read the required reports, documentation, migrations, seed, database verification, and affected application architecture.
- [x] Pass the complete baseline: database, application, payment, security, build, dependency audit, and diff checks.

## Ordered workstreams

1. [x] Re-audit and gate the existing Phase 3 implementation; record its exact changed-file inventory and permanent regression evidence.
2. [x] Phase 4: database-backed email outbox, provider abstraction, branded HTML/text templates, multi-ticket QR delivery, bounded worker, protected admin tooling, and permanent notification tests.
3. [x] Phase 6: protected promo administration, authoritative integer-cent discount calculation, immutable snapshots, atomic claim/release/finalization, checkout presentation, and permanent promo tests.
4. [x] Phase 7: backward-compatible media model, hardened local/Supabase upload architecture, MIME/signature/size/path enforcement, admin lifecycle controls, accessible looping video, and permanent media tests.
5. [x] Run the complete final local database reset/regression, security scans, local route/browser QA, and update every required report/checklist.

## Architecture decisions

- Reuse the normalized `notification_outbox`, `notification_attempts`, and service-role claim foundation. Phase 5 can add `sms` workers to the same channel-neutral outbox without changing the email contract.
- In local/test mode, delivery remains an inspectable local outbox/dry-run. The Resend adapter is server-only and cannot be selected without explicit live configuration; no provider call is made in this programme.
- Ticket emails derive all ticket QR URLs from the existing HMAC verification URL. Raw database token hashes are never rendered.
- Promo discounts are computed before reservation from authoritative CMS/catalog lines, then copied into immutable reservation/order snapshots and reconciled against provider totals. Refund reporting does not restore promo capacity automatically.
- Media object keys are server generated. SVG is rejected. Local/test uploads use the repository-compatible local adapter; production architecture uses the protected server-side Supabase Storage adapter with no browser write grants.
- Media metadata remains in the versioned CMS document for backward compatibility and uses the Phase 3 stale-write boundary.

## Gates

Each phase must pass its specified database, targeted, application, payment, security, build, audit, and diff gates. A real P0/P1, unsafe privileged RPC, unreplayable migration, payment-evidence risk, or requirement for external credentials stops the programme.
