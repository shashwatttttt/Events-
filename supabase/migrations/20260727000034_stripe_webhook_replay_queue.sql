-- Retry temporary Stripe webhook failures from Stripe's immutable event ID.
-- No raw card, customer or webhook payload is stored in this queue.

begin;

create table if not exists public.stripe_webhook_replay_actions (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  status text not null default 'requested'
    check (status in ('requested','processing','retry','completed','manual_review')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  safe_error_code text check (safe_error_code is null or length(safe_error_code) <= 120),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.stripe_webhook_replay_actions enable row level security;
revoke all on table public.stripe_webhook_replay_actions from public, anon, authenticated;
grant select, insert, update, delete on table public.stripe_webhook_replay_actions to service_role;

create index if not exists stripe_webhook_replay_actions_claim_idx
on public.stripe_webhook_replay_actions (status, available_at, lease_expires_at, created_at);

create or replace function public.skie_request_stripe_webhook_replay(
  p_stripe_event_id text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_id uuid;
begin
  if length(trim(coalesce(p_stripe_event_id,''))) not between 5 and 255 then
    raise exception 'WEBHOOK_REPLAY_EVENT_INVALID';
  end if;
  if not exists (
    select 1
    from public.stripe_webhook_events as event
    where event.stripe_event_id = trim(p_stripe_event_id)
      and event.status = 'temporary_failure'
  ) then
    raise exception 'WEBHOOK_REPLAY_NOT_TEMPORARY';
  end if;

  insert into public.stripe_webhook_replay_actions(stripe_event_id,status,available_at)
  values (trim(p_stripe_event_id),'requested',now())
  on conflict (stripe_event_id) do update
  set status = case
        when public.stripe_webhook_replay_actions.status in ('completed','manual_review')
          then public.stripe_webhook_replay_actions.status
        else 'requested'
      end,
      available_at = case
        when public.stripe_webhook_replay_actions.status in ('completed','manual_review')
          then public.stripe_webhook_replay_actions.available_at
        else now()
      end,
      lease_owner = case
        when public.stripe_webhook_replay_actions.status in ('completed','manual_review')
          then public.stripe_webhook_replay_actions.lease_owner
        else null
      end,
      lease_expires_at = case
        when public.stripe_webhook_replay_actions.status in ('completed','manual_review')
          then public.stripe_webhook_replay_actions.lease_expires_at
        else null
      end,
      updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.skie_queue_temporary_stripe_webhook_replays()
returns integer
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_inserted integer;
begin
  insert into public.stripe_webhook_replay_actions(stripe_event_id,status,available_at)
  select event.stripe_event_id,'requested',now()
  from public.stripe_webhook_events as event
  where event.status = 'temporary_failure'
  on conflict (stripe_event_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create or replace function public.skie_claim_stripe_webhook_replays(
  p_worker_id text,
  p_batch_size integer default 10,
  p_lease_seconds integer default 60
)
returns setof public.stripe_webhook_replay_actions
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if length(trim(coalesce(p_worker_id,''))) not between 8 and 100
    or p_batch_size not between 1 and 25
    or p_lease_seconds not between 10 and 300 then
    raise exception 'WEBHOOK_REPLAY_CLAIM_INVALID';
  end if;

  update public.stripe_webhook_replay_actions
  set status = 'retry',
      available_at = now(),
      lease_owner = null,
      lease_expires_at = null,
      safe_error_code = coalesce(safe_error_code,'WEBHOOK_REPLAY_LEASE_TIMEOUT'),
      updated_at = now()
  where status = 'processing'
    and (
      lease_expires_at <= now()
      or (lease_expires_at is null and updated_at <= now() - interval '2 minutes')
    );

  return query
  with candidates as (
    select replay.id
    from public.stripe_webhook_replay_actions as replay
    where replay.status in ('requested','retry')
      and replay.available_at <= now()
    order by replay.available_at,replay.created_at,replay.id
    for update skip locked
    limit p_batch_size
  )
  update public.stripe_webhook_replay_actions as replay
  set status = 'processing',
      attempt_count = replay.attempt_count + 1,
      lease_owner = trim(p_worker_id),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      safe_error_code = null,
      updated_at = now()
  from candidates
  where replay.id = candidates.id
  returning replay.*;
end;
$$;

create or replace function public.skie_finish_stripe_webhook_replay(
  p_replay_id uuid,
  p_worker_id text,
  p_result text,
  p_safe_error_code text default null,
  p_retry_delay_seconds integer default 60
)
returns public.stripe_webhook_replay_actions
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_replay public.stripe_webhook_replay_actions%rowtype;
begin
  if p_result not in ('completed','retry','manual_review')
    or length(coalesce(p_safe_error_code,'')) > 120
    or p_retry_delay_seconds not between 10 and 86400 then
    raise exception 'WEBHOOK_REPLAY_RESULT_INVALID';
  end if;

  update public.stripe_webhook_replay_actions as replay
  set status = p_result,
      available_at = case
        when p_result = 'retry' then now() + make_interval(secs => p_retry_delay_seconds)
        else replay.available_at
      end,
      lease_owner = null,
      lease_expires_at = null,
      safe_error_code = nullif(trim(coalesce(p_safe_error_code,'')),''),
      completed_at = case when p_result = 'completed' then coalesce(replay.completed_at,now()) else null end,
      updated_at = now()
  where replay.id = p_replay_id
    and replay.status = 'processing'
    and replay.lease_owner = trim(p_worker_id)
  returning replay.* into v_replay;

  if not found then raise exception 'WEBHOOK_REPLAY_LEASE_LOST'; end if;
  return v_replay;
end;
$$;

revoke all on function public.skie_request_stripe_webhook_replay(text)
from public, anon, authenticated;
revoke all on function public.skie_queue_temporary_stripe_webhook_replays()
from public, anon, authenticated;
revoke all on function public.skie_claim_stripe_webhook_replays(text,integer,integer)
from public, anon, authenticated;
revoke all on function public.skie_finish_stripe_webhook_replay(uuid,text,text,text,integer)
from public, anon, authenticated;

grant execute on function public.skie_request_stripe_webhook_replay(text)
to service_role;
grant execute on function public.skie_queue_temporary_stripe_webhook_replays()
to service_role;
grant execute on function public.skie_claim_stripe_webhook_replays(text,integer,integer)
to service_role;
grant execute on function public.skie_finish_stripe_webhook_replay(uuid,text,text,text,integer)
to service_role;

notify pgrst, 'reload schema';

commit;
