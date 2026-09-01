-- Recover payment actions that were approved but never claimed, and make the
-- queue self-healing when a worker lease expires after a Stripe operation.

begin;

create index if not exists post_checkout_payment_actions_recovery_idx
  on public.post_checkout_payment_actions(status, available_at, lease_expires_at, created_at);

-- A requested action is intended to be immediately available. Repair any old
-- row whose availability or lease metadata prevented the production worker
-- from seeing it. This includes the live capture that remained at attempt 0.
update public.post_checkout_payment_actions
set available_at = now(),
    lease_owner = null,
    lease_expires_at = null,
    safe_error_code = null,
    updated_at = now()
where status = 'requested'
  and created_at <= now() - interval '2 minutes';

-- If a process stopped after claiming an action, return the action to the
-- durable queue. The worker reconciles Stripe before deciding whether another
-- provider call is needed, so this cannot create a duplicate capture.
update public.post_checkout_payment_actions
set status = 'retry',
    available_at = now(),
    lease_owner = null,
    lease_expires_at = null,
    safe_error_code = coalesce(safe_error_code, 'POST_APPROVAL_WORKER_LEASE_EXPIRED'),
    updated_at = now()
where status = 'processing'
  and lease_expires_at <= now();

create or replace function public.skie_claim_post_checkout_payment_actions(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns setof public.post_checkout_payment_actions
language plpgsql
security definer
set search_path = public
as $$
begin
  if length(trim(coalesce(p_worker_id,''))) < 8 then
    raise exception 'POST_APPROVAL_WORKER_ID_INVALID';
  end if;

  return query
  with candidates as (
    select action.id
    from public.post_checkout_payment_actions as action
    where (
        action.status in ('requested','retry')
        and action.available_at <= now()
      )
      or (
        action.status = 'requested'
        and action.created_at <= now() - interval '2 minutes'
      )
      or (
        action.status = 'processing'
        and action.lease_expires_at <= now()
      )
    order by action.created_at
    for update skip locked
    limit greatest(1,least(p_limit,25))
  )
  update public.post_checkout_payment_actions as action
  set status = 'processing',
      available_at = least(action.available_at,now()),
      lease_owner = trim(p_worker_id),
      lease_expires_at = now() + make_interval(secs => greatest(30,least(p_lease_seconds,300))),
      attempt_count = action.attempt_count + 1,
      last_attempt_at = now(),
      safe_error_code = null,
      completed_at = null
  from candidates
  where action.id = candidates.id
  returning action.*;
end;
$$;

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
      to_regprocedure(
        'public.skie_restart_unpaid_post_checkout(uuid,text)'
      ) is not null as restart_rpc,
      to_regprocedure('public.skie_reservation_immutable()') is not null as reservation_guard,
      exists (
        select 1 from pg_trigger
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
        select position('promo_redemptions' in pg_get_functiondef(p.oid)) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_mark_post_checkout_cancelled'
        limit 1
      ), false) as promo_release_guard,
      exists (
        select 1
        from pg_constraint
        where conrelid = 'public.promo_codes'::regclass
          and conname = 'promo_codes_active_status_check'
          and convalidated
      ) as promo_activation_guard,
      coalesce((
        select position('created_at <=' in pg_get_functiondef(p.oid)) > 0
          and position('lease_expires_at <=' in pg_get_functiondef(p.oid)) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'skie_claim_post_checkout_payment_actions'
        limit 1
      ), false) as queue_recovery_guard
  )
  select
    20,
    authorization_rpc and submit_rpc and decision_rpc and worker_rpc and restart_rpc
      and reservation_guard and reservation_trigger and monotonic_expiry_guard
      and promo_release_guard and promo_activation_guard and queue_recovery_guard,
    jsonb_build_object(
      'authorizationRpc',authorization_rpc,
      'submitRpc',submit_rpc,
      'decisionRpc',decision_rpc,
      'workerRpc',worker_rpc,
      'restartRpc',restart_rpc,
      'reservationGuard',reservation_guard,
      'reservationTrigger',reservation_trigger,
      'monotonicExpiryGuard',monotonic_expiry_guard,
      'promoReleaseGuard',promo_release_guard,
      'promoActivationGuard',promo_activation_guard,
      'queueRecoveryGuard',queue_recovery_guard
    )
  from required;
$$;

revoke all on function public.skie_claim_post_checkout_payment_actions(text,integer,integer)
from public, anon, authenticated;
grant execute on function public.skie_claim_post_checkout_payment_actions(text,integer,integer)
to service_role;

revoke all on function public.skie_post_checkout_schema_health()
from public, anon, authenticated;
grant execute on function public.skie_post_checkout_schema_health()
to service_role;

notify pgrst, 'reload schema';

commit;
