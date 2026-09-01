-- Guarantee that every fulfilled order has durable notification-enqueue work.
-- The trigger runs in the same database transaction that marks the order
-- fulfilled; application delivery remains an idempotent fast path.

begin;

create table if not exists public.notification_enqueue_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  job_type text not null default 'order_fulfilment'
    check (job_type in ('order_fulfilment')),
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
  unique (order_id, job_type)
);

alter table public.notification_enqueue_jobs enable row level security;
revoke all on table public.notification_enqueue_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.notification_enqueue_jobs to service_role;

create index if not exists notification_enqueue_jobs_claim_idx
on public.notification_enqueue_jobs (status, available_at, lease_expires_at, created_at);

create or replace function public.skie_queue_order_fulfilment_notification_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if new.status = 'fulfilled'
    and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    insert into public.notification_enqueue_jobs(order_id, job_type, status, available_at)
    values (new.id, 'order_fulfilment', 'requested', now())
    on conflict (order_id, job_type) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_queue_fulfilment_notifications on public.orders;
create trigger orders_queue_fulfilment_notifications
after insert or update of status on public.orders
for each row execute function public.skie_queue_order_fulfilment_notification_job();

-- Repair only recent fulfilled orders that have no durable ticket notification.
-- Existing outbox idempotency keys prevent duplicate delivery if another path
-- queued the message between this check and worker processing.
insert into public.notification_enqueue_jobs(order_id, job_type, status, available_at)
select o.id, 'order_fulfilment', 'requested', now()
from public.orders as o
where o.status = 'fulfilled'
  and o.updated_at >= now() - interval '30 days'
  and not exists (
    select 1
    from public.notification_outbox as n
    where n.order_id = o.id
      and n.template_key = 'ticket_issued'
  )
on conflict (order_id, job_type) do nothing;

create or replace function public.skie_claim_notification_enqueue_jobs(
  p_worker_id text,
  p_batch_size integer default 10,
  p_lease_seconds integer default 60
)
returns setof public.notification_enqueue_jobs
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if length(trim(coalesce(p_worker_id,''))) not between 8 and 100
    or p_batch_size not between 1 and 25
    or p_lease_seconds not between 10 and 300 then
    raise exception 'NOTIFICATION_ENQUEUE_CLAIM_INVALID';
  end if;

  update public.notification_enqueue_jobs
  set status = 'retry',
      available_at = now(),
      lease_owner = null,
      lease_expires_at = null,
      safe_error_code = coalesce(safe_error_code, 'NOTIFICATION_ENQUEUE_LEASE_TIMEOUT'),
      updated_at = now()
  where status = 'processing'
    and (
      lease_expires_at <= now()
      or (lease_expires_at is null and updated_at <= now() - interval '2 minutes')
    );

  return query
  with candidates as (
    select job.id
    from public.notification_enqueue_jobs as job
    where job.status in ('requested','retry')
      and job.available_at <= now()
    order by job.available_at, job.created_at, job.id
    for update skip locked
    limit p_batch_size
  )
  update public.notification_enqueue_jobs as job
  set status = 'processing',
      attempt_count = job.attempt_count + 1,
      lease_owner = trim(p_worker_id),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      safe_error_code = null,
      updated_at = now()
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

create or replace function public.skie_finish_notification_enqueue_job(
  p_job_id uuid,
  p_worker_id text,
  p_result text,
  p_safe_error_code text default null,
  p_retry_delay_seconds integer default 60
)
returns public.notification_enqueue_jobs
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_job public.notification_enqueue_jobs%rowtype;
begin
  if p_result not in ('completed','retry','manual_review')
    or length(coalesce(p_safe_error_code,'')) > 120
    or p_retry_delay_seconds not between 10 and 86400 then
    raise exception 'NOTIFICATION_ENQUEUE_RESULT_INVALID';
  end if;

  update public.notification_enqueue_jobs as job
  set status = p_result,
      available_at = case
        when p_result = 'retry' then now() + make_interval(secs => p_retry_delay_seconds)
        else job.available_at
      end,
      lease_owner = null,
      lease_expires_at = null,
      safe_error_code = nullif(trim(coalesce(p_safe_error_code,'')),''),
      completed_at = case when p_result = 'completed' then coalesce(job.completed_at,now()) else null end,
      updated_at = now()
  where job.id = p_job_id
    and job.status = 'processing'
    and job.lease_owner = trim(p_worker_id)
  returning job.* into v_job;

  if not found then raise exception 'NOTIFICATION_ENQUEUE_LEASE_LOST'; end if;
  return v_job;
end;
$$;

create or replace function public.skie_complete_order_notification_enqueue_job(
  p_order_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_updated integer;
begin
  update public.notification_enqueue_jobs
  set status = 'completed',
      completed_at = coalesce(completed_at,now()),
      safe_error_code = null,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = now()
  where order_id = p_order_id
    and job_type = 'order_fulfilment'
    and status in ('requested','retry');
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- Add durable enqueue health to the existing aggregate operations function.
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

revoke all on function public.skie_queue_order_fulfilment_notification_job()
from public, anon, authenticated;
revoke all on function public.skie_claim_notification_enqueue_jobs(text, integer, integer)
from public, anon, authenticated;
revoke all on function public.skie_finish_notification_enqueue_job(uuid, text, text, text, integer)
from public, anon, authenticated;
revoke all on function public.skie_complete_order_notification_enqueue_job(uuid)
from public, anon, authenticated;
revoke all on function public.skie_operations_health(integer, integer)
from public, anon, authenticated;

grant execute on function public.skie_queue_order_fulfilment_notification_job()
to service_role;
grant execute on function public.skie_claim_notification_enqueue_jobs(text, integer, integer)
to service_role;
grant execute on function public.skie_finish_notification_enqueue_job(uuid, text, text, text, integer)
to service_role;
grant execute on function public.skie_complete_order_notification_enqueue_job(uuid)
to service_role;
grant execute on function public.skie_operations_health(integer, integer)
to service_role;

notify pgrst, 'reload schema';

commit;
