# SKIE EVENTS Isolated Staging Rollout Plan

Revision: `bff06ef19f08f512285756bf94f82aa98bc0df0a` (`bff06ef Complete launch hardening, notifications, promos and media`)

Prepared: 2026-07-22 (Australia/Sydney)

Status: **PLAN ONLY / NO ACTION AUTHORIZED / PRODUCTION NO-GO**

This plan is for a separately approved rehearsal in a new, isolated staging environment. It does not authorize this session to contact Supabase, Stripe, Resend, Vercel, hosted Storage, or production; apply a migration; deploy; or send a message or payment action. Production identifiers, credentials, data, domains, webhooks, sender identities, and projects must never be used during this rehearsal.

## 1. Exact staging prerequisites

- [ ] Use a clean checkout of exactly `bff06ef19f08f512285756bf94f82aa98bc0df0a`; do not roll out from the current working directory or include unreviewed files.
- [ ] Record the commit, branch, Node/npm versions, Supabase CLI version, operator, UTC start time, change ticket, and evidence location.
- [ ] Assign named database, application/operator, security, payment, email, incident, and rollback owners. Database, security, payment, email, and rollback owners must be present for their gates.
- [ ] Obtain explicit authorization for a new Supabase staging project, isolated staging runtime/hostname, Stripe **test-mode** account or sandbox, Resend staging sender, and allowlisted test recipients.
- [ ] Prove every project reference, hostname, database host, Stripe key, webhook endpoint, Resend sender, and email recipient is staging-only. A production match is an immediate stop.
- [ ] Create no network path, environment alias, DNS alias, webhook endpoint, or credential fallback to production.
- [ ] Use synthetic identities and events only. Do not clone, restore, export, query, or copy production/customer/payment/message/media data.
- [ ] Keep checkout closed, the notification schedule disabled, and the admin live-mode intent set to `test` until the relevant bounded drill begins.
- [ ] Confirm a verified empty-project backup/restore point or a tested recreate procedure, with recovery owner and target time recorded.
- [ ] Confirm staging PostgreSQL major version 17, matching `supabase/config.toml`.
- [ ] Confirm the application hostname uses HTTPS and Supabase Auth allowlists only the staging origin and its exact `/auth/callback` URL.
- [ ] Confirm logs have restricted access and retention, correlation-ID lookup works, and secrets/provider payloads/customer fields are redacted.
- [ ] Do not run `supabase/schema.sql`. Run the reviewed `supabase/seed.sql` only once, after all nine migrations, on the new empty staging project; it creates the synthetic versioned documents required by the application and must not be rerun over populated staging data.
- [ ] Capture a clean local release-candidate gate before any hosted action:

```powershell
git rev-parse HEAD
git status --porcelain
npm ci
npm run test:database
npm test
npm run test:phase3
npm run test:payments
npm run test:security
npm run test:notifications
npm run test:promos
npm run test:media
npm run test:browser
npm run verify
npm audit --omit=dev
git diff --check
```

Expected commit output is exactly `bff06ef19f08f512285756bf94f82aa98bc0df0a`; `git status --porcelain` must be empty. Any failed command is NO-GO.

## 2. Exact Supabase staging setup

These are future operator steps, not commands to run in the current session.

1. Create a brand-new Supabase project dedicated to this rehearsal, in the approved region closest to Melbourne. Name it unambiguously with `staging`; do not clone or branch production.
2. Record the staging project reference and database host out-of-band. Two people compare them against the production deny-list before continuing.
3. In staging Auth configuration, set the Site URL to the exact HTTPS staging origin and allow only the exact staging origin and staging `/auth/callback`. Leave unneeded OAuth/SMS providers disabled. Restrict signup after the synthetic users are created.
4. Store the project URL, anon key, and service-role key only in the staging runtime's encrypted environment. Store the database password only in the approved operator secret store. Never place values in the repository, command output, screenshots, or evidence.
5. From a clean checkout at the pinned commit, authenticate the Supabase CLI with the operator's staging-scoped account and link only the verified staging project:

```powershell
npx supabase@latest login
npx supabase@latest link --project-ref <STAGING_PROJECT_REF>
npx supabase@latest migration list --linked
npx supabase@latest db push --linked --include-all --dry-run
```

6. The dry run must list exactly the nine files in section 4, in that order, and no schema, seed, repair, remote-only, or unreviewed file. Have the database and security owners sign the dry-run output.
7. Take and verify the empty-project restore point immediately before applying the chain. Keep checkout closed and no application worker running.
8. Apply the reviewed chain once through the linked migration workflow:

```powershell
npx supabase@latest db push --linked --include-all
npx supabase@latest migration list --linked
```

9. Stop on the first error. Record only the sanitized PostgreSQL code and object name. Do not paste a partial function into SQL Editor and do not mark a failed migration as applied. Restore/recreate the isolated project and rerun the unchanged reviewed chain from empty state.
10. Run the read-only catalog/RLS/grant smoke first. Then, only on this empty isolated project, apply the reviewed synthetic documents once using protected `PG*` environment variables (as described in section 5):

```powershell
psql -X -qAt -v ON_ERROR_STOP=1 -f supabase/seed.sql
```

11. Create the minimum synthetic Auth users needed by the assertions (at least one customer and one admin/super-admin) and promote only the designated synthetic administrator. Confirm their `public.profiles` trigger rows before continuing. Then run the rollback-safe assertion files and all 16 independent-session concurrency drills.

```sql
update public.profiles
set role = 'super_admin'
where lower(email) = lower('<SYNTHETIC_STAGING_ADMIN_EMAIL>');

select id, email, role
from public.profiles
where lower(email) in (
  lower('<SYNTHETIC_STAGING_ADMIN_EMAIL>'),
  lower('<SYNTHETIC_STAGING_CUSTOMER_EMAIL>')
)
order by email;
```

The update must affect exactly one row; the select must return only the two expected staging identities. Do not capture IDs/emails in broadly accessible evidence.

12. Create all remaining fixtures through reviewed application/admin flows where possible. Direct SQL fixture creation must be transaction-wrapped, synthetic-only, and separately reviewed.
13. Deploy the exact pinned application revision to the isolated staging runtime initially with `APP_MODE=test`, `DATA_PROVIDER=supabase`, `EMAIL_PROVIDER=local`, checkout closed, admin mode `test`, and no cron/schedule.
14. Verify login/callback URLs, server-only key isolation, persistence, roles, proxy/header behavior, rate-limit store-failure `503`, correlation IDs, and Storage before beginning provider drills.

`supabase/README.md` contains older bootstrap and migration instructions. For this revision, the nine-file chain in this plan and `MIGRATION_RUNBOOK.md` is authoritative; only its once-after-migrations seed intent remains applicable to the new empty staging project.

## 3. Required environment variables by provider

Values must be staging-only and secret values must never be printed. `NEXT_PUBLIC_*` values are browser-visible by design; no secret may use that prefix.

### Application/runtime

| Variable | Staging requirement |
| --- | --- |
| `APP_MODE` | Default `test`. Temporarily `live` only for the bounded Stripe/Resend adapter drill described below, because the real adapters otherwise remain disabled. Never pair with live provider credentials. |
| `DATA_PROVIDER` | `supabase` |
| `NEXT_PUBLIC_SITE_URL` | Exact isolated HTTPS staging origin |
| `NEXT_PUBLIC_BRAND_NAME` | `SKIE EVENTS` |
| `APP_TIMEZONE` | `Australia/Melbourne` |
| `APP_CURRENCY` | `AUD` |
| `DEFAULT_TICKET_LIMIT` | Reviewed value; baseline `2` |
| `DEFAULT_ALLOCATION_EXPIRY_HOURS` | Reviewed value; baseline `48` |
| `AUTH_SECRET` | Staging-only random value, at least 32 characters |
| `TICKET_TOKEN_SECRET` | Separate staging-only random value, at least 32 characters; must differ from `AUTH_SECRET` |
| `ADMIN_EMAIL` | Synthetic staging administrator only |
| `ADMIN_PASSWORD` | Staging-only high-entropy value; never the example/default |
| `RATE_LIMIT_MAX` | Reviewed value; baseline `30` |
| `RATE_LIMIT_WINDOW_SECONDS` | Reviewed value; baseline `60` |

### Supabase/Auth/Storage

| Variable | Staging requirement |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Isolated staging project URL only |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Isolated staging anon key only |
| `SUPABASE_SERVICE_ROLE_KEY` | Isolated staging service-role key, server-side only |

Operator-only database/CLI credentials are not application variables. Keep the staging project reference, access token, database host/user/password, or connection string in the approved secret store; do not commit them or pass a full connection string on a command line.

### Stripe test mode

| Variable | Staging requirement |
| --- | --- |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_...` only |
| `STRIPE_SECRET_KEY` | `sk_test_...` only, server-side |
| `STRIPE_WEBHOOK_SECRET` | Secret for the staging endpoint only (`whsec_...`), server-side |

Remote promo/coupon objects are not used by this implementation; discounts remain server/database-owned.

### Resend staging email

| Variable | Staging requirement |
| --- | --- |
| `EMAIL_PROVIDER` | Default `local`; temporarily `resend` only for the approved delivery drill |
| `RESEND_API_KEY` | Reviewed staging-scoped key, server-side only |
| `EMAIL_FROM` | Verified staging sender/domain |
| `EMAIL_REPLY_TO` | Monitored staging/support mailbox |
| `NOTIFICATION_WORKER_SECRET` | Separate high-entropy server-to-server secret |

Do not configure Twilio/SMS variables. Phase 5 SMS is not implemented. Do not enable any external schedule/cron during this rollout; `CRON_SECRET` is not consumed by the implemented worker route, which authenticates with `NOTIFICATION_WORKER_SECRET`.

### Hosting/runtime boundary

`VERCEL=1`, if present, must be platform-managed rather than manually supplied. It changes trusted proxy-header handling, so verify it only on the isolated staging deployment. Environment scopes, domains, build cache, logs, and aliases must not reference production.

## 4. Nine-migration order and reviewed hashes

Before the rehearsal, reproduce these hashes with the command below and compare all nine exactly:

```powershell
Get-ChildItem -LiteralPath supabase/migrations -Filter *.sql |
  Sort-Object Name |
  ForEach-Object {
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName
    "{0}  {1}" -f $hash.Hash.ToLowerInvariant(), $_.Name
  }
```

| Order | Migration | SHA-256 at `bff06ef` |
| ---: | --- | --- |
| 1 | `20260716_bootstrap_core_schema.sql` | `c8ad14e731b23b7ac5d1955f702c7baf2fba9e761d925a829682ef30284d683a` |
| 2 | `20260717000000_repair_application_consents.sql` | `a8ddbb85d8835ac39961349c5e2e810d2d16518998f762a9c5b3d70159da4f11` |
| 3 | `20260717000001_restrict_profile_role_updates.sql` | `2ef3151aa8aed2ec3dc451e205c6c409757b2cf1183a21bb02a216805c88d57b` |
| 4 | `20260721000000_launch_transaction_foundation.sql` | `457c1e9109678ad95e8e31111ee64cf7f8c6e8769d82f200fb3e2b28c21d620d` |
| 5 | `20260721000001_launch_transaction_rpcs.sql` | `76866bdabdf8bf91c0e3897c40b110b9bf75deaddb60bfd871701264650356fe` |
| 6 | `20260722000000_phase3_launch_hardening.sql` | `51fe51a7fb3f3c51678bd6e3e2bd3070b72cd3aabc97f60901616ced0596bf29` |
| 7 | `20260722010000_phase4_notifications.sql` | `78b62edca37f4b17a9bb241b122f68ba7a4e8429ff43ad37ec58a43e07eac763` |
| 8 | `20260722020000_phase6_promos.sql` | `ce0b5b9fb2cb7f7a1a633dab3215166d9a9d1a531f172df926e7df2238c07311` |
| 9 | `20260722030000_phase7_media.sql` | `74e80c38ebad33d6b66b758065de2c38726c0f75774e7c1f15e7007fef173c6b` |

Each file contains its own `begin;`/`commit;`. A changed hash, missing transaction boundary, unexpected tenth file, or different order is NO-GO.

The separately applied, once-only synthetic seed hash at this revision is `b9a08076cc6357c1ad7a31336c5a50573626eb76f17536de34401c6d65a0d969` for `supabase/seed.sql`. It is not a tenth migration.

## 5. Verification commands and evidence

### Migration and database assertions

After setting `PGHOST`, `PGPORT=5432`, `PGDATABASE=postgres`, `PGUSER`, `PGPASSWORD`, and `PGSSLMODE=require` in the operator's protected process environment, run the rollback-safe SQL assertion files without putting a connection string on the command line:

```powershell
psql -X -qAt -v ON_ERROR_STOP=1 -f tests/database/phase2-local-assertions.sql
psql -X -qAt -v ON_ERROR_STOP=1 -f tests/database/phase3-local-assertions.sql
psql -X -qAt -v ON_ERROR_STOP=1 -f tests/database/phase4-local-assertions.sql
psql -X -qAt -v ON_ERROR_STOP=1 -f tests/database/phase6-local-assertions.sql
psql -X -qAt -v ON_ERROR_STOP=1 -f tests/database/phase7-local-assertions.sql
```

Expected terminal markers are `PASS|catalog-security-rpc-role-scope`, `PASS|phase3-catalog-security-state-staff-rate-limit`, `PASS|phase4-notification-catalog-security-behavior`, `PASS|phase6-promo-catalog-security-lifecycle`, and `PASS|phase7-media-catalog-storage-security`. The files wrap fixture writes in transactions and roll them back; review this property again at the pinned commit before using them.

Run the minimum read-only catalog smoke separately and retain sanitized output:

```sql
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('reservations','checkout_attempts','orders','payments','stripe_webhook_events','tickets','entitlements')
order by relname;

select routine_name, security_type
from information_schema.routines
where routine_schema = 'public' and routine_name like 'skie_%'
order by routine_name;

select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('reservations','orders','payments','tickets','entitlements')
order by table_name, grantee, privilege_type;
```

The existing `tests/database/*-local-verification.ps1` race harnesses are deliberately hard-coded to the local Docker container. Do **not** point them at hosted staging or weaken their local guard. Before rollout, approve a staging-safe two-connection runner that executes the same 16 cases against synthetic fixtures. Until all cases below have captured before/after counts and PASS evidence, staging promotion is NO-GO:

1. Final event ticket: two reservations, exactly one winner.
2. Final product: two reservations, exactly one winner.
3. Same attempt/provider Session replay succeeds; a different Session conflicts.
4. Paid webhook replay produces one payment and exact ticket/entitlement counts.
5. Wrong amount/currency/order/PaymentIntent preserves inbox/evidence and enters review as specified.
6. Forced post-payment fulfilment failure produces durable payment plus `paid_unfulfilled`.
7. Fulfilment retry creates no duplicate ticket, entitlement, or allocation quantity.
8. Full-refund replay invalidates access once and remains idempotent.
9. Unattributable partial refund enters review; attributed partial refund affects only named lines.
10. Dispute creation suspends; won restores; lost/closed invalidates.
11. Concurrent QR check-in has one valid result followed by duplicate; invalid token never checks in.
12. Wrong-event staff search/scan/redemption is denied and redacted.
13. Notification and promo claims use skip-locked behavior with no double claim.
14. Shared rate-limit final slot yields one allow/one deny and capped persisted count.
15. CMS stale-save race yields one save, one stable conflict, and one version increment.
16. Emergency close winning the shared lock returns `EVENT_SALES_CLOSED` and creates no reservation.

### Application verification after staging deployment

```powershell
$base = 'https://<STAGING_HOST>'
Invoke-WebRequest -UseBasicParsing "$base/" | Select-Object StatusCode
Invoke-WebRequest -UseBasicParsing "$base/events" | Select-Object StatusCode
Invoke-WebRequest -UseBasicParsing "$base/account" -MaximumRedirection 0 -SkipHttpErrorCheck | Select-Object StatusCode,Headers
Invoke-WebRequest -UseBasicParsing "$base/api/stripe/webhook" -Method Post -Body '{}' -ContentType 'application/json' -SkipHttpErrorCheck | Select-Object StatusCode
```

Expected: public routes succeed; protected routes redirect/authenticate safely; an unsigned webhook returns `400` with `WEBHOOK_SIGNATURE_MISSING`. Never include tokens, customer data, or secrets in captured output.

## 6. Synthetic test data plan

Use a unique run ID such as `stg-bff06ef-YYYYMMDD-HHMM`. Prefix every display name, event slug, promo code, idempotency key, and media title with it. Use only an approved non-production test domain and recipient allowlist.

Create:

- two super/admin operators for the stale-write test;
- one ordinary admin for authorization boundaries;
- two customers for ownership, race, first-purchase, refund, and reconciliation tests;
- one scanner-only and one door-staff user, with active, future, expired, and revoked assignments;
- a partial-signup user for idempotent profile/customer repair and role preservation;
- Event A and Event B, plus fixtures covering draft, preview, published, hidden, private-link, password, coming-soon, closed, archived, and cancelled states;
- one final-unit public ticket, one final-unit allocation ticket, one final-unit product, and normal-capacity equivalents;
- percentage and fixed-AUD promos covering inactive/expired/future windows, event/ticket/product restrictions, minimum order, per-customer, first-purchase, redemption, and discounted-unit limits;
- one multi-ticket order with named holders and add-ons, and separate orders for replay, paid-unfulfilled, full/partial refund, dispute, expiry, and cancellation;
- one JPEG, PNG, WebP, AVIF, MP4, and WebM fixture within limits; one poster image; and negative SVG, GIF, MIME-mismatch, malformed-name, traversal-name, 10 MiB-plus image, and 50 MiB-plus video fixtures.

No synthetic event may be discoverable from production. No test email may target an unapproved address. Keep an inventory mapping the run ID to synthetic rows/provider objects without recording QR/token/secret values. After sign-off, close synthetic sales and retain immutable financial/webhook/audit evidence for the agreed staging retention period; delete the disposable staging project only under the rollback owner's approved cleanup procedure.

## 7. Stripe test-mode drill

1. Obtain separate payment-owner authorization. Verify in code/secret controls, without printing values, that the publishable and secret keys start with `pk_test_` and `sk_test_`; verify the webhook secret belongs only to the staging endpoint.
2. Configure the staging webhook endpoint at `https://<STAGING_HOST>/api/stripe/webhook` for exactly:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.refunded`
   - `refund.created`
   - `refund.updated`
   - `charge.dispute.created`
   - `charge.dispute.closed`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
3. Keep email on `EMAIL_PROVIDER=local`. Set server `APP_MODE=live` and switch the admin setting to `live` only for this bounded test window; the implementation otherwise returns a local test checkout URL and will not call Stripe. Confirm `DATA_PROVIDER=supabase` and test keys again before enabling the switch.
4. Open only the synthetic event needed for the drill. Complete one low-value AUD payment with a multi-line discounted basket. Record order, reservation, Session, PaymentIntent, amount, currency, discount, and fulfilment status using IDs only.
5. Prove amount/currency/order/Session/PaymentIntent reconciliation, exact ticket/entitlement counts, promo finalization, and notification enqueue downstream of committed fulfilment.
6. Replay the same event and prove no duplicate payment, ticket, entitlement, allocation consumption, promo claim, or email outbox item.
7. Exercise async failure/expiry and Session-creation failure/release; prove inventory and promo reservation release follow policy.
8. Inject the reviewed fulfilment failure, prove durable payment plus `paid_unfulfilled`, then recover and prove no duplicate fulfilment.
9. Exercise full refund, duplicate refund event, attributed partial refund, unattributable partial-refund review, dispute creation, dispute won, and dispute lost/closed. Prove access suspend/restore/invalidation behavior and immutable evidence.
10. Test payment failure and cancellation events. Confirm no fake checkout URL is ever emitted while the effective mode is live.
11. Close the synthetic event, set the admin intent back to `test`, return server `APP_MODE=test`, and verify no active test Sessions remain unresolved. Keep verified webhook receipt available until reconciliation is complete.

Any `sk_live_`/`pk_live_` key, production webhook target, unverified amount/currency, duplicate fulfilment, unresolved Session, or missing payment evidence is immediate NO-GO.

## 8. Resend staging email drill

1. Obtain email-owner authorization. Verify the staging sending domain, `EMAIL_FROM`, `EMAIL_REPLY_TO`, support mailbox, staging-scoped key, and allowlisted recipient. Cron remains disabled.
2. With `APP_MODE=test` and `EMAIL_PROVIDER=local`, generate/preview every HTML and text template. Create one synthetic multi-ticket/add-on outbox item and run a dry batch:

```powershell
$headers = @{ Authorization = "Bearer $env:NOTIFICATION_WORKER_SECRET" }
$body = @{ batchSize = 1; dryRun = $true } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'https://<STAGING_HOST>/api/internal/notifications/process' -Headers $headers -ContentType 'application/json' -Body $body
```

3. Confirm one labelled QR per valid ticket, CID attachments, plain-text content, event/order/purchaser fields, add-ons, account/policy links, and absence of refunded/suspended tickets.
4. Clear or finish every unrelated synthetic pending item so the approved recipient is the only eligible row. Set `APP_MODE=live`, `EMAIL_PROVIDER=resend`, and the admin intent to `live` for the bounded delivery window. This dual switch is required by the adapter implementation.
5. Send exactly one approved message with `batchSize=1` and `dryRun=false`. Inspect desktop/mobile and representative clients, including images-disabled/plain-text views.
6. Prove one provider message ID, one attempt, stable idempotency, safe error code retention, no QR/recipient/message/provider payload leakage in logs, and no payment/fulfilment rollback.
7. Exercise one controlled temporary failure/retry and one terminal failure using reviewed synthetic items; prove bounded retry and terminal state. Prove non-admin denial, pending cancellation, status filters, and attempt history.
8. Immediately return `EMAIL_PROVIDER=local`, admin intent `test`, and server `APP_MODE=test`. Leave cron disabled until a separate scheduling review approves the implemented worker authentication contract.

## 9. Storage/media drill

1. Verify the `media` bucket exists, is public-read, has a 52,428,800-byte bucket limit, and allows only JPEG, PNG, WebP, AVIF, MP4, and WebM.
2. Verify `media_objects` has RLS; `anon` and `authenticated` have no direct table mutation grant; Storage has the single reviewed public-read policy and no browser `INSERT`, `UPDATE`, or `DELETE` policy.
3. As synthetic admin, upload each allowed type through the application. Images must be at most 10 MiB; videos at most 50 MiB; requests above 51 MiB are rejected. Confirm server-generated keys match `images|videos/YYYY/MM/<uuid>.<ext>` and registry metadata matches detected content.
4. Verify upload progress, cancel, retry, preview, poster selection, replace, reorder, focal position, publish/unpublish, and two-session CAS conflict/reload.
5. Reject SVG, GIF/unsupported signature, MIME mismatch, oversized image/video, malformed/traversal/control-character filename, wrong-origin request, non-admin request, and video-as-poster. Confirm no orphaned object remains after a registry failure.
6. Fetch a published public asset without authentication. Attempt direct browser/anon/authenticated writes and confirm denial.
7. Remove references, verify referenced deletion is refused, mark/reconcile an orphan, wait the minimum 24-hour policy or use an aged synthetic fixture, then run bounded orphan cleanup. Never bulk-delete the bucket.
8. On iOS Safari, Android Chrome, and desktop browsers, verify muted loop, inline playback, poster/error fallback, keyboard/native controls, off-screen pause, reduced-motion/data-saver pause, aspect ratio, no layout shift, and no horizontal overflow.

## 10. Manual QA checklist

### Event, auth, staff, and security

- [ ] At 360/390/430/768/1440 widths, exercise every event lifecycle/visibility/ticket-mode combination from listing, guessed detail, apply, allocation checkout, and direct checkout.
- [ ] Verify password/private-link access and server-side sale-window enforcement in `Australia/Melbourne`, including DST boundary fixtures.
- [ ] Sign in through account and checkout; retain exact safe relative return paths and reject external, protocol-relative, encoded, backslash, control-character, API, and malformed destinations.
- [ ] In two admin sessions, save from one CMS version: one succeeds, one receives stable `409`, unsaved text is preserved, and reload equals the committed version.
- [ ] Assign/expire/revoke scanner-only and door-staff access for two events; verify wrong-event redaction, scanner product-redemption denial, and no CMS/payment-recovery access.
- [ ] Repair the partial signup twice; verify one profile/customer, preserved role, and one appropriate audit outcome.
- [ ] Trigger protected route limits; verify stable `429` plus `Retry-After`, shared final-slot behavior, cleanup, and store-failure `503` without PII.
- [ ] Inspect logs for correlation IDs and prove no authorization headers, secrets, tokens, QR values, full recipient addresses, bodies, provider payloads, or customer records.

### Notifications, promos, payments, and door entry

- [ ] Complete all Stripe and Resend drill items above with owner sign-off.
- [ ] Verify every email template, multi-ticket/add-on output, refund/suspension resend behavior, admin status/retry/cancel/history, and non-admin denial.
- [ ] Exercise percentage/fixed-AUD promo rules, restrictions, windows, limits, mixed baskets, GST display, concurrent last redemption/unit, Session failure release, paid finalization, replay, and refund reporting.
- [ ] Verify duplicate QR scan atomicity, refunded/suspended denial, wrong-event redaction, scanner camera permission/hardware, offline/no-network procedure, escalation, and reconnect reconciliation.

### Accessibility and devices

- [ ] Complete keyboard-only navigation, visible focus, screen-reader labels/status, 200% zoom/reflow, and reduced-motion checks.
- [ ] Complete real iOS Safari and Android Chrome media playback, data-saver behavior, camera permission, and scanner hardware tests.
- [ ] Verify mobile navigation, forms, checkout, admin tables/panels, QR rendering, and no overflow/layout shift at target widths.

### Sign-off

- [ ] Database owner signs migration, catalog, RLS/grants, backup/restore, and 16-race evidence.
- [ ] Security owner signs auth/role/redaction/log/proxy/rate-limit evidence.
- [ ] Payment owner signs Stripe test-mode reconciliation and Session inventory.
- [ ] Email owner signs sender, recipient, rendering, retry/idempotency, and cron-disabled evidence.
- [ ] Operator/incident/rollback owners sign manual QA, monitoring, containment, and recovery timing.

## 11. Rollback and containment

### Migration failure before application rollout

1. Stop immediately; keep checkout, workers, and application traffic disabled.
2. Preserve sanitized error code, migration filename, object name, and timestamps; capture no row payload or credential.
3. Do not edit a function/table manually and do not mark the migration applied.
4. Restore the verified empty-project point or recreate the disposable staging project, relink after two-person project-ref verification, and rerun the unchanged reviewed chain from migration 1.

### Application or database defect after rollout

1. Close new synthetic sales first. Continue accepting and recording verified Stripe test webhooks.
2. Preserve reservations, orders, payments, webhook inbox, tickets, entitlements, notification attempts, promo snapshots/redemptions, media registry, recovery actions, and audit rows.
3. Inventory all active Stripe test Sessions; expire or honour each under the recorded reservation policy. Never silently reject a paid Session.
4. Roll application traffic back only to the last revision proven schema-compatible with the additive nine-migration database.
5. Leave additive financial tables and evidence in place. Correct database defects with a reviewed forward migration; if necessary, revoke a defective RPC during an approved containment window.
6. Reconcile `paid_unfulfilled`, webhook retries/manual review, totals, promo usage, refunds/disputes, notification states, and media references before reopening.

### Provider-specific containment

- Stripe: close checkout, return admin intent/server mode to test, retain verified webhook receipt until all test Sessions/events reconcile, and never delete payment/webhook evidence.
- Resend: return `EMAIL_PROVIDER=local`, disable the worker/schedule, rotate a suspected key/worker secret, and retain the outbox/attempt audit. Do not delete queued history as rollback.
- Storage: unpublish references first; use reference-aware deletion only. Do not bulk-delete the bucket or registry.
- Hosting: remove staging traffic/alias only after provider callbacks and active Sessions are contained. Never redirect staging callbacks to production.

Reopen staging synthetic sales only after fresh database, security, payment, email, operator, and rollback go/no-go approval.

## 12. Clear NO-GO conditions

Stop and contain; do not proceed to the next phase if any condition is true:

- the checkout is not exactly commit `bff06ef19f08f512285756bf94f82aa98bc0df0a`, the worktree is dirty, or any reviewed migration hash differs;
- a project ref, host, credential, sender, recipient, DNS alias, callback, webhook, or data source is production or cannot be positively proven staging-only;
- required owners/authorization, deny-list comparison, empty restore point, recovery procedure, evidence location, or rollback timing is missing;
- the migration dry run lists anything other than the exact nine files/order, `schema.sql` is proposed, or `seed.sql` would run before migration 9 or be rerun over populated staging data;
- any migration errors, is partially applied, lacks its final commit, or requires a dashboard hand edit;
- any expected table/constraint/index/trigger/RLS policy is missing, a privileged function lacks fixed `search_path=public`, or `PUBLIC`/`anon`/`authenticated` has a forbidden mutation/RPC grant;
- any rollback-safe SQL assertion, local suite, build, dependency audit, browser smoke, or one of the 16 staging concurrency cases fails or lacks evidence;
- synthetic fixtures are not isolated, a real customer/recipient/media/payment record is present, or logs expose secrets, QR/token values, addresses, bodies, payloads, or customer fields;
- the deployed commit/environment does not match the recorded revision, HTTPS origin, Auth callback, PostgreSQL 17, Supabase project, or trusted-proxy assumptions;
- checkout or notification cron is enabled outside its bounded drill, or the application/admin mode switches are not visibly controlled and reversible;
- a Stripe key is not test-mode, the webhook is not staging-only, totals/currency/references do not reconcile, fulfilment duplicates, payment evidence is lost, or any active Session/manual-review item remains unresolved;
- the Resend sender/domain/recipient is unverified, more than the one approved message is eligible, retry/idempotency fails, or cron is enabled;
- Storage permits browser writes, accepts a forbidden type/size/path, leaves an unexplained orphan, deletes a referenced object, or fails required playback/fallback tests;
- authenticated multi-session, staff/event scope, promo, notification, media, accessibility, real-device, camera/scanner, backup/restore, or containment QA remains incomplete;
- any P0/P1 defect opens, or any P2 promotion blocker in `OVERNIGHT_REMAINING_BLOCKERS.md` remains incomplete.

Passing this staging plan produces evidence for a later production proposal only. It does not itself authorize production access, migration, provider configuration, deployment, or launch.
