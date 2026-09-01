-- Expose bounded aggregate health for the durable Stripe webhook replay queue
-- and advance the production schema readiness contract for migrations 29-35.

begin;

create or replace function public.skie_stripe_webhook_replay_health()
returns table(
  actions_requiring_review integer,
  stale_requested_actions integer,
  overdue_retry_actions integer,
  expired_processing_actions integer
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with limits as (
    select
      now() - interval '10 minutes' as stale_before,
      now() - interval '2 minutes' as missing_lease_before
  )
  select
    (select count(*)::integer
      from public.stripe_webhook_replay_actions
      where status = 'manual_review'),
    (select count(*)::integer
      from public.stripe_webhook_replay_actions,limits
      where status = 'requested' and created_at <= limits.stale_before),
    (select count(*)::integer
      from public.stripe_webhook_replay_actions,limits
      where status = 'retry' and available_at <= limits.stale_before),
    (select count(*)::integer
      from public.stripe_webhook_replay_actions,limits
      where status = 'processing'
        and (
          lease_expires_at <= now()
          or (lease_expires_at is null and updated_at <= limits.missing_lease_before)
        ));
$$;

revoke all on function public.skie_stripe_webhook_replay_health()
from public, anon, authenticated;
grant execute on function public.skie_stripe_webhook_replay_health()
to service_role;

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
          and position('discount_allocation' in lower(pg_get_functiondef(p.oid))) > 0
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
      ), false) as notification_null_lease_guard,
      to_regprocedure('public.skie_promo_usage_snapshot(uuid,uuid)') is not null as promo_usage_rpc,
      to_regclass('public.notification_enqueue_jobs') is not null as notification_enqueue_table,
      to_regprocedure('public.skie_claim_notification_enqueue_jobs(text,integer,integer)') is not null as notification_enqueue_claim_rpc,
      to_regprocedure('public.skie_finish_notification_enqueue_job(uuid,text,text,text,integer)') is not null as notification_enqueue_finish_rpc,
      to_regprocedure('public.skie_complete_order_notification_enqueue_job(uuid)') is not null as notification_enqueue_complete_rpc,
      exists (
        select 1
        from pg_trigger
        where tgrelid = 'public.orders'::regclass
          and tgname = 'orders_queue_fulfilment_notifications'
          and not tgisinternal
          and tgenabled <> 'D'
      ) as notification_enqueue_trigger,
      to_regclass('public.event_payment_shutdown_actions') is not null as event_shutdown_table,
      to_regprocedure('public.skie_request_event_payment_shutdown(text[])') is not null as event_shutdown_request_rpc,
      to_regprocedure('public.skie_claim_event_payment_shutdown_actions(text,integer,integer)') is not null as event_shutdown_claim_rpc,
      to_regprocedure('public.skie_finish_event_payment_shutdown_action(uuid,text,text,text,integer)') is not null as event_shutdown_finish_rpc,
      to_regprocedure('public.skie_list_post_checkout_admin_page(text,text,text,timestamptz,uuid,integer)') is not null as admin_page_rpc,
      exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'orders'
          and column_name = 'discount_allocation'
          and data_type = 'jsonb'
      ) as discount_allocation_column,
      to_regprocedure('public.skie_build_promo_discount_allocation(uuid,jsonb,jsonb,integer)') is not null as discount_allocation_rpc,
      to_regprocedure('public.skie_order_discount_allocation_guard()') is not null as discount_allocation_guard_rpc,
      exists (
        select 1
        from pg_trigger
        where tgrelid = 'public.orders'::regclass
          and tgname = 'orders_discount_allocation_guard'
          and not tgisinternal
          and tgenabled <> 'D'
      ) as discount_allocation_trigger,
      coalesce((
        select position('ORDER_DISCOUNT_ALLOCATION_IMMUTABLE' in pg_get_functiondef(p.oid)) > 0
          and position('ORDER_DISCOUNT_ALLOCATION_INVALID' in pg_get_functiondef(p.oid)) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_order_discount_allocation_guard'
        limit 1
      ), false) as discount_allocation_guard,
      to_regclass('public.stripe_webhook_replay_actions') is not null as webhook_replay_table,
      to_regprocedure('public.skie_request_stripe_webhook_replay(text)') is not null as webhook_replay_request_rpc,
      to_regprocedure('public.skie_queue_temporary_stripe_webhook_replays()') is not null as webhook_replay_queue_rpc,
      to_regprocedure('public.skie_claim_stripe_webhook_replays(text,integer,integer)') is not null as webhook_replay_claim_rpc,
      to_regprocedure('public.skie_finish_stripe_webhook_replay(uuid,text,text,text,integer)') is not null as webhook_replay_finish_rpc,
      to_regprocedure('public.skie_stripe_webhook_replay_health()') is not null as webhook_replay_health_rpc,
      coalesce((
        select position('notification_enqueue_jobs' in lower(pg_get_functiondef(p.oid))) > 0
          and position('event_payment_shutdown_actions' in lower(pg_get_functiondef(p.oid))) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_operations_health'
        limit 1
      ), false) as expanded_operations_health_guard,
      coalesce((
        select position('temporary_failure' in lower(pg_get_functiondef(p.oid))) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_request_stripe_webhook_replay'
        limit 1
      ), false) as webhook_replay_temporary_only_guard,
      coalesce((
        select position('admin_bucket' in lower(pg_get_functiondef(p.oid))) > 0
          and position('payment_status' in lower(pg_get_functiondef(p.oid))) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_list_post_checkout_admin_page'
        limit 1
      ), false) as admin_page_classification_guard
  )
  select
    35,
    authorization_rpc and submit_rpc and decision_rpc and worker_rpc and restart_rpc
      and heartbeat_rpc and operations_health_rpc and reservation_guard
      and terminal_cancellation_rpc and cancellation_wrapper_rpc and heartbeat_table
      and reservation_trigger and monotonic_expiry_guard
      and cancellation_wrapper_guard and terminal_cancellation_guard
      and promo_activation_guard and promo_tracking_type_guard and promo_tracking_value_guard
      and promo_tracking_rpc_guard and payment_null_lease_guard and notification_null_lease_guard
      and promo_usage_rpc and notification_enqueue_table and notification_enqueue_claim_rpc
      and notification_enqueue_finish_rpc and notification_enqueue_complete_rpc and notification_enqueue_trigger
      and event_shutdown_table and event_shutdown_request_rpc and event_shutdown_claim_rpc and event_shutdown_finish_rpc
      and admin_page_rpc and discount_allocation_column and discount_allocation_rpc
      and discount_allocation_guard_rpc and discount_allocation_trigger and discount_allocation_guard
      and webhook_replay_table and webhook_replay_request_rpc and webhook_replay_queue_rpc
      and webhook_replay_claim_rpc and webhook_replay_finish_rpc and webhook_replay_health_rpc
      and expanded_operations_health_guard and webhook_replay_temporary_only_guard
      and admin_page_classification_guard,
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
      'notificationNullLeaseGuard',notification_null_lease_guard,
      'promoUsageRpc',promo_usage_rpc,
      'notificationEnqueueTable',notification_enqueue_table,
      'notificationEnqueueClaimRpc',notification_enqueue_claim_rpc,
      'notificationEnqueueFinishRpc',notification_enqueue_finish_rpc,
      'notificationEnqueueCompleteRpc',notification_enqueue_complete_rpc,
      'notificationEnqueueTrigger',notification_enqueue_trigger,
      'eventShutdownTable',event_shutdown_table,
      'eventShutdownRequestRpc',event_shutdown_request_rpc,
      'eventShutdownClaimRpc',event_shutdown_claim_rpc,
      'eventShutdownFinishRpc',event_shutdown_finish_rpc,
      'adminPageRpc',admin_page_rpc,
      'discountAllocationColumn',discount_allocation_column,
      'discountAllocationRpc',discount_allocation_rpc,
      'discountAllocationGuardRpc',discount_allocation_guard_rpc,
      'discountAllocationTrigger',discount_allocation_trigger,
      'discountAllocationGuard',discount_allocation_guard,
      'webhookReplayTable',webhook_replay_table,
      'webhookReplayRequestRpc',webhook_replay_request_rpc,
      'webhookReplayQueueRpc',webhook_replay_queue_rpc,
      'webhookReplayClaimRpc',webhook_replay_claim_rpc,
      'webhookReplayFinishRpc',webhook_replay_finish_rpc,
      'webhookReplayHealthRpc',webhook_replay_health_rpc,
      'expandedOperationsHealthGuard',expanded_operations_health_guard,
      'webhookReplayTemporaryOnlyGuard',webhook_replay_temporary_only_guard,
      'adminPageClassificationGuard',admin_page_classification_guard
    )
  from required;
$$;

revoke all on function public.skie_post_checkout_schema_health()
from public, anon, authenticated;
grant execute on function public.skie_post_checkout_schema_health()
to service_role;

notify pgrst, 'reload schema';

commit;
