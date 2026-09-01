# SKIE EVENTS launch-completion gap inventory

Date: 2026-07-22
Branch: `feature/launch-hardening-notifications-promos-media`
Draft PR: `#1`
Permitted hosted target: staging project `tmfbdnkntafzgmqbqihe` only

## Inventory scope and baseline

The following were reviewed before implementation work began:

- `OVERNIGHT_IMPLEMENTATION_REPORT.md`
- `STAGING_ROLLOUT_PLAN.md`
- `PRECOMMIT_AUDIT.md`
- all checked-in Phase implementation reports
- `package.json`, `package-lock.json`, and `.env.example`
- every migration through `20260722030000_phase7_media.sql`
- notification outbox types, templates, providers, store, service, worker, internal worker route, admin route, and admin UI
- customer registration/account paths and the application/allocation/payment fulfilment notification call sites
- media validation, registry, upload route, admin UI, and public player
- admin routes/components and public routes/components
- accessibility-related CSS, markup, test documentation, and package configuration

Read-only baseline:

| Check | Result |
| --- | --- |
| `git branch --show-current` | PASS — `feature/launch-hardening-notifications-promos-media` |
| `git status --short` | PASS — only the pre-existing untracked evidence files were present |
| `git diff --check` | PASS |
| `npm run verify` | PASS — lint, TypeScript, and production build; 35 routes |
| `npm test` | PASS — 25 files, 137 tests |
| `npm run test:database` | PASS — all Phase 2–7 assertions and concurrency suites 01–16 |
| direct dependency check | Twilio, Mux, axe, and Playwright packages are not directly installed |

No hosted database, provider, Vercel, Git remote, or Production mutation was performed during this inventory.

## Mandatory-feature gap matrix

| Feature | State | Existing implementation | Exact affected surfaces | New migration | Environment/provider setup | Required tests | Launch blockers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Twilio transactional SMS | **Partial foundation; delivery absent** | Customer phone is collected; the durable outbox schema names `sms`; leases, idempotency, retry limits, attempts, and admin audit already exist. All runtime enqueue/claim/render/provider paths are email-only. Phone validation is not canonical E.164 and there is no separate transactional-SMS consent ledger or callback verification. | `src/lib/notifications/{types,templates,provider,store,service,worker}.ts`; `src/lib/operations.ts`; payment fulfilment paths; signup schema/action/form; account UI; `src/app/api/internal/notifications/process/route.ts`; `src/app/api/admin/notifications/route.ts`; `src/components/admin/EmailsPanel.tsx`; new Twilio callback route; `.env.example` | Required: forward-only migration after `20260722030000_phase7_media.sql` for channel/status expansion, consent/preferences, controls, provider callbacks, indexes, grants/RLS, and revised RPCs | Twilio test-account/subaccount values only: account SID, auth token, messaging service SID or From number, and callback URL. Runtime stays local/disabled until separately configured. No live contact during implementation. | E.164 normalization/redaction; consent/preference resolution; templates; idempotent enqueue; bounded retry/permanent failure; mocked provider request; callback signature rejection/acceptance/duplicates; admin permissions/actions; database RLS/grants/RPCs; paid-order fulfilment isolation | No provider adapter, no callback endpoint, no consent record, and no verified SMS state flow |
| Additional notification channels | **Email substantially complete; in-app and WhatsApp absent** | Branded channel-specific email templates, Resend/local providers, durable email outbox, worker, ticket attachments, admin preview/test/retry/cancel/resend. Schema currently permits email/SMS only. | Same notification surfaces above; account notification preferences/inbox API and component; admin per-channel/event controls | Shared notification migration above | Resend remains existing. WhatsApp adapter must remain behind a disabled feature flag until approved provider configuration exists. | Channel-specific rendering; enable/disable behavior; customer preference behavior; in-app listing/read state; WhatsApp-disabled behavior; no secret leakage; all required transactional event mappings | No in-app channel, no WhatsApp-ready adapter, no customer preferences, no event/channel controls; required `event_reminder` and `admin_manual_message` templates absent |
| Mux video transcoding | **Absent** | Media registry and secure image/video validation/upload exist for local/Supabase storage. Public native video rendering includes a basic reduced-motion/data-saving policy. | `src/lib/media/{security,store}.ts`; `src/app/api/admin/upload/route.ts`; `src/components/admin/{MediaPanel,AdminAssetUploadField}.tsx`; public media/player components; new Mux upload/webhook/delete/retry routes and provider module | Required in Phase 2 for upload/asset/playback lifecycle, webhook idempotency, captions, poster metadata, errors, and audit | Mux test/staging token ID/secret, webhook signing secret, playback policy configuration; separately approved before any contact | Signature rejection; duplicate webhook; legal state transitions; deletion/retry; unavailable fallback; player accessibility/reduced motion; captions | No direct-upload creation, Mux provider, signed webhook, adaptive player, processing dashboard, or secure remote deletion |
| Automatic video poster extraction | **Partial manual fallback only** | Media records can store a manually supplied poster; no extraction or timestamp policy exists. | Phase 2 media schema/provider/player/admin surfaces above | Shared Phase 2 media migration | Mux animated/static image or thumbnail URL policy; no FFmpeg in Vercel | Automatic URL derivation; configurable timestamp; manual override precedence; missing/failed asset fallback | No automatic poster, timestamp, or provider lifecycle source |
| Advanced first-party analytics | **Absent as a product feature** | Operational audit records, payment records, scans, notification attempts, and promo data can support server-authoritative events, but there is no analytics event model, ingestion contract, retention job, aggregation routine, funnel UI, or CSV export. | New analytics library/API/client instrumentation; server-authoritative application/payment/ticket/notification/scan hooks; admin analytics panel/export; `src/components/admin/AdminStudio.tsx`; public route instrumentation | Required in Phase 3 for deduplicated events, retention, RLS/grants/indexes, Melbourne-time aggregates | No third-party provider required; documented retention and optional first-party collection flag | PII exclusion; deduplication; authoritative payment events; UTM/device/referrer normalization; timezone boundaries; aggregates/funnels/revenue; RLS/grants; filters/export and UI states | Entire analytics data path and reporting UI absent |
| Extensive design polishing | **Partial** | Established black/white/`#5170FF` premium visual system and responsive public/admin surfaces exist. Loading, error, mobile tables, scanner ergonomics, media ratios, and page-to-page consistency have not received the requested complete regression/evidence pass. | Global CSS/layout; homepage/events/event/application/auth/account/tickets/checkout/payment/media routes; all admin panels; scanner/redemption; email templates | None expected unless content metadata changes | None | Responsive screenshot matrix; overflow/layout-shift checks; interactive states; email rendering; desktop/tablet/mobile; regression/build | No complete before/after evidence or whole-product design QA; several flows need state polish |
| Admin convenience and recovery tools | **Partial** | Admin applications, allocations, notification retry/cancel/ticket resend, payment recovery, ticketing/check-in, promo management, exports, media management, staff roles, and audit logs exist. | Admin APIs/components for events, applications, allocations, notifications, customers, tickets, check-in, promos, media, payment recovery, exports, audit, and new readiness dashboard | Required in Phase 4 for saved filters, reversals/reissues, bulk action jobs/idempotency, capacity policies, and audit details | None beyond existing server secrets/provider configurations | Permission denial per action; confirmation contracts; bulk partial-failure/idempotency; reversal invariants; reconciliation; search/filters/exports; audit completeness | Duplicate event, required bulk actions, reversals with reasons, broad search, saved filters, processing/reconciliation dashboards, and launch checklist are absent or incomplete |
| WCAG 2.2 AA engineering/evidence | **Partial baseline; evaluation absent** | Root language, some landmarks/labels/status roles, screen-reader utility styles, native controls, and reduced-motion CSS/player behavior exist. There is no skip link, systematic focus/dialog/menu validation, axe suite, Lighthouse evidence, keyboard evidence, contrast evidence, or conformance evaluation report. | Root/site/account/admin layouts; shared Header and form/modal/menu/table/media/ticket/scanner components; global CSS; test config/scripts; `docs/TESTING.md`; new `ACCESSIBILITY_EVALUATION_REPORT.md` | None expected unless accessibility preferences are persisted | Add an appropriate automated axe/browser testing tool only if needed in Phase 6; Lighthouse available tooling to be verified then | Axe; Lighthouse where supported; keyboard-only checklist; focus trap/restoration; screen-reader semantic inspection; contrast; target size; 200% zoom/reflow; reduced motion; captions/transcripts; QR textual equivalent | Requested evidence does not exist. Independent/third-party certification is explicitly out of scope and must not be claimed |

## Notification-specific findings affecting Phase 1

- `notification_outbox` is durable and idempotent, but runtime code hard-codes email and its stored status vocabulary uses `claimed`/`temporary_failure` rather than the requested `processing`/`retry` states.
- `notification_attempts`, leases, bounded attempts, provider identifiers, delivery timestamps, and admin audit are reusable.
- Current admin notification responses redact email recipients, but phone-specific redaction and provider-error sanitisation are absent.
- Current application/review flows await the enqueue operation after committing their business mutation. Enqueue failures can therefore surface as request failures even though the mutation succeeded. Phase 1 must isolate all notification failures.
- Payment fulfilment already catches ticket-email enqueue errors, so ticket creation is not rolled back by the email provider. Phase 1 must retain this invariant for every channel.
- Required templates already represented: application received, approved/unlocked, waitlist, rejection, payment confirmed, tickets issued, event updated, event cancelled. Required event reminder and admin manual-message templates are absent. A legacy allocation reminder uses `payment_reminder` and needs a supported template contract.
- Email remains the only rendered/provider channel. WhatsApp must be disabled by default, and no Twilio API may be contacted in implementation/tests.

## Proposed migration sequence

All changes will be made in new forward-only files; the nine applied migration files will remain byte-for-byte untouched.

1. Phase 1: `20260723000000_phase1_multichannel_notifications.sql`
2. Phase 2: later timestamped Mux/media lifecycle migration, only after Phase 1 review
3. Phase 3: later timestamped analytics migration, only after Phase 2 review
4. Phase 4: later timestamped admin/recovery migration, only after Phase 3 review

Every hosted migration remains blocked behind a reviewed Supabase dry-run and fresh exact authorization. This sprint does not apply or seed any hosted database.

## Estimated implementation order and gates

1. **Phase 1 now:** forward notification schema/RPCs; safe providers and callback verification; channel templates/orchestration; preference/consent and admin controls; business-event integration; focused unit/integration/database tests; diff/security report; stop for review.
2. **Phase 2 after review:** Mux lifecycle, poster extraction, player/accessibility behavior, admin processing/retry/deletion, tests; stop.
3. **Phase 3 after review:** first-party analytics schema, authoritative instrumentation, aggregation/export/dashboard, tests; stop.
4. **Phase 4 after review:** admin convenience/recovery actions and audit/permission coverage; stop.
5. **Phase 5 after review:** brand-preserving public/admin/email responsive polish and local screenshot evidence; stop.
6. **Phase 6 after review:** WCAG 2.2 AA remediation and evidence report, explicitly without certification claims; stop.
7. **Phase 7 after review:** complete regression, security/dependency/secret/hash/change inventory, severity classification and final no-mutation gate.

## Phase 0 decision

Phase 1 can proceed locally without provider contact or hosted mutation. Its launch blockers are the missing multi-channel runtime, explicit consent/preferences, callback verification, per-channel controls, required templates, and failure isolation described above. Mux, analytics, broad admin tooling, design polish, and full accessibility evidence remain later gated phases and will not be represented as complete during Phase 1.
