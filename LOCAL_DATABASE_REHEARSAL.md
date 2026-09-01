# Local Database Rehearsal

Date: 2026-07-22  
Scope: local Supabase and local Docker only

Status: **PASS - Phase 2 local database verification complete.** Earlier blocked attempts below are retained as audit history; the authoritative final evidence is in the final verification section.

## Root cause

`20260717_repair_application_consents.sql` queried `public.platform_documents` before any migration created the table. The table and the other core prerequisites existed only in `supabase/schema.sql`, which is not part of the migration chain used by a clean `supabase db reset`.

The confirmed original PostgreSQL failure was:

- Migration: `20260717_repair_application_consents.sql`
- SQLSTATE: `42P01`
- Failing object: `public.platform_documents`
- Targeted correction: add a schema-only bootstrap migration that creates the table and every other core prerequisite before the 20260717 migrations.

## Migration corrections

- Added `20260716_bootstrap_core_schema.sql` before all existing migrations. It creates the core enum, profile/document tables, indexes, auth trigger/function, RLS policies, grants, and media bucket/read policy without inserting document, demo, customer, or production rows.
- Normalized both same-day migration pairs to unique 14-digit versions after local PostgreSQL proved that duplicate versions cannot be recorded by the current Supabase CLI. The resulting order is consent repair (`20260717000000`) then role restriction (`20260717000001`), followed by transaction foundation (`20260721000000`) then RPCs (`20260721000001`). Migration SQL was not changed.

## Attempts

### Local stack initialization attempt 1 — failed

- Command: `npx supabase@latest start` (local only)
- Migration reached: `20260717_restrict_profile_role_updates.sql`, after its SQL statements ran
- SQLSTATE: `23505`
- Failing object: `supabase_migrations.schema_migrations_pkey`
- Error: duplicate migration-history key for version `20260717`
- Targeted correction: renamed only the second same-version migration to `20260717000001_restrict_profile_role_updates.sql`, retaining its execution position between the consent repair and transaction foundation.

### Local stack initialization attempt 2 — failed

- Command: `npx supabase@latest start` (local only)
- Migration reached: `20260721_launch_transaction_rpcs.sql`, after its SQL statements ran
- SQLSTATE: `23505`
- Failing object: `supabase_migrations.schema_migrations_pkey`
- Error: duplicate migration-history key for version `20260721`
- Additional ordering evidence: the mixed-length interim names caused `20260717000001_restrict_profile_role_updates.sql` to run before the still-8-digit consent repair filename.
- Targeted correction: normalized the two 20260717 files and the two 20260721 files to unique 14-digit versions ending in `000000` and `000001`. This changes filenames only and preserves the required SQL order.

### Local stack initialization attempt 3 — blocked

- Command: `npx supabase@latest start` (local only; output filtered to avoid credentials)
- Result: blocked because Docker is unavailable in this environment (`docker` command not found). No PostgreSQL statement was executed.
- PostgreSQL errors: none observed; runtime verification remains pending.

### Clean local database reset attempt 1 — blocked

- Command: `npx supabase@latest db reset --local`
- Result: blocked before execution because the local Docker runtime is unavailable.
- PostgreSQL errors: none observed.

## Final migration order

```text
20260716_bootstrap_core_schema.sql
20260717000000_repair_application_consents.sql
20260717000001_restrict_profile_role_updates.sql
20260721000000_launch_transaction_foundation.sql
20260721000001_launch_transaction_rpcs.sql
```

The local `supabase_migrations.schema_migrations` history returned these filenames in exactly this order.

## Foundational object inventory

Objects previously defined only in `supabase/schema.sql` and now created by the bootstrap migration:

- `pgcrypto` extension.
- `public.user_role` enum with `customer`, `scanner_only`, `door_staff`, `admin`, and `super_admin` labels. An existing non-enum or mismatched label contract raises a genuine error.
- `public.profiles`, including the `auth.users` foreign key, role default, timestamps, and `profiles_email_lower_idx` unique lowercase-email index.
- `public.handle_new_user()` as a security-definer trigger function with a fixed `pg_catalog, public` search path, plus exactly one `auth.users.on_auth_user_created` trigger.
- `public.platform_documents`, including its key constraint, version/timestamp columns, and `platform_documents_updated_idx`.
- RLS on `profiles` and `platform_documents`; the two own-row profile policies; no client policy for `platform_documents`.
- Authenticated profile select and safe-column update grants only; no direct role/email/timestamp update grant; no anon profile DML; service-role server access.
- Server-only `platform_documents` grants.
- The public `media` read policy; the matching bucket configuration is seeded by `supabase/seed.sql`, with no anon/authenticated upload, update, or delete policy.

The bootstrap includes no seed/demo rows, customer rows, production data, or consent-repair DML. `site` and `operations` remain in `supabase/seed.sql`. The generic transaction timestamp/immutability functions and their triggers remain owned by `20260721000000_launch_transaction_foundation.sql`; they were not duplicated in the bootstrap.

## Resulting schema verification

The following catalog checks were executed against local Docker/PostgreSQL and passed:

- `public.profiles`, `public.platform_documents`, and the exact `public.user_role` enum contract exist.
- `site` and `operations` are each seeded exactly once with non-null payloads and positive versions.
- All 20 launch transaction tables exist.
- All 22 application tables have RLS enabled.
- `profiles` has exactly its two expected policies; `platform_documents` has no client policy.
- All 17 expected auth/timestamp/immutability triggers exist exactly once.
- Anon has no profile DML. Authenticated can select its own profile and update only `first_name`, `last_name`, `phone`, and `instagram`.
- Anon/authenticated have no DML privilege on `platform_documents` or any launch transaction table. Service role retains required server-side DML.
- The media bucket has one public read policy and no anon/authenticated write policy.
- All 20 expected `skie_*` RPCs exist exactly once.
- Every privileged RPC is security-definer, executable by `service_role`, and not executable by PUBLIC, `anon`, or `authenticated`.
- Every public security-definer function has a fixed safe search path, and client roles cannot create objects in the `public` schema.

## Requested checks

- `npm test`: PASS — 7 files, 31 tests.
- `npm run test:payments`: PASS — 3 files, 22 tests.
- `npm run test:security`: PASS — 2 files, 5 tests.
- `npm run verify`: PASS — ESLint, TypeScript, Next.js production build, 30/30 pages.
- `npm audit --omit=dev`: PASS — 0 vulnerabilities.
- `git diff --check`: PASS — exit 0; Git emitted line-ending conversion warnings only.
- `git status --short`: completed and recorded in the command output; the worktree remains unstaged.
- `next-env.d.ts` and `tsconfig.tsbuildinfo`: unchanged, confirmed by identical pre/post SHA-256 fingerprints and no Git status entry.

Tests globally deny network `fetch`. The production build was forced to local/test data mode with hosted-service variables cleared and telemetry disabled.

## Files changed for this repair

- Added `supabase/migrations/20260716_bootstrap_core_schema.sql`.
- Renamed the two 20260717 migrations and the two 20260721 migrations to unique 14-digit versions. Their SQL contents were not changed.
- Created this report and updated `IMPLEMENTATION_PROGRESS.md`, `IMPLEMENTATION_REPORT.md`, and `MIGRATION_RUNBOOK.md`.

The existing storage-bucket row moved from the bootstrap to `seed.sql`; scanner response scoping and permanent verification tests were also updated. No email, SMS, promo-feature, or media-feature implementation was started.

## Safety confirmation

- Supabase contact: local containers only.
- Docker contact: local Docker Desktop only.
- Hosted Supabase contacted or modified: no.
- Stripe, Resend, Twilio, or Vercel contacted or modified: no.
- Payments, refunds, emails, or SMS sent: no.
- Git staging, commit, push, deploy, reset, or project-file deletion: none.
- Existing audit reports, `public/email/`, and every `visual-*.txt` file were preserved.

## Phase 2 final local verification

### Baseline and clean reset

- Branch: `feature/launch-hardening-notifications-promos-media`.
- Docker engine: available, version 29.6.1.
- Local database container: `supabase_db_Skie-Events-Production`, running and healthy at baseline.
- `npx supabase@latest db reset --local`: PASS on repeated clean runs. The permanent database test reset the local database, applied the five migrations in the required order, and seeded `supabase/seed.sql`.
- Migration history order: `20260716_bootstrap_core_schema.sql`, `20260717000000_repair_application_consents.sql`, `20260717000001_restrict_profile_role_updates.sql`, `20260721000000_launch_transaction_foundation.sql`, `20260721000001_launch_transaction_rpcs.sql`.

### Migration rename and seed comparison

- `20260717_repair_application_consents.sql` -> `20260717000000_repair_application_consents.sql`: exact Git blob match `f6d3bbcde79c754929ead5ec76af8ec199ebf7bc`.
- `20260717_restrict_profile_role_updates.sql` -> `20260717000001_restrict_profile_role_updates.sql`: exact Git blob match `6a29b4938f6b7a7eb99a9dfc8ef40add53ab4161`.
- Exact blob equality proves that no intended repair statement was removed, changed, or duplicated by either rename.
- All five filenames match the accepted numeric-version/description/`.sql` migration filename form and reset in lexical execution order.
- `20260716_bootstrap_core_schema.sql` performs schema, policy, privilege, and trigger-function definition only. Its only `insert` token is inside `handle_new_user()` and is not migration seed execution.
- The existing `media` bucket configuration and the `site`/`operations` documents are in `supabase/seed.sql`. No demo/customer/payment rows exist in the migration chain. The consent migration retains only its intended repair `update`.

### Catalog object names

Tables verified:

`profiles`, `platform_documents`, `ticket_allocations`, `reservations`, `reservation_ticket_lines`, `reservation_product_lines`, `checkout_attempts`, `orders`, `order_lines`, `payments`, `payment_adjustments`, `stripe_webhook_events`, `tickets`, `entitlements`, `check_ins`, `entitlement_redemptions`, `event_staff_assignments`, `notification_outbox`, `notification_attempts`, `promo_codes`, `promo_redemptions`, `payment_recovery_actions`.

Primary-key constraint names verified:

`profiles_pkey`, `platform_documents_pkey`, `ticket_allocations_pkey`, `reservations_pkey`, `reservation_ticket_lines_pkey`, `reservation_product_lines_pkey`, `checkout_attempts_pkey`, `orders_pkey`, `order_lines_pkey`, `payments_pkey`, `payment_adjustments_pkey`, `stripe_webhook_events_pkey`, `tickets_pkey`, `entitlements_pkey`, `check_ins_pkey`, `entitlement_redemptions_pkey`, `event_staff_assignments_pkey`, `notification_outbox_pkey`, `notification_attempts_pkey`, `promo_codes_pkey`, `promo_redemptions_pkey`, `payment_recovery_actions_pkey`.

Foreign-key constraint names verified:

`profiles_id_fkey`, `ticket_allocations_customer_id_fkey`, `ticket_allocations_approved_by_fkey`, `reservations_customer_id_fkey`, `reservations_allocation_id_fkey`, `reservations_promo_code_fk`, `reservation_ticket_lines_reservation_id_fkey`, `reservation_product_lines_reservation_id_fkey`, `checkout_attempts_reservation_id_fkey`, `checkout_attempts_order_id_fkey`, `orders_reservation_id_fkey`, `orders_customer_id_fkey`, `orders_allocation_id_fkey`, `order_lines_order_id_fkey`, `order_lines_reservation_ticket_line_id_fkey`, `order_lines_reservation_product_line_id_fkey`, `payments_order_id_fkey`, `payments_checkout_attempt_id_fkey`, `payment_adjustments_payment_id_fkey`, `payment_adjustments_order_id_fkey`, `tickets_order_id_fkey`, `tickets_order_line_id_fkey`, `tickets_customer_id_fkey`, `tickets_checked_in_by_fkey`, `entitlements_order_id_fkey`, `entitlements_order_line_id_fkey`, `entitlements_customer_id_fkey`, `event_staff_assignments_user_id_fkey`, `event_staff_assignments_assigned_by_fkey`, `check_ins_ticket_id_fkey`, `check_ins_scanned_by_fkey`, `entitlement_redemptions_entitlement_id_fkey`, `entitlement_redemptions_redeemed_by_fkey`, `notification_outbox_recipient_user_id_fkey`, `notification_outbox_order_id_fkey`, `notification_attempts_outbox_id_fkey`, `promo_codes_created_by_fkey`, `promo_redemptions_promo_code_id_fkey`, `promo_redemptions_reservation_id_fkey`, `promo_redemptions_order_id_fkey`, `promo_redemptions_customer_id_fkey`, `payment_recovery_actions_order_id_fkey`, `payment_recovery_actions_reservation_id_fkey`, `payment_recovery_actions_actor_id_fkey`.

All 103 check constraints were present and validated. Payment-critical check names include `reservations_status_check`, `reservations_currency_check`, `reservations_check`, `reservations_check1`, `checkout_attempts_status_check`, `orders_status_check`, `orders_check`, `orders_check1`, `payments_provider_check`, `payments_status_check`, `payments_check`, `payment_adjustments_kind_check`, `payment_adjustments_status_check`, `tickets_status_check`, `tickets_token_hash_check`, `entitlements_status_check`, `entitlements_check`, `check_ins_result_check`, `notification_outbox_status_check`, `notification_outbox_attempt_count_check`, `notification_attempts_status_check`, `promo_codes_discount_type_check`, `promo_codes_status_check`, `promo_codes_check`, `promo_codes_check1`, `promo_redemptions_status_check`, `promo_redemptions_check`, `payment_recovery_actions_action_check`, and `payment_recovery_actions_status_check`.

Unique/idempotency constraint and index names verified:

`checkout_attempts_idempotency_key_key`, `checkout_attempts_reservation_id_reservation_version_key`, `checkout_attempts_stripe_checkout_session_id_key`, `checkout_attempts_stripe_payment_intent_id_key`, `checkout_attempts_order_unique`, `payments_stripe_session_unique`, `payments_stripe_pi_unique`, `payments_provider_reference_unique`, `stripe_webhook_events_pkey`, `tickets_ticket_code_key`, `tickets_token_hash_key`, `entitlement_redemptions_idempotency_key_key`, `notification_outbox_idempotency_key_key`, `notification_attempts_outbox_id_attempt_number_key`, `promo_codes_code_lower_unique`, `promo_codes_stripe_coupon_id_key`, `promo_codes_stripe_promotion_code_id_key`, `promo_redemptions_reservation_id_key`, `promo_redemptions_order_id_key`, `reservations_active_allocation_unique`, `payment_recovery_actions_idempotency_key_key`.

Immutable and updated-at trigger names verified:

`on_auth_user_created`, `reservations_immutable_trigger`, `reservation_ticket_lines_immutable`, `reservation_product_lines_immutable`, `order_lines_immutable`, `ticket_allocations_touch_updated_at`, `checkout_attempts_touch_updated_at`, `orders_touch_updated_at`, `payments_touch_updated_at`, `payment_adjustments_touch_updated_at`, `tickets_touch_updated_at`, `entitlements_touch_updated_at`, `event_staff_assignments_touch_updated_at`, `stripe_webhook_events_touch_updated_at`, `notification_outbox_touch_updated_at`, `promo_codes_touch_updated_at`, `promo_redemptions_touch_updated_at`.

Required performance index names verified:

`reservations_event_status_expiry_idx`, `reservations_customer_event_idx`, `reservations_active_allocation_unique`, `ticket_allocations_customer_event_idx`, `checkout_attempts_order_unique`, `checkout_attempts_status_idx`, `orders_recovery_idx`, `payments_order_idx`, `payments_stripe_session_unique`, `payments_stripe_pi_unique`, `payments_provider_reference_unique`, `payment_adjustments_order_idx`, `stripe_webhook_retry_idx`, `tickets_event_code_idx`, `tickets_customer_idx`, `entitlements_event_customer_idx`, `check_ins_event_time_idx`, `staff_event_idx`, `notification_due_idx`, `promo_codes_code_lower_unique`, `promo_redemptions_usage_idx`.

### RLS, grants and function security

- PASS: RLS is enabled on all 22 reviewed public tables.
- PASS: the 20 transaction tables have no client policies and no `anon`/`authenticated` table privileges. This denies direct payment, ticket, entitlement, other-customer, global door/scanner, and recovery access.
- PASS: `profiles_select_own` and `profiles_update_own` are the only profile policies; authenticated update grants remain restricted to `first_name`, `last_name`, `phone`, and `instagram`.
- PASS: all 20 privileged transaction RPCs are `security definer`, use fixed `search_path=public`, grant execution to `service_role`, and deny `PUBLIC`, `anon`, and `authenticated`.
- PASS: `handle_new_user` uses `search_path=pg_catalog, public`; the internal trigger helpers `skie_touch_updated_at`, `skie_reservation_immutable`, and `skie_immutable_row` now also deny client/PUBLIC execution.
- PASS: client roles cannot create objects in `public`. Browser-supplied IDs cannot reach privileged RPCs; application routes derive customer/actor IDs from `requireUser()` before server/service-role calls.

### RPC execution

All 20 privileged functions executed with synthetic rows and stable outputs:

`skie_reserve_checkout`, `skie_link_stripe_session`, `skie_upsert_ticket_allocation`, `skie_mutate_ticket_allocation`, `skie_record_stripe_webhook`, `skie_claim_stripe_webhook`, `skie_record_payment_received`, `skie_mark_paid_unfulfilled`, `skie_record_offline_payment`, `skie_fulfil_payment`, `skie_check_in`, `skie_redeem_entitlement`, `skie_claim_notification`, `skie_claim_promo_usage`, `skie_mark_webhook_result`, `skie_expire_checkout_session`, `skie_apply_refund`, `skie_mark_payment_intent_terminal`, `skie_mark_recovery_resolved`, `skie_apply_dispute`.

PASS cases: ticket/product reservation, checkout-attempt creation, Session link/replay/conflict, webhook inbox/replay/claim/result, durable payment evidence, forced fulfilment failure, paid-unfulfilled recovery, offline payment, exact fulfilment/replay quantities, reservation expiry, full refund, partial-refund manual review, dispute suspension/won restoration, wrong-event/valid/duplicate check-in, entitlement scope/redemption/idempotency, notification claim, and promo claim.

Runtime verification found and fixed PostgreSQL output-parameter ambiguities in `skie_record_payment_received`, `skie_record_offline_payment`, `skie_fulfil_payment`, and `skie_mark_payment_intent_terminal` query references.

### Real concurrency results

All races used separately started PowerShell jobs, separate `docker exec` processes, and independent simultaneous `psql` connections:

1. `concurrency-01-final-ticket`: PASS - one reservation, one `EVENT_CAPACITY_EXCEEDED`.
2. `concurrency-02-final-product`: PASS - one reservation, one `PRODUCT_STOCK_EXCEEDED`.
3. `concurrency-03-session-link`: PASS - one Session link, one `CHECKOUT_SESSION_ALREADY_LINKED`.
4. `concurrency-04-duplicate-paid-fulfilment`: PASS - one payment, one ticket, one entitlement with exact quantity two.
5. `concurrency-05-payment-evidence-survives`: PASS - one committed payment remains and order is `paid_unfulfilled` after forced fulfilment failure.
6. `concurrency-06-paid-unfulfilled-retry`: PASS - simultaneous retries end fulfilled with one ticket and one entitlement.
7. `concurrency-07-qr-scan`: PASS - one `valid`, one `already_checked_in`.
8. `concurrency-08-entitlement-redemption`: PASS - one redemption, one `ENTITLEMENT_NOT_REDEEMABLE`.
9. `concurrency-09-notification-claim`: PASS - one claimed row and one empty worker result; attempt count one.
10. `concurrency-10-promo-claim`: PASS - one redemption and one `PROMO_REDEMPTION_LIMIT`.

### Role and event scope

- Synthetic profiles covered customer A, customer B, door, scanner, admin, and super_admin.
- Customer roles have no direct order/ticket grants; application customer reads query by the authoritative session customer ID. Customer A cannot retrieve customer B's normalized order/ticket set.
- Door/scanner calls require `event_staff_assignments`; an unassigned event returns `EVENT_ASSIGNMENT_REQUIRED`.
- A wrong-event scan returns only `result`, `ticket_status`, and `checked_in_at` from the RPC; the API returns `ticket: null` and `entitlements: []`, with no customer email.
- Entitlement redemption verifies the assigned expected event and rejects scanner-only or wrong-event use.
- Scanner check-in no longer performs a door-only entitlement read after committing a valid scan.
- Customer, door, and scanner recovery API actions return 403; admin and super_admin actions pass the protected route test. No browser role has direct `payment_recovery_actions` access.

### Permanent tests and final commands

Added `tests/database/phase2-local-assertions.sql`, `tests/database/phase2-local-verification.ps1`, `tests/security/check-in-route.test.ts`, `tests/security/payment-recovery-route.test.ts`, and `npm run test:database`.

- `npm run test:database`: PASS - catalog/security/RPC/role suite plus all 10 concurrency cases.
- `npm test`: PASS - 9 files, 38 tests.
- `npm run test:payments`: PASS - 3 files, 22 tests.
- `npm run test:security`: PASS - 4 files, 12 tests.
- `npm run verify`: PASS - lint, typecheck, production build, 30/30 generated pages. Provider endpoint variables were cleared and local/test mode forced for the build.
- `npm audit --omit=dev`: PASS - 0 vulnerabilities.
- `git diff --check`: PASS, exit 0 (line-ending conversion warnings only). `git status --short`: recorded after report updates; staged file count is zero.
- Source scans: only intended authenticated profile grants; no unrestricted security-definer; no payment-critical TODO/FIXME; provider/database errors remain internal or map to allow-listed safe codes; checkout prices/totals come from server-side event/product data and immutable reservation snapshots; idempotency/locking markers present; tracked secret scan found no credential, only a documented placeholder.
- `next-env.d.ts` and `tsconfig.tsbuildinfo`: unchanged by SHA-256 comparison.

### Remaining blockers and exact verification files

Phase 2 local database P0/P1 blockers: **none remaining**. This is not production authorization: later launch-hardening phases, isolated staging rehearsal, and controlled provider test-mode drills remain outside this local-only scope.

Files changed specifically by this final verification:

- `package.json`
- `src/app/api/check-in/route.ts`
- `supabase/migrations/20260716_bootstrap_core_schema.sql`
- `supabase/migrations/20260721000000_launch_transaction_foundation.sql`
- `supabase/migrations/20260721000001_launch_transaction_rpcs.sql`
- `supabase/seed.sql`
- `tests/database/phase2-local-assertions.sql`
- `tests/database/phase2-local-verification.ps1`
- `tests/security/check-in-route.test.ts`
- `tests/security/payment-recovery-route.test.ts`
- `LOCAL_DATABASE_REHEARSAL.md`
- `IMPLEMENTATION_PROGRESS.md`
- `IMPLEMENTATION_REPORT.md`
- `MIGRATION_RUNBOOK.md`

Only the local Supabase Docker environment was contacted for database work. No hosted/production Supabase, Stripe, Resend, Twilio, or Vercel service was contacted. No payment/refund was made and no email/SMS was sent. Nothing was staged, committed, pushed, deployed, reset in Git, or deleted.
