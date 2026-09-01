# SKIE EVENTS deep launch-readiness and bug audit

Audit date: 21 July 2026 (Australia/Sydney)  
Scope: repository-wide, audit only; no production services or real payments were used.

## Executive summary

The application builds cleanly and has several good security foundations: server-side price calculation, Stripe webhook signature verification, HMAC QR tokens, ownership checks on customer tickets, role checks on admin APIs, origin checks on browser mutations, CSV formula escaping, and compare-and-swap (CAS) document updates. Those controls do not make the current payment lifecycle launch-safe.

The audit found **3 P0, 12 P1, 17 P2, and 7 P3 findings**. The most important failure class is a paid Stripe Checkout Session that can no longer be fulfilled locally. Admin cancellation, allocation edits/reapproval, or inventory/configuration changes after session creation can all produce this state. There is no automated reconciliation or refund recovery workflow. Refunds and disputes are also not consumed, so refunded tickets and products remain valid.

The production data model is two mutable JSON documents. CAS prevents a narrow lost-update race inside mutation helpers, but it does not provide database constraints, row-level uniqueness, durable queues, or a transaction spanning Stripe-session linkage and fulfilment state. This is not a safe long-term transactional boundary for concurrent ticket sales, check-in, redemption, and CMS editing.

Static mobile review with the installed Edge browser at 360/390/430/768/1440 px found visible horizontal clipping on contact, reviews, login, and legal content. The intended in-app interactive browser interface was unavailable, so keyboard, camera, hydration, history, and authenticated browser journeys could not be fully exercised.

## Launch verdict

**NO-GO for live paid launch.** Test-mode demonstrations are viable, but live ticket sales should remain disabled until P0-01 through P0-03 and P1-01/P1-04/P1-05/P1-08/P1-12 have been repaired and regression-tested. A controlled non-payment preview could proceed only with checkout disabled and privileged routes restricted.

## Confirmed P0 findings

| ID | Confidence / type | Affected code | Technical cause and impact | Reproduction | Targeted fix | Blocks launch / regression |
|---|---|---|---|---|---|---|
| P0-01 | Confirmed bug | `src/app/api/admin/allocations/route.ts:38-45`; `src/lib/payments/reconciliation.ts:62-67`; `src/lib/payments/index.ts:15-43` | Cancelling an allocation changes the local pending order to `cancelled`, but does not expire its Stripe Checkout Session. Stripe can still charge it; reconciliation then rejects the non-pending order and creates no ticket. This is direct financial loss and support exposure. | Start live checkout, keep Stripe page open, cancel allocation in admin, then complete the Session with a Stripe test clock/test account. Observe a paid Session and rejected webhook/local cancelled order. | Persist the Stripe Session ID before exposure; on cancellation call Stripe expiry, make cancellation/expiry idempotent, and add a paid-after-cancel reconciliation state that fulfils or automatically refunds under an explicit policy. | **Yes.** Integration test with Stripe fixtures and concurrent cancel/pay ordering required. |
| P0-02 | Confirmed bug | `src/app/api/admin/allocations/route.ts:28-48`; `src/lib/operations.ts:87-139,401-415` | Extend/unlock and repeated approval can move an allocation from `checkout_started` back to `unlocked` while its Session remains payable. Final fulfilment requires exactly `checkout_started`, so a successful charge is rejected without a ticket. | Begin allocation checkout; extend/unlock it or approve the application again; finish the existing Session; replay `checkout.session.completed`. | Forbid allocation mutation while an active Session exists, or atomically version the reservation and bind the fulfilment to that immutable version. Expire/recreate the Session for any allowed change. | **Yes.** State-transition and webhook replay tests required. |
| P0-03 | Confirmed bug | `src/lib/operations.ts:357-464`; `src/lib/payments/reconciliation.ts:54-96`; `src/components/admin/WebsitePanel.tsx`; `src/app/api/admin/site/route.ts:10-22` | Fulfilment revalidates capacity, per-customer limits and product stock against mutable CMS state. Reducing any limit after Checkout creation makes a legitimately paid Session fail fulfilment. There is no durable `paid_unfulfilled` state or automatic refund/recovery queue. | Create a Session for the last ticket/product, reduce capacity/stock/limit in admin, complete payment, and deliver the webhook. | Reserve inventory transactionally before Session creation; make paid fulfilment consume the immutable reservation instead of current mutable limits. Record every accepted payment before downstream work and provide deterministic fulfil-or-refund recovery. | **Yes.** Concurrency and post-session mutation integration tests required. |

## Confirmed P1 findings

| ID | Confidence / type | Affected code | Technical cause and impact | Reproduction | Targeted fix | Blocks launch / regression |
|---|---|---|---|---|---|---|
| P1-01 | Confirmed bug | `src/app/api/stripe/webhook/route.ts:20-41`; `src/lib/payments/reconciliation.ts`; `docs/STRIPE-SETUP.md:48-50` | Refund, partial-refund, dispute, chargeback, and PaymentIntent cancellation events are not handled. Paid orders, tickets, and entitlements remain usable after money is returned or disputed. | Mark an order paid locally, replay a Stripe `charge.refunded`/`charge.dispute.created` fixture, then verify/check in/redeem. State is unchanged. | Add refund/dispute state fields and idempotent handlers; invalidate or partially adjust tickets/entitlements according to product policy; expose manual review. | **Yes.** Event-fixture tests required. |
| P1-02 | Confirmed bug | `src/lib/config.ts:8-28,32-59`; `src/lib/mode.ts:3-8`; `src/app/api/checkout/test-complete/route.ts:10-12` | Effective test mode requires both server and CMS settings to be live, but the test-complete endpoint hard-blocks whenever only the server is live. A live deployment whose persisted site setting is still `test` creates fake test checkout URLs that cannot be completed. | Deploy with valid live environment and a site document whose `settings.appMode` is `test`; create checkout; submit test completion. | In live server mode, fail checkout creation closed with an admin-facing configuration error unless the CMS mode is live. Never emit a test completion URL from a live server. Add deployment health assertion. | **Yes.** Configuration matrix tests required. |
| P1-03 | Confirmed bug | `src/lib/operations.ts:169-189`; `src/lib/platform.ts:5-14`; `src/lib/site-validation.ts`; `src/app/(site)/events/[slug]/page.tsx` | Checkout rejects hidden/archived visibility but not `coming_soon`. If CMS leaves `ticketMode=direct_purchase` or `free_rsvp`, a guessed/direct checkout URL sells an event whose UI says it is not on sale. The validator permits the invalid combination. | Configure published + coming_soon + direct_purchase and call `/api/checkout/create` with its ticket type. | Define one canonical event state machine and enforce sale eligibility in the server operation and CMS schema; reject invalid combinations on save. | **Yes** for any coming-soon campaign. State-matrix tests required. |
| P1-04 | Confirmed bug | `src/app/(site)/checkout/event/[slug]/page.tsx:8-11`; `src/app/(site)/checkout/[allocationId]/page.tsx:7`; `src/app/(site)/checkout/test/page.tsx:7`; `src/lib/security/session.ts:68-78` | Checkout Server Components call `requireUser`, whose thrown `AUTH_REQUIRED` is not converted to a login redirect. An unauthenticated visit renders a server error/500 instead of authentication. Confirmed in local Edge. | Open `/checkout/event/redline-house-party` signed out. | Use a shared page guard that redirects to `/login?next=...`; keep API handlers returning 401. Add an error boundary as a secondary safeguard. | **Yes** for direct purchase. Browser regression required. |
| P1-05 | Confirmed authorization/privacy bug | `src/app/api/check-in/route.ts:31-84`; `src/app/api/entitlements/redeem/route.ts:6-13`; `src/lib/operations.ts:817-854` | Door/scanner roles are not scoped to assigned events. Search accepts any `eventId` and returns holder name, email, code and entitlements. Redemption accepts only entitlement ID, so a door user can redeem another event's entitlement; wrong-event scan responses also include entitlements. | Authenticate as door staff; query another event ID or submit an entitlement ID learned from another event. | Add staff-event assignments and enforce them server-side; pass and verify expected event/order at redemption; return minimal PII; suppress entitlements on rejected scans. | **Yes.** Authorization matrix and wrong-event tests required. |
| P1-06 | Confirmed concurrency bug | `src/app/api/admin/site/route.ts:10-22`; `src/lib/data/documents.ts:66-84,129-132`; `src/components/admin/AdminStudio.tsx` | Admin save replaces the entire site document with the browser's stale copy. CAS retries serialize writes but do not detect the caller's stale version, so two admins silently overwrite each other. | Open two admin sessions; save different sections from both; reload after the second save. | Require `expectedVersion`/ETag and return 409 on mismatch, or use field-level mutations. Show a merge/reload conflict UI. | **Yes** if multiple operators edit during launch. Concurrency test required. |
| P1-07 | Confirmed data-integrity bug | `src/lib/auth-service.ts:12-31`; `supabase/schema.sql:1-57` | Supabase Auth user creation and operations-document customer creation are separate systems with no transaction/compensation. If the second write fails, an Auth/profile user exists without the application customer record; repeat signup cannot cleanly repair it. | Inject a document-write failure after `signUp` succeeds, then sign in/retry. | Make operations users derivable/upsertable from authenticated identity, add a repair-on-login path, and compensate failed signup where safe. Prefer normalized profile data in Postgres. | **Yes** for production signup reliability. Fault-injection test required. |
| P1-08 | Confirmed payment-integrity bug | `src/lib/payments/index.ts:15-43` | Stripe Session creation succeeds before a separate document mutation stores `stripeSessionId`. A write failure leaves an active, payable Session that reconciliation cannot bind to its order because the stored ID comparison fails. | Inject failure at the post-Stripe `mutateOperationsData`; pay the returned/observed Session; deliver webhook. | Create a durable checkout-attempt record first; persist provider request/idempotency state; recover Sessions by immutable signed metadata and an explicit reconciliation workflow. Expire orphan Sessions. | **Yes.** Fault-injection test required. |
| P1-09 | Highly likely design risk | `src/lib/data/documents.ts:21-132`; `supabase/schema.sql:33-75`; `src/lib/operations.ts` | All orders, tickets, reservations, entitlements, scans, logs and users share one JSON document. There are no database unique/check constraints, row locks, foreign keys, or transactions. CAS reduces overwrite races but every mutation conflicts on the same row and correctness depends entirely on application scans. | Load-test simultaneous purchases/scans/redeems across events and observe retries/document growth; bypass one application invariant in a fixture. | Normalize transactional entities. Use unique constraints for Stripe IDs/idempotency/ticket codes, foreign keys, and Postgres RPC transactions with row locks/advisory locks for reserve/fulfil/check-in/redeem. | **Yes** at real event concurrency. Database integration/load tests required. |
| P1-10 | Highly likely security/availability risk | `src/lib/security/rate-limit.ts`; `docs/SECURITY.md:40-42`; public auth/application/contact/review routes | Rate limits are process-local Maps keyed partly by client-controlled forwarding headers. On Vercel, limits reset per instance/cold start and can be bypassed across instances or spoofed, leaving signup, login, application and review endpoints exposed to abuse. | Alternate forwarded IP values or requests across instances and exceed the nominal limit. | Use a trusted-proxy-derived IP and a shared store/provider; add per-account/email and bot controls; return 429 with `Retry-After`. | **Yes** unless edge/WAF controls are independently configured and verified. Rate-limit tests required. |
| P1-11 | Confirmed state-machine bug | `src/lib/operations.ts:357-464`; `src/app/api/admin/site/route.ts`; `src/lib/payments/reconciliation.ts` | Final fulfilment does not recheck event lifecycle/visibility/ticket mode or sales-window closure. Cancelling/archiving/closing an event after Session creation can still issue a valid ticket, while other CMS edits reject fulfilment after charge. The policy is inconsistent and unsafe. | Start checkout, cancel or close event, then complete payment. | Explicitly choose and encode an immutable reservation policy: expire all Sessions on emergency close, or fulfil already-reserved orders. Implement Stripe expiry and a single transactional transition. | **Yes.** Transition-ordering tests required. |
| P1-12 | Confirmed missing operational process | `src/app/api/stripe/webhook/route.ts`; `src/components/admin/OverviewPanel.tsx`; `docs/PRODUCTION-CHECKLIST.md`; no reconciliation/health/resend endpoints | Failures are logged to console and local audit arrays, but there is no job or admin tool to list Stripe-paid/local-unfulfilled orders, replay fulfilment safely, expire Sessions, issue refunds, resend tickets, or alert operators. A transient failure can remain unresolved indefinitely. | Force a webhook persistence failure or email failure and inspect the admin UI. | Add durable webhook inbox/outbox, alerting, reconciliation job, idempotent fulfil/refund/resend tools, runbooks and health checks. | **Yes** for paid launch. Recovery-path tests and an operator drill required. |

## P2 findings

| ID | Confidence / type | Affected code | Cause / impact / reproduction | Recommendation | Launch block / regression |
|---|---|---|---|---|---|
| P2-01 | Confirmed security bug | `src/lib/http.ts:4-8`; provider helpers | `error.message` is returned to clients. Triggering Stripe, Supabase, storage or Resend failures can disclose provider/internal details. | Map known failures to stable public codes; log a correlation ID server-side; never return raw provider text. | Conditional blocker if production error detail is sensitive. Error-shaping tests. |
| P2-02 | Confirmed validation bug | `src/lib/operations.ts:35-84`; `src/app/api/applications/route.ts` | Dynamic answers validate required/max length only, not declared field type/options, and unknown keys are accepted. A crafted JSON request bypasses the form model and pollutes exports/review. | Build a schema from the selected form; reject unknown fields, invalid choices and excessive key counts/body size. | No. Schema tests. |
| P2-03 | Confirmed authorization/business-rule bug | `src/lib/operations.ts:225-270`; `src/types/site.ts` | Product purchase checks matching `eventId` and `active`, but not membership in the event's `productIds`. An unlisted same-event product can be bought with a forged request. | Require assignment and valid sales window at reservation and fulfilment; constrain product/event relation in DB. | Conditional blocker for hidden products. API test. |
| P2-04 | Confirmed validation gap | `src/lib/site-validation.ts`; `src/types/site.ts`; admin editors | CMS validation does not reject unknown enum-like runtime values, start-after-end windows, invalid event dates, unsafe state combinations, free-RSVP paid tickets, or product/event assignment mismatches. Bad content can create contradictory sale behavior. | Use exhaustive Zod enums/refinements and a shared state-machine validator; preview the effective sale state before publish. | Conditional. Matrix/property tests. |
| P2-05 | Confirmed upload hardening gap | `src/app/api/admin/upload/route.ts:13-34`; `supabase/schema.sql:77-91`; `src/components/admin/MediaPanel.tsx` | The route buffers `formData()` before enforcing 25 MB, trusts client MIME, does not verify magic bytes/extension, and leaves uploaded objects when CMS save is abandoned. Public bucket makes accepted payloads world-readable. SVG is correctly excluded. | Enforce request limits upstream, sniff bytes, generate server extension/name, quarantine/process media, and garbage-collect unreferenced objects. | Conditional blocker based on bucket/content headers. Upload/security tests. |
| P2-06 | Confirmed API hardening gap | Most `src/app/api/**/route.ts`; `src/lib/http.ts` | JSON routes lack explicit body-size limits; several admin actions accept strings/numbers without enum/range schemas; validation and rate-limit errors generally return 400 instead of 422/429. Large input can consume memory and malformed actions reach business code. | Apply route-specific content-length/body limits and Zod schemas at the boundary; return stable 401/403/409/422/429 codes. | No. Contract tests. |
| P2-07 | Confirmed email idempotency/recovery bug | `src/lib/email/index.ts:40-75`; application/review/payment callers | Idempotency is checked before the external send and logged afterward. Concurrent invocations can both send. Application/admin state is committed before email, so callers see failure despite successful mutation and may retry; no resend queue exists. | Claim an outbox row atomically with a unique key, send via worker, record attempts, and expose retry. Never make committed business success look rolled back. | Conditional. Concurrency/failure tests. |
| P2-08 | Confirmed missing auth journey | `src/app/(site)/login`; `src/app/(site)/signup`; `src/app/auth/callback/route.ts`; Supabase auth integration | Signup confirmation exists, but there is no forgot-password/request-reset/update-password journey. Locked-out customers cannot self-recover tickets. | Add generic-response reset request, secure callback/update flow, expiry handling and rate limiting; verify production SMTP/templates. | Conditional before tickets are sold. Browser/auth tests. |
| P2-09 | Confirmed responsive defect | `src/app/globals.css:194,255` and public page styles | CSS explicitly allows horizontal overflow. Edge screenshots at 360/390 px showed clipped headings/body/form edges on contact, reviews, login and legal pages. | Set a safe root overflow policy, replace viewport/fixed widths with container-aware sizing, add `min-width:0` and wrapping for long content. Test 360/390/430/tablet. | No, but materially affects mobile conversion/legal access. Visual tests. |
| P2-10 | Confirmed timezone defect | `src/lib/format.ts:13-24`; admin event/product datetime inputs; `site.settings.timezone` | `datetime-local` conversion uses the admin device timezone, not Australia/Melbourne. An operator outside Melbourne or across DST can publish sales/expiry at the wrong instant. | Parse wall time explicitly in configured IANA timezone, show offset/DST, store UTC, and test DST gaps/folds and midnight boundaries. | Conditional for scheduled sales. Unit/browser tests. |
| P2-11 | Confirmed data/content bug | `data/site.json:130,208`; local/test public pages | Seeded local event times contain mojibake (`Ã¢â‚¬â€œ`), visibly rendered on the event page. | Repair source data through an approved migration/content save; add UTF-8/content smoke checks. | No. Snapshot/content test. |
| P2-12 | Confirmed privacy/design risk | `src/lib/email/index.ts:60-75`; `src/components/admin/EmailsPanel.tsx` | Email logs retain recipient addresses and full rendered HTML indefinitely in the shared operations document and expose them to all admin roles. This enlarges breach impact and document size. | Store minimal metadata/provider ID, define retention/redaction, and restrict logs to least-privileged roles. | No. Authorization/retention tests. |
| P2-13 | Confirmed SEO/privacy configuration gap | `src/app/layout.tsx`; account/checkout/admin/private pages; no `sitemap.ts`/`robots.ts` | Root robots metadata applies index/follow broadly; no route-specific noindex for account, checkout, admin, ticket verification or private-link/password events. Sitemap, canonical URLs, OG image and event structured data are absent. | Add explicit noindex headers/metadata to private surfaces and generate a state-aware sitemap/canonicals/JSON-LD for public events. | No. Metadata tests. |
| P2-14 | Highly likely performance risk | `src/app/(site)/layout.tsx:7`; most public pages; `src/lib/data/documents.ts` | Nearly all public pages are `force-dynamic` and repeatedly load/parse the full site document; operational routes load the full operations document. Growth will increase latency, conflicts and memory use; no bundle/per-route budget exists. | Cache/version public site content safely, query normalized operational rows, paginate admin views, and add performance budgets/production profiling. | Conditional at traffic/data scale. Load tests. |
| P2-15 | Confirmed security improvement | `next.config.ts`; `docs/SECURITY.md` | Useful headers exist, but no Content-Security-Policy is deployed. CMS-configured media/URLs and any future HTML sink increase stored-XSS blast radius. | Roll out nonce/hash CSP in report-only then enforce; restrict `img-src`, `media-src`, `connect-src`, `frame-ancestors`. | No. Header test. |
| P2-16 | Confirmed allocation logic risk | `src/lib/operations.ts:87-139`; `src/app/api/admin/applications/route.ts` | Approval accepts a ticket type without checking active/sales state and allows quantity up to a generic 20 without enforcing ticket/event/customer/capacity limits. The eventual checkout may fail, and repeated approval mutates an existing allocation. | Validate decisions against current event/ticket policy; make repeated decision idempotent; prevent mutation once checkout starts; present capacity conflicts as 409. | Conditional. Workflow tests. |
| P2-17 | Confirmed availability gap | `src/lib/operations.ts:142-323`; Stripe expiry handler | Expired pending orders are mostly cleaned opportunistically during later checkout/event delivery. Missed webhooks can leave allocations displayed as `checkout_started` and operations data stale, with no scheduled sweeper. | Add a durable scheduled expiry/reconciliation job and idempotent state transitions; base capacity on DB reservation expiry. | No if webhooks are healthy, otherwise operationally significant. Time-based tests. |

## P3 findings

| ID | Confidence / type | Affected code | Finding and impact | Recommendation | Regression |
|---|---|---|---|---|---|
| P3-01 | Confirmed UX bug | `src/app/(site)/payment/success/page.tsx` | Any non-empty `?order=` is shown as confirmed even without ownership/payment proof; `session_id` only drives a boolean. This can mislead a customer, though no private data is exposed. | Require authenticated ownership and display authoritative order state with a pending/retry state. | Page test. |
| P3-02 | Confirmed UX gap | `src/app/(site)/checkout/[allocationId]/page.tsx:7` | The page renders an owned allocation even when expired/cancelled/issued; only order creation rejects it. | Gate rendering by state/expiry and show an actionable explanation. | Page test. |
| P3-03 | Confirmed data-presentation issue | `src/app/(site)/account/tickets/[id]/page.tsx:8` | Every ticket in a multi-ticket order displays all order-level entitlements, which can imply each ticket carries the full product quantity. | Label extras as order-level or assign redemption ownership explicitly. | View-model test. |
| P3-04 | Confirmed performance polish | `src/app/(site)/events/page.tsx` | Image priority is applied to index 1 rather than the first visible event, delaying the likely LCP image and eagerly loading the next one. | Prioritize the actual above-fold/LCP image based on final ordering. | Lighthouse/perf smoke test. |
| P3-05 | Confirmed accessibility/UX gap | public forms and `src/app/globals.css` | Static review found labels in most forms and 16 px mobile inputs, but focus treatment is not consistently strong across custom buttons/links, and clipped content undermines zoom/reflow. Full keyboard validation was unavailable. | Add a global high-contrast `:focus-visible` treatment and run keyboard/200% zoom/reflow testing. | Accessibility browser test. |
| P3-06 | Confirmed maintainability risk | many compressed one-line pages/routes | Several critical pages and handlers are single very long lines, making review, line-level observability and safe patching harder. | Format source consistently and keep state transitions in named functions. | Formatter/check only. |
| P3-07 | Missing operational process | documentation and deployment config | Production checklists mention manual verification, but no evidence of a scheduled backup-restore drill, door-network contingency rehearsal, or incident ownership/escalation matrix is present. | Document owners/RTO/RPO; rehearse restore, offline guest-list fallback and payment incident response before each event. | Operational drill, not unit test. |

## Payment audit

### End-to-end trace

1. The client submits ticket/product identifiers and quantities to `POST /api/checkout/create`; the server loads authoritative event/ticket/product prices and computes AUD totals (`src/lib/operations.ts:142-323`). Duplicate product lines are rejected by the request schema.
2. A pending order and reservation are written through CAS. Capacity, ticket-type capacity, customer limits, allocation state, product stock and product limits are checked against active pending/paid orders.
3. In effective test mode a local completion URL is returned. In live mode Stripe Checkout is created with server line items, `aud` currency, order/event/user/allocation metadata, client reference, PaymentIntent metadata and an idempotency key (`src/lib/payments/index.ts`). The Session ID is linked in a second write (P1-08).
4. `/api/stripe/webhook` verifies the Stripe signature against the raw body. Reconciliation compares order reference, stored Session ID, event/user/allocation metadata, PaymentIntent identity, total, currency and paid state. It then performs CAS fulfilment.
5. Fulfilment records payment, marks the order paid, creates random ticket IDs/HMAC QR values, creates product entitlements, advances allocation and attempts a separate site sold-counter sync. Email is outside the core mutation and failures are logged.
6. The account view filters operational records by `userId`; individual ticket pages also enforce ownership.

Prices are server-calculated and amount/currency/session/PaymentIntent comparisons are present. The principal gap is not amount tampering; it is the absence of an immutable, transactional reservation and a recoverable paid-but-unfulfilled state.

### Stripe event/state table

| Stripe event | Current local result | Idempotency/replay behavior | Audit result |
|---|---|---|---|
| `checkout.session.completed` + `payment_status=paid` | Reconcile and fulfil; order `paid`, payment/tickets/entitlements created, email attempted | Session/PI/order checks plus existing payment/ticket scans; CAS retries | Supported, but P0 post-session mutation failures can strand payment. |
| `checkout.session.completed` + unpaid | Audit entry/awaiting payment; no fulfilment | Later async success may fulfil | Supported for async methods. |
| `checkout.session.async_payment_succeeded` | Reconcile and fulfil | Same as paid completion | Supported with same P0 risks. |
| `checkout.session.async_payment_failed` | Pending order -> `failed`; allocation released | Repeated event becomes a no-op/error depending state | Supported; should store webhook event IDs durably. |
| `checkout.session.expired` | Pending order -> `expired`; allocation released | State check limits repeat effect | Supported; missed webhook needs sweeper (P2-17). |
| Duplicate paid webhook | Existing payment/tickets generally prevent duplicates | No standalone unique DB constraint/event inbox | Application-idempotent but structurally fragile under JSON model. |
| `payment_intent.payment_failed` / cancelled | No handler | None | Unsupported. |
| `charge.refunded`, refund updates, partial refund | No handler | None | Unsupported; tickets/products stay valid (P1-01). |
| `charge.dispute.created/closed`, chargeback | No handler | None | Unsupported; tickets/products stay valid (P1-01). |
| Session manually expired during admin cancellation | Not performed | N/A | Required by P0-01/P1-11 fix. |

No real charge was made. Stripe production mode, webhook delivery, dashboard configuration, asynchronous payment behavior and refunds require a Stripe test account or fixtures in a safe staging environment.

## Authentication/authorization audit

| Surface | Authentication | Authorization / ownership | Result |
|---|---|---|---|
| `/skie-control` and dashboard | Required by dashboard layout | `admin` or `super_admin` | Protected; direct admin APIs also check roles. |
| `/skie-control/check-in` | Required | scanner/door/admin roles | Protected, but event scoping is absent (P1-05). |
| `/skie-control/login` | Public login | Resulting user must be admin role | Nominal; distributed brute-force control absent (P1-10). |
| `/account` | Required by account layout | Workspace filtered by session user | Protected. |
| `/account/tickets/[id]` | Customer required | `ticket.userId === user.id` | Protected against direct ticket IDOR. |
| `/checkout/[allocationId]` | Customer required | Allocation ownership checked | Ownership safe; unauth handling and stale-state UX defective. |
| `/checkout/event/[slug]` | Customer required | Server prices and customer limits | Unauth visit errors rather than redirects (P1-04). |
| `/checkout/test` | Customer + effective test mode | Pending order ownership | Live test endpoint also hard-blocked server-side. |
| `/payment/success` | Public | No ownership required | Misleading confirmation (P3-01), no private record returned. |
| `/ticket/verify` | Public possession flow | Valid HMAC token required by API | Expected public verification; response exposes holder name to token holder. |
| Event/application public pages | Mostly public; apply submission requires customer | Password cookie for password event; private-link is unlisted but link-accessible | Hidden/draft/cancelled detail restrictions mostly correct; sale state gap P1-03. |
| Admin APIs | Session required except login | Every inspected handler checks admin/super-admin; door APIs have separate roles | No unauthenticated admin API found. |
| Customer APIs | Session required | User ID is taken from session, not body | No direct customer-order/ticket IDOR found. |

Sessions use Supabase `getUser()` in Supabase mode and an HTTP-only, SameSite=Lax, signed local cookie in test mode. Logout clears the local session and calls Supabase sign-out. Auth callback accepts only relative `next` paths. Password reset is missing (P2-08). Disabled/rejected application status does not disable the underlying Auth account; that is a product-policy gap rather than a bypass. Origin validation is present on browser mutations and accepts absent `Origin`, which is appropriate for non-browser/webhook callers only when combined with authentication/content-type controls.

## Data-integrity/concurrency audit

| Operation | Present control | Remaining race/invariant | Required database primitive |
|---|---|---|---|
| Reserve ticket/product | CAS retry; scans pending orders and expiry | Whole-document contention; no unique reservation rows; mutable configuration after reserve | Transactional RPC, row locks, reservation rows with expiry, capacity check constraint. |
| Link Stripe Session | Stripe idempotency key | Provider call and local link are not atomic | Durable checkout attempt/outbox; unique `stripe_session_id`. |
| Fulfil paid order | One operations-document CAS creates payment/tickets/entitlements | Mutable guards can reject a paid reservation; no durable paid-unfulfilled state | Webhook inbox + transaction; unique provider event/session/PI and ticket constraints. |
| Sync sold counters | Separate site-document mutation | Can lag/temporarily fail; derived counters may disagree | Derive from normalized paid lines or update within DB transaction. |
| Check-in | CAS status check prevents ordinary duplicate acceptance | Whole-document hot row; no per-event staff scope | Atomic conditional update (`valid` -> `checked_in`) plus audit row. |
| Redeem unit | CAS quantity check | No expected-event/refund check; whole-document hot row | Atomic decrement with `quantity_remaining >= n`, event/order/status constraints. |
| Admin site save | CAS internal retry | Stale full-document replacement silently wins | Optimistic `expected_version`/ETag or field-level rows. |
| Email idempotency | Pre-send log lookup | Two senders can both call Resend before logging | Unique outbox idempotency key and worker claim/lease. |

Supabase RLS is appropriately restrictive for `platform_documents` (no public policies; service role server access) and profile updates are narrowed to basic customer fields. The media bucket is intentionally public-read. Production must verify the migration was actually applied; repository policy files cannot prove deployed RLS. Service-role use is server-only in inspected code and no service key appeared in client components or tracked source.

## Event-state matrix

| Dimension/state | Listed publicly | Detail by guessed link | Application | Purchase | Audit result |
|---|---:|---:|---:|---:|---|
| lifecycle `draft` | No | No | No | No | Correct server guards. |
| lifecycle `preview` | No | Admin only | No | No | Correct intent. |
| lifecycle `published` | Depends on visibility | Usually yes | Depends on mode | Depends on mode | Base sellable lifecycle. |
| lifecycle `archived` | Previous Events only when visibility archived | Yes via previous/archive path | No | No | Mostly correct. |
| lifecycle `cancelled` | No | No | No | New checkout no; existing Session inconsistent | P1-11. |
| visibility `public` | Yes when published | Yes | Mode-dependent | Mode-dependent | Correct. |
| visibility `hidden` | No | No | No | Rejected | Correct; guessed URL cannot buy. |
| visibility `private_link` | No | Yes to anyone with slug | Mode-dependent | Mode-dependent | Link secrecy only; document this explicitly. |
| visibility `password` | No | Password cookie required | Password required | Password required | HMAC cookie/server check present. |
| visibility `coming_soon` | Yes | Yes | UI-disabled | **Can buy if ticket mode sells** | P1-03. |
| visibility `archived` | Previous Events with archived lifecycle | Yes | No | Rejected | Correct in normal combination. |
| mode `invite_only` | Event visible by visibility | Yes | Authenticated application | Only valid unlocked allocation | Core flow present; approval mutation risks P0-02/P2-16. |
| mode `direct_purchase` | Event visible by visibility | Yes | N/A | Authenticated direct checkout | Core path present; unauth redirect broken and invalid visibility combination allowed. |
| mode `free_rsvp` | Event visible by visibility | Yes | N/A | Uses same order path | Works only if price configured zero; validator does not enforce zero. |
| mode `coming_soon` | Visible as configured | Yes | No | No | Correct when mode itself is set. |
| mode `closed` | Can remain visible | Yes | No | No new checkout | Correct for new orders; active Session policy missing. |

Ticket and product sales-window checks use UTC instants during reservation. Event-level and ticket-level capacity/customer checks are present, as are active pending-order holds. The admin entry path for datetime-local values is device-time based (P2-10). Invalid cross-dimension combinations are not rejected centrally (P2-04).

## API security table

`Origin` below means the shared same-origin check is called. `RL` is the current in-memory limiter and therefore not production-grade (P1-10).

| Route | Method | Authentication / authorization | Validation | Rate limit | Main risks |
|---|---|---|---|---|---|
| `/api/admin/allocations` | PATCH | admin/super-admin | Partial manual action/hours checks; Origin | None | P0-01/P0-02; weak enum/range schema. |
| `/api/admin/applications` | PATCH | admin/super-admin | Partial manual body; Origin | None | Reapproval mutation and invalid allocation policy (P0-02/P2-16). |
| `/api/admin/customers` | PATCH | admin/super-admin | Manual status fields; Origin | None | Broad admin powers; audit only. |
| `/api/admin/export` | GET | admin/super-admin | Export type/filter allow-list | None | PII export; CSV formula escaping is present. |
| `/api/admin/login` | POST | Public; resulting role must be admin | Zod + Origin | RL | Distributed brute-force bypass. |
| `/api/admin/logout` | POST | Clears caller session | Origin | None | Low risk. |
| `/api/admin/persistence` | GET | admin/super-admin | N/A | None | Safe no-store status; ensure response stays non-secret. |
| `/api/admin/site` | GET, PUT | admin/super-admin | Full-site normalize/validate; PUT Origin | None | Stale overwrite P1-06; missing state refinements P2-04. |
| `/api/admin/snapshot` | GET | admin/super-admin | N/A | None | Large PII response; no pagination, role separation. |
| `/api/admin/tickets` | PATCH | admin/super-admin | Status allow-list; Origin | None | Can roll check-in back; audited but no dual control. |
| `/api/admin/upload` | POST | admin/super-admin | MIME allow-list, 25 MB after parse, Origin | None | MIME spoofing/memory/abandoned public objects P2-05. |
| `/api/applications` | GET, POST | customer | Zod outer shape + Origin on POST | POST RL | Dynamic-field bypass P2-02. |
| `/api/auth/login` | POST | Public | Zod + Origin | RL | Distributed brute-force bypass. |
| `/api/auth/logout` | POST | Caller session | Origin | None | Low risk. |
| `/api/auth/signup` | POST | Public | Zod + Origin | RL | Non-transactional user creation P1-07. |
| `/api/check-in` | GET, POST | scanner/door/admin roles | Token/event query/manual body; POST Origin | None | Global event PII access; wrong-event entitlement disclosure P1-05. |
| `/api/checkout/create` | POST | customer | Zod + Origin; server prices | RL | Payment/state races P0; assigned-product gap P2-03. |
| `/api/checkout/test-complete` | POST | customer; live server hard block | Ownership + Origin | None | Live/CMS mode deadlock P1-02. |
| `/api/contact` | POST | Public | Zod + Origin | RL | Shared-rate-limit weakness; provider errors may leak. |
| `/api/entitlements/redeem` | POST | door/admin (scanner excluded) | Manual ID/quantity + Origin | None | Cross-event redemption P1-05. |
| `/api/events/access` | POST | Public | Zod + Origin, password HMAC | RL | Brute force limited only per instance. |
| `/api/newsletter` | POST | Public | Email schema + Origin | RL | No durable consent/event history beyond JSON. |
| `/api/reviews` | POST | Optional customer | Zod + Origin | RL | Public spam; full-site hot-document write. React output escaping limits XSS. |
| `/api/stripe/webhook` | POST | Stripe signature | Raw body signature + event parsing | None (appropriate) | Missing event families/recovery; raw server logging. |
| `/api/tickets/verify` | POST | Public possession token | Manual string/event; HMAC check | RL | Holder name exposed to bearer; rate limit not distributed. |

No open redirect was found in the auth callback (`next` must begin with `/`). No SQL string construction or filesystem path traversal was found. Public configurable URLs are rendered as links/media rather than server-fetched, so no direct SSRF sink was identified. React escaping limits stored/reflected XSS in reviewed public content, but CSP and URL/MIME policy should still be strengthened. Private API responses use no-store helpers where reviewed.

## Customer journey findings

- Application flow captures terms/privacy/entry consent as required booleans and keeps sponsor marketing separate. The sponsor export selects the latest consent per user/event and filters accepted consent. Dynamic answer semantics remain bypassable (P2-02).
- Duplicate active applications are blocked, but the per-instance limiter is insufficient against distributed spam. Approval without an Auth account is possible if data became inconsistent; signup is non-transactional (P1-07).
- Invite approval creates/reuses an allocation and sends status email, but repeated approval or allocation changes during checkout are unsafe (P0-02). Allocation quantity is not validated against all sale limits at decision time (P2-16).
- Checkout uses server prices, enforces active ticket sales windows, customer/event/ticket capacity and product stock/limits when reserving. Forged unassigned products and contradictory event states remain possible.
- Paid ticket display is ownership-filtered. Refresh/replay of successful webhook is broadly idempotent, but provider/local split failures have no recovery surface.
- Rejection and approval/unlock emails exist. Hold/waitlist uses the review status template path; payment ticket and application receipt are implemented. Email delivery is not a transaction and lacks a durable retry queue.

## Admin/CMS findings

- Full-site save normalizes and validates the entire document. This can make an unrelated malformed legacy record block every save; only selected legacy structures are normalized. Prefer section-scoped schemas/migrations and conflict-aware saves.
- Duplicate core IDs and many malformed URLs are checked. State combinations, window ordering and assignment relationships are not comprehensive (P2-04).
- Quick publish actions mutate lifecycle/visibility/ticket settings together in the UI. Because the server accepts the resulting whole document without an explicit transition command or version, stale state and accidental sales opening remain possible.
- Upload can succeed before the site reference is saved; failed/abandoned saves leave orphan objects. Deleting CMS records removes references, not necessarily the stored object. No media garbage collection was found.
- Admin snapshot, email logs and exports contain customer PII. Roles are coarse: admin and super-admin have nearly identical access, while door roles are globally scoped. Add least-privileged permissions and event assignments.
- Persistence verification checks the provider and persisted versions, which is useful, but does not prove a write survived a concurrent stale editor or that deployed RLS/storage policies match the repository.

## Mobile/accessibility findings

Installed Edge was used headlessly for static renders at 360, 390, 430, 768 and 1440 px without adding packages. Reviewed routes included `/`, `/events`, an event detail, apply, contact, media, reviews, login, admin login, terms and direct checkout.

- Homepage, event list/detail and admin login were generally readable at sampled sizes.
- Contact at 390 px, reviews at 360 px, login at 390 px and terms at 360 px visibly clipped right-side headings/body/form content. The CSS root permits horizontal overflow (P2-09).
- The event detail visibly rendered corrupted punctuation from local seed data (P2-11).
- Signed-out direct checkout rendered the Next development error overlay for `AUTH_REQUIRED` (P1-04).
- Form inputs reviewed use mobile-friendly sizing in CSS and visible text labels are common. Full keyboard order, focus visibility, screen-reader naming, 200% zoom, reduced motion behavior, camera permissions, back-button submission and hydration-console checks were not fully testable without the in-app interactive browser control.

## Missing automated tests

No permanent test runner, test files, or `test` script exists. `npm run verify` covers lint, TypeScript and production build only.

| Required suite | Minimum cases | Priority |
|---|---|---|
| Stripe reconciliation | Metadata/session/PI/amount/currency mismatch; unpaid completion; async success/failure; expiry; duplicate event; orphan Session | P0 |
| Fulfilment idempotency | Concurrent duplicate webhooks; persistence failure; paid-unfulfilled recovery; email failure | P0 |
| Checkout validation | Forged prices/products, invalid state combinations, sales windows, max order/customer | P0/P1 |
| Capacity/product stock races | Simultaneous final ticket/product, reservation expiry, CMS edit during Session | P0 |
| Allocation lifecycle | Approve/reapprove/extend/cancel/expire while Session active | P0 |
| Refund/dispute | Full/partial refund, dispute open/win/loss, ticket/entitlement invalidation | P1 |
| Event visibility state matrix | Every lifecycle × visibility × ticket-mode combination; guessed URLs | P1 |
| Free RSVP | Zero-price enforcement, no Stripe path, capacity/idempotency | P1 |
| Admin persistence | Stale version conflict, two admins, section validation, reload equality | P1 |
| QR/check-in | Forged token, duplicate simultaneous scan, wrong event, refund/cancel, manual audit | P1 |
| Product redemption | Per-unit simultaneous devices, wrong event, refund, inactive/window/stock | P1 |
| Authentication/authorization | All API/page role permutations, IDOR, reset/confirmation/logout/disabled user | P1 |
| Rate limiting | Multi-instance/shared counter, trusted IP, per-user/email keys, 429 headers | P1 |
| Media uploads | Size before buffering, MIME/magic mismatch, SVG/polyglot, orphan cleanup, authorization | P2 |
| Mobile/accessibility | 360/390/430/tablet/desktop overflow; keyboard, focus, labels, reduced motion | P2 |
| Timezone | Melbourne DST gap/fold, remote admin, UTC boundary, expiry/sorting | P2 |

## Launch-blocking checklist

- [ ] Prevent/expire payable Stripe Sessions when allocations or event sale state change (P0-01, P0-02, P1-11).
- [ ] Make reservation and paid fulfilment immutable/recoverable when inventory/config changes (P0-03).
- [ ] Implement durable paid-unfulfilled reconciliation and an operator refund/fulfil workflow (P1-12).
- [ ] Handle refunds, partial refunds, disputes and ticket/product invalidation (P1-01).
- [ ] Remove live/test split-brain checkout behavior and add a deployment health assertion (P1-02).
- [ ] Enforce the event state matrix server-side, including coming-soon (P1-03).
- [ ] Redirect unauthenticated checkout to login (P1-04).
- [ ] Scope door staff to assigned events and bind redemption to event/order (P1-05).
- [ ] Add stale-write protection to CMS before multi-operator use (P1-06).
- [ ] Add signup compensation/repair (P1-07) and orphan-Session recovery (P1-08).
- [ ] Move transactional sale/entry/redemption records to constrained relational tables/RPCs (P1-09), or obtain load/concurrency evidence for an explicitly limited launch.
- [ ] Deploy and verify shared abuse controls (P1-10).
- [ ] Run all P0/P1 integration suites in isolated Stripe test + staging Supabase; rehearse recovery.

## Recommended repair order

1. Introduce a durable checkout/reservation/payment state model with immutable reservation versions and `paid_unfulfilled` recovery; fix all Session cancellation/mutation paths.
2. Add Stripe webhook inbox/idempotency constraints, reconciliation, refunds/disputes, Session expiry and operator tooling.
3. Normalize orders, lines, reservations, payments, tickets, entitlements, check-ins and email outbox into Postgres with transactions/locks/constraints/RPCs.
4. Centralize and enforce event/allocation/product state machines at CMS save, checkout and fulfilment boundaries.
5. Fix door event scoping/redemption authorization, shared rate limiting, raw error responses and signup repair.
6. Add conflict-aware CMS persistence and hardened upload lifecycle.
7. Add the P0/P1 automated suites before enabling payment; then repair mobile, timezone, email recovery, SEO/privacy and performance items.
8. Complete staging operational drills: paid webhook failure, refund, email retry, sold-out race, two-device scan/redeem, backup restore and door-network outage.

## Files inspected

Repository inventory and focused/deep reads included:

- Root/config: `package.json`, lockfile metadata, `.gitignore`, `.env.example` (names only), `next.config.ts`, `tsconfig.json`, `proxy.ts`, `README.md`, `VERIFY.ps1`.
- Documentation: all files under `docs/`, including architecture, security, Stripe, Supabase and production checklists.
- Data/schema: `supabase/schema.sql`, `supabase/seed.sql`, `data/site.json`, `data/operations.json` (structure only; no personal values reproduced).
- Core server: all files under `src/lib/`, with deep tracing of configuration, mode, auth/session, data documents, operations, payments/reconciliation, email, validation, security and platform helpers.
- APIs: every one of the 25 route files under `src/app/api`.
- Pages/layouts: every App Router page/layout/route under `src/app`, including all named public, legal, checkout, account, ticket and admin surfaces.
- UI: all component files were inventoried/scanned; checkout, auth, application, QR, public shell, event/public page components, admin studio/panels, uploader, check-in and email/export surfaces received focused review.
- Styling/types: `src/app/globals.css` and all `src/types/*`.

Tracked environment values were never printed. The ignored `.env.local` was inspected only by variable-name presence and safe boolean classification; its values were not displayed or copied.

## Commands run

Sanitized outputs are in `deep-bug-command-output.txt`.

- `git status --short`
- `git log -8 --oneline`
- `git diff --check`
- `npm run verify` (lint, typecheck, build)
- `npm run build` once after browser cleanup to restore Next's generated `next-env.d.ts` pointer
- `npm audit --omit=dev` (read-only; no fix)
- `rg --files` and targeted `rg -n` source/config/security scans
- Read-only environment-name/configuration-presence checks
- Local-only `npm run dev`, HTTP probes, installed Edge headless screenshots at required viewports, and an attempted Chrome DevTools Protocol overflow measurement
- Final `git status --short` and `git diff --check`

No test command was run because no test script/test suite exists. No package was installed. No production Supabase, Stripe, Resend, media or email action was invoked.

## Areas that could not be tested and why

- Production Supabase RLS, storage policies, database contents, concurrency and backup restoration: no production writes or sensitive access were permitted.
- Stripe webhook dashboard configuration, real asynchronous settlement, refunds/disputes and provider outages: no real charge was permitted and credentials were not configured in the local test environment.
- Resend delivery/domain reputation and Supabase Auth SMTP: external email was prohibited/unconfigured.
- Vercel runtime behavior, WAF/rate limiting, logs, alerting and environment correctness: deployment access was outside local scope.
- Fully interactive browser QA (keyboard, focus order, back/refresh, camera scanning, authenticated multi-role flows, hydration console): the prescribed in-app browser automation interface was unavailable. Installed Edge headless rendering and local HTTP checks were used as a fallback; a direct CDP measurement attempt could not connect.
- Two-device/high-concurrency behavior: reasoned from mutation semantics but not load-tested because no permanent test harness exists and new packages could not be installed.
- Media upload persistence: production uploads were prohibited; code and policy were reviewed only.

These untested areas do not reduce the severity of the confirmed source-level payment and authorization findings.
