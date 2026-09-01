-- Durably expire open Stripe Checkout Sessions and cancel uncaptured
-- post-checkout PaymentIntents whenever an event is closed. Already captured
-- payments are never refunded automatically and remain manual-review work.

begin;

create table if not exists public.event_payment_shutdown_actions (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  provider_object_type text not null
    check (provider_object_type in ('checkout_session','payment_intent')),
  provider_object_id text not null,
  action_type text not null
    check (action_type in ('expire_session','cancel_intent')),
  application_id uuid references public.post_checkout_applications(id) on delete set null,
  status text not null default 'requested'
    check (status in ('requested','processing','retry','completed','manual_review')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  safe_error_code text check (safe_error_code is null or length(safe_error_code) <= 120),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_object_type, provider_object_id, action_type)
);

alter table public.event_payment_shutdown_actions enable row level security;
revoke all on table public.event_payment_shutdown_actions from public, anon, authenticated;
grant select, insert, update, delete on table public.event_payment_shutdown_actions to service_role;

create index if not exists event_payment_shutdown_actions_claim_idx
on public.event_payment_shutdown_actions (status, available_at, lease_expires_at, created_at);
create index if not exists event_payment_shutdown_actions_event_idx
on public.event_payment_shutdown_actions (event_id, status, created_at);

create or replace function public.skie_request_event_payment_shutdown(
  p_event_ids text[]
)
returns table(checkout_sessions_queued integer, payment_intents_queued integer)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_sessions integer := 0;
  v_intents integer := 0;
begin
  if coalesce(array_length(p_event_ids,1),0) = 0 then
    return query select 0,0;
    return;
  end if;

  with inserted as (
    insert into public.event_payment_shutdown_actions(
      event_id,provider_object_type,provider_object_id,action_type,status,available_at
    )
    select distinct
      reservation.event_id,
      'checkout_session',
      attempt.stripe_checkout_session_id,
      'expire_session',
      'requested',
      now()
    from public.reservations as reservation
    join public.checkout_attempts as attempt on attempt.reservation_id = reservation.id
    where reservation.event_id = any(p_event_ids)
      and reservation.status in ('reserved','session_active')
      and attempt.status = 'session_active'
      and attempt.stripe_checkout_session_id is not null
    on conflict (provider_object_type,provider_object_id,action_type) do nothing
    returning 1
  ) select count(*)::integer into v_sessions from inserted;

  with inserted as (
    insert into public.event_payment_shutdown_actions(
      event_id,provider_object_type,provider_object_id,action_type,application_id,status,available_at
    )
    select distinct
      application.event_id,
      'payment_intent',
      application.stripe_payment_intent_id,
      'cancel_intent',
      application.id,
      'requested',
      now()
    from public.post_checkout_applications as application
    where application.event_id = any(p_event_ids)
      and application.stripe_payment_intent_id is not null
      and application.payment_status in ('authorized','capture_requested','cancel_requested')
    on conflict (provider_object_type,provider_object_id,action_type) do nothing
    returning 1
  ) select count(*)::integer into v_intents from inserted;

  return query select v_sessions,v_intents;
end;
$$;

create or replace function public.skie_claim_event_payment_shutdown_actions(
  p_worker_id text,
  p_batch_size integer default 10,
  p_lease_seconds integer default 60
)
returns setof public.event_payment_shutdown_actions
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if length(trim(coalesce(p_worker_id,''))) not between 8 and 100
    or p_batch_size not between 1 and 25
    or p_lease_seconds not between 10 and 300 then
    raise exception 'EVENT_SHUTDOWN_CLAIM_INVALID';
  end if;

  update public.event_payment_shutdown_actions
  set status = 'retry',
      available_at = now(),
      lease_owner = null,
      lease_expires_at = null,
      safe_error_code = coalesce(safe_error_code, 'EVENT_SHUTDOWN_LEASE_TIMEOUT'),
      updated_at = now()
  where status = 'processing'
    and (
      lease_expires_at <= now()
      or (lease_expires_at is null and updated_at <= now() - interval '2 minutes')
    );

  return query
  with candidates as (
    select action.id
    from public.event_payment_shutdown_actions as action
    where action.status in ('requested','retry')
      and action.available_at <= now()
    order by action.available_at,action.created_at,action.id
    for update skip locked
    limit p_batch_size
  )
  update public.event_payment_shutdown_actions as action
  set status = 'processing',
      attempt_count = action.attempt_count + 1,
      lease_owner = trim(p_worker_id),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      safe_error_code = null,
      updated_at = now()
  from candidates
  where action.id = candidates.id
  returning action.*;
end;
$$;

create or replace function public.skie_finish_event_payment_shutdown_action(
  p_action_id uuid,
  p_worker_id text,
  p_result text,
  p_safe_error_code text default null,
  p_retry_delay_seconds integer default 60
)
returns public.event_payment_shutdown_actions
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_action public.event_payment_shutdown_actions%rowtype;
begin
  if p_result not in ('completed','retry','manual_review')
    or length(coalesce(p_safe_error_code,'')) > 120
    or p_retry_delay_seconds not between 10 and 86400 then
    raise exception 'EVENT_SHUTDOWN_RESULT_INVALID';
  end if;

  update public.event_payment_shutdown_actions as action
  set status = p_result,
      available_at = case
        when p_result = 'retry' then now() + make_interval(secs => p_retry_delay_seconds)
        else action.available_at
      end,
      lease_owner = null,
      lease_expires_at = null,
      safe_error_code = nullif(trim(coalesce(p_safe_error_code,'')),''),
      completed_at = case when p_result = 'completed' then coalesce(action.completed_at,now()) else null end,
      updated_at = now()
  where action.id = p_action_id
    and action.status = 'processing'
    and action.lease_owner = trim(p_worker_id)
  returning action.* into v_action;

  if not found then raise exception 'EVENT_SHUTDOWN_LEASE_LOST'; end if;
  return v_action;
end;
$$;

-- Extend aggregate health with durable event-shutdown work.
drop function if exists public.skie_operations_health(integer, integer);
create function public.skie_operations_health(
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
  notification_enqueue_jobs_requiring_review integer,
  stale_requested_notification_enqueue_jobs integer,
  overdue_retry_notification_enqueue_jobs integer,
  expired_processing_notification_enqueue_jobs integer,
  event_shutdown_actions_requiring_review integer,
  stale_requested_event_shutdown_actions integer,
  overdue_retry_event_shutdown_actions integer,
  expired_processing_event_shutdown_actions integer,
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
    (select count(*)::integer from public.notification_enqueue_jobs
      where status = 'manual_review'),
    (select count(*)::integer from public.notification_enqueue_jobs, limits
      where status = 'requested' and created_at <= limits.stale_before),
    (select count(*)::integer from public.notification_enqueue_jobs, limits
      where status = 'retry' and available_at <= limits.stale_before),
    (select count(*)::integer from public.notification_enqueue_jobs, limits
      where status = 'processing'
        and (lease_expires_at <= now() or (lease_expires_at is null and updated_at <= limits.missing_lease_before))),
    (select count(*)::integer from public.event_payment_shutdown_actions
      where status = 'manual_review'),
    (select count(*)::integer from public.event_payment_shutdown_actions, limits
      where status = 'requested' and created_at <= limits.stale_before),
    (select count(*)::integer from public.event_payment_shutdown_actions, limits
      where status = 'retry' and available_at <= limits.stale_before),
    (select count(*)::integer from public.event_payment_shutdown_actions, limits
      where status = 'processing'
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

revoke all on function public.skie_request_event_payment_shutdown(text[])
from public, anon, authenticated;
revoke all on function public.skie_claim_event_payment_shutdown_actions(text, integer, integer)
from public, anon, authenticated;
revoke all on function public.skie_finish_event_payment_shutdown_action(uuid, text, text, text, integer)
from public, anon, authenticated;
revoke all on function public.skie_operations_health(integer, integer)
from public, anon, authenticated;

grant execute on function public.skie_request_event_payment_shutdown(text[])
to service_role;
grant execute on function public.skie_claim_event_payment_shutdown_actions(text, integer, integer)
to service_role;
grant execute on function public.skie_finish_event_payment_shutdown_action(uuid, text, text, text, integer)
to service_role;
grant execute on function public.skie_operations_health(integer, integer)
to service_role;

notify pgrst, 'reload schema';

commit;
