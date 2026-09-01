# Phase 3 Implementation Plan

Date: 2026-07-22
Required branch: `feature/launch-hardening-notifications-promos-media`
Checkpoint HEAD: `4d1df39 Harden payment lifecycle and verify local transactions`
Status: **COMPLETE FOR THE LOCAL PHASE 3 GATE**

## Completed safety gate

The complete baseline was restarted from its first command after Docker PATH repair. The required branch/checkpoint, local Supabase status, database suite, application suite, verification build, production dependency audit, and diff check all passed before implementation began. Hosted Supabase was neither linked nor accessed.

Baseline evidence: database PASS; 9 files / 38 tests PASS; lint/typecheck/build PASS; 0 production dependency vulnerabilities; diff check PASS with line-ending warnings only.

## Completed work

1. [x] Canonical event state, Melbourne time-window validation, and an immutable-reservation emergency-close policy enforced across CMS/public/application/checkout/database paths.
2. [x] Safe same-origin `next` redirects for protected pages while retaining JSON 401 API behavior.
3. [x] Event-staff assignment administration, windows/audit, role capabilities, scoped door access, and redacted wrong-event behavior.
4. [x] Explicit CMS document-version compare-and-swap semantics and stale-save UI recovery.
5. [x] Authenticated, idempotent profile/application-customer repair with role preservation and safe audit evidence.
6. [x] Service-role-only shared PostgreSQL rate limiting, trusted proxy handling, cleanup, and simultaneous final-slot tests.
7. [x] Stable API error mappings, bounded JSON parsing, strict schemas, status codes, and correlation IDs for Phase 3 routes.
8. [x] Permanent unit, route, database, concurrency, build, audit, diff, and local browser gates.

## Completion evidence

- `npm run test:database`: Phase 2 suite plus Phase 3 catalog/security/behavior checks and 13 total race cases PASS.
- `npm test`: 13 files / 65 tests PASS.
- `npm run test:browser`: protected redirect and external return-path cases PASS in local headless Edge.
- `npm run verify`: lint, typecheck, and Next.js production build PASS.
- Final audit/diff/worktree evidence is recorded in `PHASE3_IMPLEMENTATION_REPORT.md`.

Email, SMS, promo-code, and media/video implementation remain explicitly out of scope.
