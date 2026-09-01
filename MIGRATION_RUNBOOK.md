# SKIE EVENTS Transactional Migration Runbook

Status: **LOCAL PHASE 2, 3, 4, 6 + 7 PASS / NOT APPLIED TO HOSTED SUPABASE**. This remains an operator runbook for a separately approved staging window and does not authorize production access.

## Migration files and order

1. `supabase/migrations/20260716_bootstrap_core_schema.sql`
2. `supabase/migrations/20260717000000_repair_application_consents.sql`
3. `supabase/migrations/20260717000001_restrict_profile_role_updates.sql`
4. `supabase/migrations/20260721000000_launch_transaction_foundation.sql`
5. `supabase/migrations/20260721000001_launch_transaction_rpcs.sql`
6. `supabase/migrations/20260722000000_phase3_launch_hardening.sql`
7. `supabase/migrations/20260722010000_phase4_notifications.sql`
8. `supabase/migrations/20260722020000_phase6_promos.sql`
9. `supabase/migrations/20260722030000_phase7_media.sql`

Record SHA-256 hashes of the reviewed files before the rehearsal. Apply only to a new isolated Supabase staging project containing synthetic identities/events. Do not copy customer or production payment data.

## Preconditions

- Named database, payment, security and rollback owners are present.
- A verified staging backup/restore point exists.
- `APP_MODE=test`; Stripe/Resend/Twilio use mocks or approved test credentials only.
- Checkout traffic is disabled during migration rehearsal.
- The exact application revision is recorded; no unreviewed local changes are included.
- The bootstrap migration creates `public.profiles`, `public.platform_documents`, and `public.user_role`; do not separately run `supabase/schema.sql`.

## Staging application sequence

1. Connect through the approved Supabase staging SQL workflow. Never echo connection strings or credentials.
2. Apply all nine migration files in the listed order. Each transaction's final `commit` must succeed; Phases 3, 4, 6 and 7 must follow both transaction migrations.
3. Stop immediately on any error. Preserve sanitized PostgreSQL error code/object name, not credentials or row data.
4. Do not apply a hand-edited partial function in the dashboard. Correct the migration file, recreate/restore staging, and rerun from a clean state.

## Required schema verification

Run sanitized catalog queries that prove:

- All expected transaction tables exist: allocations, reservations/lines, checkout attempts, orders/lines, payments/adjustments, webhook inbox, tickets, entitlements, check-ins/redemptions, notification outbox/attempts, promo rows, assignments, and recovery actions.
- Every table has the documented primary/foreign/unique/check constraints.
- Unique indexes exist for Stripe Session, PaymentIntent and provider references, ticket code/token hash, webhook event, notification idempotency, redemption idempotency and active allocation reservation.
- RLS is enabled on every new table.
- `anon` and `authenticated` have no direct table or RPC mutation grants.
- Only `service_role` can execute the `skie_*` transaction functions.
- Function `search_path` is fixed to `public` and functions are `security definer` only where documented.
- Phase 3 tables exist with RLS and service-only access: `event_staff_assignment_audit`, `event_sale_controls`, `event_state_audit`, and `rate_limit_buckets`.
- Staff assignment start/end/revocation constraints and current-window index are validated.
- Phase 3 functions are service-role only, including site-document CAS/state audit, staff assignment mutation, rate-limit consume/cleanup, and checkout v2.
- `skie_replace_site_document` and `skie_reserve_checkout_v2` use the same event advisory-lock namespace.
- Phase 4 notification privacy/claim/audit columns and service-only enqueue/claim/finish/manage RPCs exist.
- Phase 6 promo audit, atomic promo checkout/failure release, immutable attachment guard and paid-finalization trigger exist with service-only execution.
- Phase 7 `media_objects` and the `media` Storage bucket have RLS, the reviewed MIME/size limits, public read only and no browser write policy.

Minimum catalog checks:

```sql
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('reservations','checkout_attempts','orders','payments','stripe_webhook_events','tickets','entitlements');

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

## Required atomic and concurrency drills

With synthetic fixtures and no real provider actions, prove:

1. Two concurrent reservations for the final event ticket: exactly one succeeds.
2. Two concurrent reservations for the final product: exactly one succeeds.
3. Two Session links to one attempt: identical replay succeeds; different Session conflicts.
4. Paid webhook replay: one payment, exact ticket count, exact entitlement count.
5. Wrong amount/currency/order/PaymentIntent: payment evidence/inbox remains durable and reservation enters manual review where specified.
6. Forced fulfilment failure after payment recording: payment remains and recovery status becomes `paid_unfulfilled`.
7. Retry fulfilment: no duplicate ticket, entitlement or allocation quantity.
8. Full refund invalidates every associated ticket/entitlement; duplicate event is harmless.
9. Partial unattributable refund enters manual review; attributed partial refund affects only named lines.
10. Dispute creation suspends access; won restores prior status; lost/closed invalidates.
11. Concurrent QR check-in: one valid, later calls duplicate; invalid token never checks in.
12. Wrong-event staff and entitlement redemption are rejected without unrelated customer data.
13. Notification and promo claims use `skip locked` semantics and do not double claim.
14. Shared rate-limit final slot: two simultaneous callers yield exactly one allow and one deny, with the persisted count capped.
15. CMS stale save: two callers with one expected version yield one save, one stable stale conflict, and one version increment.
16. Emergency event close versus checkout: when close wins the event lock, checkout returns `EVENT_SALES_CLOSED` and creates no reservation.

## Repeatable local verification

From the repository root, with only the local Supabase Docker stack running:

```powershell
npm run test:database
```

The command verifies the required branch and exact local database container, runs a clean `npx supabase@latest db reset --local`, executes the Phase 2, 3, 4, 6 and 7 SQL assertions, then starts independent simultaneous Docker/psql connections for all 16 race cases. It prints sanitized PASS markers only and does not read or print local keys.

To rerun the assertions/concurrency tests against an already clean current local reset:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/database/local-verification.ps1 -SkipReset
```

Current local result: Phase 2-7 catalog, RLS/grant, privileged RPC, synthetic role/event-scope, failure-recovery, event-state/staff/rate-limit, notification, promo and media checks plus all 16 concurrency cases pass. Phase-specific additions are recorded in the Phase 3, 4, 6 and 7 implementation reports.

## Application rollout order after all staging gates pass

1. Back up production and record schema/application versions.
2. Put sales into the approved closed state; stop new checkouts.
3. Inventory active Stripe Sessions and choose expire-or-honour per reservation; never silently reject a paid Session.
4. Apply the full nine-file migration chain in the order listed above, ending with Phase 7 media.
5. Run catalog/RLS smoke checks without selecting customer/payment payloads.
6. Deploy normalized read compatibility.
7. Deploy normalized reserve/link/payment/webhook writes.
8. Verify protected recovery plus local/dry-run notification worker; then test Storage and Resend staging configuration.
9. Subscribe Stripe webhook events and verify signature handling and discounted-total reconciliation in controlled test mode.
10. Reconcile active Sessions, totals, notification status and promo usage; obtain payment/database/security/email sign-off.
11. Re-enable one controlled low-risk sale, then widen only after observed reconciliation.

## Rollback/containment order

1. Close new sales immediately; do not disable webhook receipt.
2. Preserve the webhook inbox, payments, reservations, tickets and recovery audit rows.
3. Reconcile or expire every active Session according to the documented policy.
4. Roll application traffic back to the last schema-compatible revision.
5. Leave additive financial tables in place. Do not drop or rewrite payment evidence as a rollback shortcut.
6. If an RPC is defective, revoke its execution in the approved change window and deploy a forward corrective migration.
7. Re-enable sales only after a fresh reconciliation and go/no-go review.

## Current gate

The local Docker/PostgreSQL blocker is resolved. Phase 2, 3, 4, 6 and 7 local database verification passes with no remaining local blocker in the implemented scope. Hosted staging repetition, controlled Storage/Resend/Stripe test-mode drills, authenticated operator QA and production change approval remain separate future gates. Production Supabase and provider services were not contacted during this verification.
