-- Deep production reliability hardening.
-- Adds worker heartbeat, broad aggregate operations health, null-lease recovery,
-- and notification queue self-healing without exposing customer/payment records.

begin;

create table if not exists public.operations_worker_heartbeats (
  worker_key text primary key check (length(worker_key) between 3 and 80),
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  safe_error_code text check (safe_error_code is null or length(safe_error_code) <= 120),
  updated_at timestamptz not null default now()
);

alter table public.operations_worker_heartbeats enable row level security;
revoke all on table public.operations_worker_heartbeats from public, anon, authenticated;
grant select, insert, update, delete on table public.operations_worker_heartbeats to service_role;

create or replace function public.skie_record_operations_worker_heartbeat(
  p_worker_key text,
  p_status text,
  p_safe_error_code text default null
)
returns public.operations_worker_heartbeats
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_row public.operations_worker_heartbeats%rowtype;
  v_key text := trim(coalesce(p_worker_key,''));
begin
  if length(v_key) not between 3 and 80
    or p_status not in ('started','succeeded','failed')
    or length(coalesce(p_safe_error_code,'')) > 120 then
    raise exception 'OPERATIONS_HEARTBEAT_INVALID';
  end if;

  insert into public.operations_worker_heartbeats(
    worker_key,last_started_at,last_succeeded_at,last_failed_at,safe_error_code,updated_at
  ) values (
    v_key,
    case when p_status = 'started' then now() else null end,
    case when p_status = 'succeeded' then now() else null end,
    case when p_status = 'failed' then now() else null end,
    case when p_status = 'failed' then nullif(trim(coalesce(p_safe_error_code,'')),'') else null end,
    now()
  )
  on conflict (worker_key) do update set
    last_started_at = case when p_status = 'started' then now() else public.operations_worker_heartbeats.last_started_at end,
    last_succeeded_at = case when p_status = 'succeeded' then now() else public.operations_worker_heartbeats.last_succeeded_at end,
    last_failed_at = case when p_status = 'failed' then now() else public.operations_worker_heartbeats.last_failed_at end,
    safe_error_code = case
      when p_status = 'failed' then nullif(trim(coalesce(p_safe_error_code,'')),'')
      when p_status = 'succeeded' then null
      else public.operations_worker_heartbeats.safe_error_code
    end,
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- Repair impossible processing states caused by historical/manual rows or a
-- process ending between setting status and persisting a lease expiry.
update public.post_checkout_payment_actions
set status = 'retry',
    available_at = now(),
    lease_owner = null,
    lease_expires_at = null,
    safe_error_code = coalesce(safe_error_code, 'POST_APPROVAL_WORKER_LEASE_MISSING'),
    updated_at = now()
where status = 'processing'
  and lease_expires_at is null
  and updated_at <= now() - interval '2 minutes';

update public.notification_attempts attempt
set status = 'retry',
    safe_error_code = 'NOTIFICATION_CLAIM_TIMEOUT',
    finished_at = now()
from public.notification_outbox outbox
where outbox.id = attempt.outbox_id
  and outbox.status in ('claimed','processing')
  and outbox.lease_expires_at is null
  and outbox.updated_at <= now() - interval '2 minutes'
  and attempt.attempt_number = outbox.attempt_count
  and attempt.finished_at is null;

update public.notification_outbox
set status = 'retry',
    safe_error_code = 'NOTIFICATION_CLAIM_TIMEOUT',
    lease_expires_at = null,
    lease_owner = null,
    available_at = now(),
    updated_at = now()
where status in ('claimed','processing')
  and lease_expires_at is null
  and updated_at <= now() - interval '2 minutes';

create index if not exists operations_payment_action_health_idx
  on public.post_checkout_payment_actions(status, available_at, lease_expires_at, created_at, updated_at);
create index if not exists operations_notification_health_idx
  on public.notification_outbox(status, available_at, lease_expires_at, created_at, updated_at);
create index if not exists operations_webhook_health_idx
  on public.stripe_webhook_events(status, updated_at);

create or replace function public.skie_claim_post_checkout_payment_actions(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns setof public.post_checkout_payment_actions
language plpgsql
security definer
set search_path = public, pg_catalog
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
        and (
          action.lease_expires_at <= now()
          or (action.lease_expires_at is null and action.updated_at <= now() - interval '2 minutes')
        )
      )
    order by action.created_at
    for update skip locked
    limit greatest(1,least(p_limit,25))
  )
  update public.post_checkout_payment_actions as action
  set status = 'processing',
      available_at = least(coalesce(action.available_at,now()),now()),
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

create or replace function public.skie_claim_notification_batch(
  p_channel text,
  p_worker_id text,
  p_batch_size integer default 10,
  p_lease_seconds integer default 60
)
returns setof public.notification_outbox
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_id uuid;
  v_item public.notification_outbox;
begin
  if p_channel not in ('email','sms','in_app','whatsapp')
    or length(trim(p_worker_id)) not between 8 and 100
    or p_batch_size not between 1 and 25
    or p_lease_seconds not between 10 and 300 then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_CLAIM';
  end if;

  update public.notification_attempts attempt
  set status = 'retry', safe_error_code = 'NOTIFICATION_CLAIM_TIMEOUT', finished_at = now()
  from public.notification_outbox outbox
  where outbox.id = attempt.outbox_id
    and outbox.status in ('claimed','processing')
    and (
      outbox.lease_expires_at <= now()
      or (outbox.lease_expires_at is null and outbox.updated_at <= now() - interval '2 minutes')
    )
    and attempt.attempt_number = outbox.attempt_count
    and attempt.finished_at is null;

  update public.notification_outbox
  set status = 'retry', safe_error_code = 'NOTIFICATION_CLAIM_TIMEOUT',
      lease_expires_at = null, lease_owner = null, available_at = now(), updated_at = now()
  where status in ('claimed','processing')
    and (
      lease_expires_at <= now()
      or (lease_expires_at is null and updated_at <= now() - interval '2 minutes')
    );

  for v_id in
    select id
    from public.notification_outbox
    where channel = p_channel
      and status in ('queued','retry','temporary_failure')
      and available_at <= now()
      and attempt_count < max_attempts
    order by available_at, id
    for update skip locked
    limit p_batch_size
  loop
    update public.notification_outbox
    set status = 'processing',
        attempt_count = attempt_count + 1,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        lease_owner = p_worker_id,
        safe_error_code = null,
        updated_at = now()
    where id = v_id
    returning * into v_item;

    insert into public.notification_attempts(outbox_id, attempt_number, status)
    values (v_item.id, v_item.attempt_count, 'processing');
    return next v_item;
  end loop;
end;
$$;

create or replace function public.skie_operations_health(
  p_capture_safety_minutes integer default 60,
  p_heartbeat_grace_minutes integer default 15
)
returns table(
  payment_actions_requiring_review integer,
  stale_requested_payment_actions integer,
  overdue_retry_payment_actions integer,
  expired_processing_payment_actions integer,
  failed_notifications integer,
  stale_queued_notifications integer,
  overdue_retry_notifications integer,
  expired_processing_notifications integer,
  payment_recoveries_requiring_review integer,
  orphan_stripe_sessions integer,
  webhooks_requiring_review integer,
  stale_temporary_webhooks integer,
  overdue_post_checkout_lifecycle integer,
  worker_last_succeeded_at timestamptz,
  worker_heartbeat_healthy boolean
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with limits as (
    select
      greatest(30,least(coalesce(p_capture_safety_minutes,60),24 * 60)) as capture_safety_minutes,
      greatest(5,least(coalesce(p_heartbeat_grace_minutes,15),120)) as heartbeat_grace_minutes,
      now() - interval '10 minutes' as stale_before,
      now() - interval '2 minutes' as missing_lease_before
  ), heartbeat as (
    select last_succeeded_at
    from public.operations_worker_heartbeats
    where worker_key = 'production_operations'
  )
  select
    (select count(*)::integer from public.post_checkout_payment_actions
      where status in ('failed','manual_review')),
    (select count(*)::integer from public.post_checkout_payment_actions, limits
      where status = 'requested' and created_at <= limits.stale_before),
    (select count(*)::integer from public.post_checkout_payment_actions, limits
      where status = 'retry' and available_at <= limits.stale_before),
    (select count(*)::integer from public.post_checkout_payment_actions, limits
      where status = 'processing'
        and (lease_expires_at <= now() or (lease_expires_at is null and updated_at <= limits.missing_lease_before))),
    (select count(*)::integer from public.notification_outbox where status = 'failed'),
    (select count(*)::integer from public.notification_outbox, limits
      where status = 'queued' and created_at <= limits.stale_before),
    (select count(*)::integer from public.notification_outbox, limits
      where status in ('retry','temporary_failure') and available_at <= limits.stale_before),
    (select count(*)::integer from public.notification_outbox, limits
      where status in ('claimed','processing')
        and (lease_expires_at <= now() or (lease_expires_at is null and updated_at <= limits.missing_lease_before))),
    (select count(*)::integer from public.reservations, limits
      where status in ('manual_review','recovery_failed')
        or (status in ('payment_received','fulfilment_pending','paid_unfulfilled') and updated_at <= limits.stale_before)),
    (select count(*)::integer from public.checkout_attempts where status = 'orphan_session'),
    (select count(*)::integer from public.stripe_webhook_events
      where status in ('permanent_failure','manual_review')),
    (select count(*)::integer from public.stripe_webhook_events, limits
      where status = 'temporary_failure' and updated_at <= limits.stale_before),
    (select count(*)::integer
      from public.post_checkout_applications, limits
      where payment_status = 'authorized'
        and (
          (status in ('awaiting_form','draft') and form_due_at <= now())
          or (status in ('submitted','under_review') and review_due_at is not null and review_due_at <= now())
          or (status in ('awaiting_form','draft','submitted','under_review')
            and capture_before is not null
            and capture_before <= now() + make_interval(mins => limits.capture_safety_minutes))
        )),
    (select last_succeeded_at from heartbeat limit 1),
    coalesce((select heartbeat.last_succeeded_at >= now()
      - make_interval(mins => limits.heartbeat_grace_minutes)
      from heartbeat cross join limits limit 1), false);
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
      to_regprocedure('public.skie_record_post_checkout_authorization(uuid,text,text,integer,integer,text,timestamptz)') is not null as authorization_rpc,
      to_regprocedure('public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)') is not null as submit_rpc,
      to_regprocedure('public.skie_request_post_checkout_decision(uuid,uuid,text,text,text,text)') is not null as decision_rpc,
      to_regprocedure('public.skie_claim_post_checkout_payment_actions(text,integer,integer)') is not null as worker_rpc,
      to_regprocedure('public.skie_restart_unpaid_post_checkout(uuid,text)') is not null as restart_rpc,
      to_regprocedure('public.skie_record_operations_worker_heartbeat(text,text,text)') is not null as heartbeat_rpc,
      to_regprocedure('public.skie_operations_health(integer,integer)') is not null as operations_health_rpc,
      to_regprocedure('public.skie_reservation_immutable()') is not null as reservation_guard,
      to_regclass('public.operations_worker_heartbeats') is not null as heartbeat_table,
      exists (
        select 1 from pg_trigger
        where tgrelid = 'public.reservations'::regclass
          and tgname = 'reservations_immutable_trigger'
          and not tgisinternal
          and tgenabled <> 'D'
      ) as reservation_trigger,
      coalesce((
        select position('RESERVATION_EXPIRY_EXTENSION_INVALID' in pg_get_functiondef(p.oid)) > 0
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_reservation_immutable' limit 1
      ), false) as monotonic_expiry_guard,
      coalesce((
        select position('promo_redemptions' in pg_get_functiondef(p.oid)) > 0
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_mark_post_checkout_cancelled' limit 1
      ), false) as promo_release_guard,
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.promo_codes'::regclass
          and conname = 'promo_codes_active_status_check'
          and convalidated
      ) as promo_activation_guard,
      coalesce((
        select position('lease_expires_at is null' in lower(pg_get_functiondef(p.oid))) > 0
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_claim_post_checkout_payment_actions' limit 1
      ), false) as payment_null_lease_guard,
      coalesce((
        select position('lease_expires_at is null' in lower(pg_get_functiondef(p.oid))) > 0
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_claim_notification_batch' limit 1
      ), false) as notification_null_lease_guard
  )
  select
    21,
    authorization_rpc and submit_rpc and decision_rpc and worker_rpc and restart_rpc
      and heartbeat_rpc and operations_health_rpc and reservation_guard and heartbeat_table
      and reservation_trigger and monotonic_expiry_guard and promo_release_guard
      and promo_activation_guard and payment_null_lease_guard and notification_null_lease_guard,
    jsonb_build_object(
      'authorizationRpc',authorization_rpc,
      'submitRpc',submit_rpc,
      'decisionRpc',decision_rpc,
      'workerRpc',worker_rpc,
      'restartRpc',restart_rpc,
      'heartbeatRpc',heartbeat_rpc,
      'operationsHealthRpc',operations_health_rpc,
      'heartbeatTable',heartbeat_table,
      'reservationGuard',reservation_guard,
      'reservationTrigger',reservation_trigger,
      'monotonicExpiryGuard',monotonic_expiry_guard,
      'promoReleaseGuard',promo_release_guard,
      'promoActivationGuard',promo_activation_guard,
      'paymentNullLeaseGuard',payment_null_lease_guard,
      'notificationNullLeaseGuard',notification_null_lease_guard
    )
  from required;
$$;

revoke all on function public.skie_record_operations_worker_heartbeat(text,text,text)
from public, anon, authenticated;
grant execute on function public.skie_record_operations_worker_heartbeat(text,text,text)
to service_role;

revoke all on function public.skie_operations_health(integer,integer)
from public, anon, authenticated;
grant execute on function public.skie_operations_health(integer,integer)
to service_role;

revoke all on function public.skie_claim_post_checkout_payment_actions(text,integer,integer)
from public, anon, authenticated;
grant execute on function public.skie_claim_post_checkout_payment_actions(text,integer,integer)
to service_role;

revoke all on function public.skie_claim_notification_batch(text,text,integer,integer)
from public, anon, authenticated;
grant execute on function public.skie_claim_notification_batch(text,text,integer,integer)
to service_role;

revoke all on function public.skie_post_checkout_schema_health()
from public, anon, authenticated;
grant execute on function public.skie_post_checkout_schema_health()
to service_role;

notify pgrst, 'reload schema';

commit;
