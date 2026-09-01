-- Expose a service-role-only readiness check so the application fails closed before
-- reserving inventory or creating a Stripe authorisation when production schema drifts.

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
      to_regprocedure(
        'public.skie_record_post_checkout_authorization(uuid,text,text,integer,integer,text,timestamptz)'
      ) is not null as authorization_rpc,
      to_regprocedure(
        'public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)'
      ) is not null as submit_rpc,
      to_regprocedure(
        'public.skie_request_post_checkout_decision(uuid,uuid,text,text,text,text)'
      ) is not null as decision_rpc,
      to_regprocedure(
        'public.skie_claim_post_checkout_payment_actions(text,integer,integer)'
      ) is not null as worker_rpc,
      to_regprocedure('public.skie_reservation_immutable()') is not null as reservation_guard,
      exists (
        select 1
        from pg_trigger
        where tgrelid = 'public.reservations'::regclass
          and tgname = 'reservations_immutable_trigger'
          and not tgisinternal
          and tgenabled <> 'D'
      ) as reservation_trigger,
      coalesce((
        select position(
          'RESERVATION_EXPIRY_EXTENSION_INVALID'
          in pg_get_functiondef(p.oid)
        ) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'skie_reservation_immutable'
        limit 1
      ), false) as monotonic_expiry_guard
  )
  select
    17,
    authorization_rpc
      and submit_rpc
      and decision_rpc
      and worker_rpc
      and reservation_guard
      and reservation_trigger
      and monotonic_expiry_guard,
    jsonb_build_object(
      'authorizationRpc', authorization_rpc,
      'submitRpc', submit_rpc,
      'decisionRpc', decision_rpc,
      'workerRpc', worker_rpc,
      'reservationGuard', reservation_guard,
      'reservationTrigger', reservation_trigger,
      'monotonicExpiryGuard', monotonic_expiry_guard
    )
  from required;
$$;

revoke all on function public.skie_post_checkout_schema_health()
from public, anon, authenticated;
grant execute on function public.skie_post_checkout_schema_health()
to service_role;

commit;
