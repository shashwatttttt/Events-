-- Advance production readiness after terminal cancellation reconciliation was
-- moved into an action-scoped, service-role-only RPC.

begin;

create or replace function public.skie_post_checkout_schema_health()
returns table(schema_version integer, ready boolean, details jsonb)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with required as (
    select
      to_regprocedure('public.skie_record_post_checkout_authorization(uuid,text,text,integer,integer,text,timestamptz)') is not null as authorization_rpc,
      to_regprocedure('public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)') is not null as submit_rpc,
      to_regprocedure('public.skie_request_post_checkout_decision(uuid,uuid,text,text,text,text)') is not null as decision_rpc,
      to_regprocedure('public.skie_claim_post_checkout_payment_actions(text,integer,integer)') is not null as worker_rpc,
      to_regprocedure('public.skie_restart_unpaid_post_checkout(uuid,text)') is not null as restart_rpc,
      to_regprocedure('public.skie_record_operations_worker_heartbeat(text,text,text)') is not null as heartbeat_rpc,
      to_regprocedure('public.skie_operations_health(integer,integer)') is not null as operations_health_rpc,
      to_regprocedure('public.skie_reservation_immutable()') is not null as reservation_guard,
      to_regprocedure('public.skie_reconcile_cancelled_post_checkout_action(uuid,text)') is not null as terminal_cancellation_rpc,
      to_regprocedure('public.skie_mark_post_checkout_cancelled(text,text)') is not null as cancellation_wrapper_rpc,
      to_regclass('public.operations_worker_heartbeats') is not null as heartbeat_table,
      exists (
        select 1
        from pg_trigger
        where tgrelid = 'public.reservations'::regclass
          and tgname = 'reservations_immutable_trigger'
          and not tgisinternal
          and tgenabled <> 'D'
      ) as reservation_trigger,
      coalesce((
        select position('RESERVATION_EXPIRY_EXTENSION_INVALID' in pg_get_functiondef(p.oid)) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_reservation_immutable'
        limit 1
      ), false) as monotonic_expiry_guard,
      coalesce((
        select position('skie_reconcile_cancelled_post_checkout_action' in pg_get_functiondef(p.oid)) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_mark_post_checkout_cancelled'
        limit 1
      ), false) as cancellation_wrapper_guard,
      coalesce((
        select position('promo_redemptions' in pg_get_functiondef(p.oid)) > 0
          and position('POST_APPROVAL_ALREADY_CAPTURED' in pg_get_functiondef(p.oid)) > 0
          and position('PAYMENT_INTENT_MISMATCH' in pg_get_functiondef(p.oid)) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_reconcile_cancelled_post_checkout_action'
        limit 1
      ), false) as terminal_cancellation_guard,
      exists (
        select 1
        from pg_constraint
        where conrelid = 'public.promo_codes'::regclass
          and conname = 'promo_codes_active_status_check'
          and convalidated
      ) as promo_activation_guard,
      exists (
        select 1
        from pg_constraint
        where conrelid = 'public.promo_codes'::regclass
          and conname = 'promo_codes_discount_type_check'
          and convalidated
      ) as promo_tracking_type_guard,
      exists (
        select 1
        from pg_constraint
        where conrelid = 'public.promo_codes'::regclass
          and conname = 'promo_codes_discount_value_check'
          and convalidated
      ) as promo_tracking_value_guard,
      coalesce((
        select position('discount_type = ''tracking''' in lower(pg_get_functiondef(p.oid))) > 0
          and position('v_discount := 0' in lower(pg_get_functiondef(p.oid))) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_reserve_checkout_with_promo'
        limit 1
      ), false) as promo_tracking_rpc_guard,
      coalesce((
        select position('lease_expires_at is null' in lower(pg_get_functiondef(p.oid))) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_claim_post_checkout_payment_actions'
        limit 1
      ), false) as payment_null_lease_guard,
      coalesce((
        select position('lease_expires_at is null' in lower(pg_get_functiondef(p.oid))) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_claim_notification_batch'
        limit 1
      ), false) as notification_null_lease_guard
  )
  select
    28,
    authorization_rpc and submit_rpc and decision_rpc and worker_rpc and restart_rpc
      and heartbeat_rpc and operations_health_rpc and reservation_guard
      and terminal_cancellation_rpc and cancellation_wrapper_rpc and heartbeat_table
      and reservation_trigger and monotonic_expiry_guard
      and cancellation_wrapper_guard and terminal_cancellation_guard
      and promo_activation_guard and promo_tracking_type_guard and promo_tracking_value_guard
      and promo_tracking_rpc_guard and payment_null_lease_guard and notification_null_lease_guard,
    jsonb_build_object(
      'authorizationRpc',authorization_rpc,
      'submitRpc',submit_rpc,
      'decisionRpc',decision_rpc,
      'workerRpc',worker_rpc,
      'restartRpc',restart_rpc,
      'heartbeatRpc',heartbeat_rpc,
      'operationsHealthRpc',operations_health_rpc,
      'reservationGuard',reservation_guard,
      'terminalCancellationRpc',terminal_cancellation_rpc,
      'cancellationWrapperRpc',cancellation_wrapper_rpc,
      'heartbeatTable',heartbeat_table,
      'reservationTrigger',reservation_trigger,
      'monotonicExpiryGuard',monotonic_expiry_guard,
      'cancellationWrapperGuard',cancellation_wrapper_guard,
      'terminalCancellationGuard',terminal_cancellation_guard,
      'promoActivationGuard',promo_activation_guard,
      'promoTrackingTypeGuard',promo_tracking_type_guard,
      'promoTrackingValueGuard',promo_tracking_value_guard,
      'promoTrackingRpcGuard',promo_tracking_rpc_guard,
      'paymentNullLeaseGuard',payment_null_lease_guard,
      'notificationNullLeaseGuard',notification_null_lease_guard
    )
  from required;
$$;

revoke all on function public.skie_post_checkout_schema_health()
from public, anon, authenticated;
grant execute on function public.skie_post_checkout_schema_health()
to service_role;

notify pgrst, 'reload schema';

commit;
