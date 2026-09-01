-- Runtime guards for reservation ownership, deadline extension and crashed workers.

begin;

create or replace function public.skie_guard_post_checkout_decision()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_reservation public.reservations%rowtype;
  v_capture_hold_until timestamptz;
begin
  if new.decision not in ('approve','approve_without_form') then
    return new;
  end if;

  select * into v_application
  from public.post_checkout_applications
  where id = new.application_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_PAYMENT_NOT_AUTHORIZED';
  end if;
  if v_application.capture_before is null then
    raise exception 'POST_APPROVAL_CAPTURE_DEADLINE_MISSING';
  end if;
  if v_application.capture_before <= now() + interval '60 minutes' then
    raise exception 'POST_APPROVAL_AUTHORIZATION_TOO_CLOSE_TO_EXPIRY';
  end if;

  select * into v_reservation
  from public.reservations
  where id = v_application.reservation_id
  for update;

  if not found or v_reservation.status <> 'session_active' or v_reservation.expires_at <= now() then
    raise exception 'POST_APPROVAL_RESERVATION_NOT_ACTIVE';
  end if;

  v_capture_hold_until := least(
    v_application.capture_before - interval '60 minutes',
    now() + interval '15 minutes'
  );

  if v_capture_hold_until <= now() then
    raise exception 'POST_APPROVAL_AUTHORIZATION_TOO_CLOSE_TO_EXPIRY';
  end if;

  update public.reservations
  set expires_at = greatest(expires_at,v_capture_hold_until)
  where id = v_application.reservation_id;

  return new;
end;
$$;

revoke all on function public.skie_guard_post_checkout_decision()
from public, anon, authenticated;

drop trigger if exists post_checkout_decision_guard on public.post_checkout_decisions;
create trigger post_checkout_decision_guard
before insert on public.post_checkout_decisions
for each row execute function public.skie_guard_post_checkout_decision();

create or replace function public.skie_extend_post_checkout_form_deadline(
  p_application_id uuid,
  p_actor_id uuid,
  p_form_due_at timestamptz
)
returns table(application_id uuid, form_due_at timestamptz, state_version integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
begin
  select * into v_application
  from public.post_checkout_applications
  where id = p_application_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.status not in ('awaiting_form','draft')
    or v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_DEADLINE_NOT_EXTENDABLE';
  end if;
  if p_form_due_at <= now() then raise exception 'POST_APPROVAL_FORM_DEADLINE_INVALID'; end if;
  if v_application.capture_before is not null
    and p_form_due_at >= v_application.capture_before - interval '60 minutes' then
    raise exception 'POST_APPROVAL_FORM_DEADLINE_TOO_LATE';
  end if;

  update public.post_checkout_applications
  set form_due_at = p_form_due_at,
      next_reminder_at = least(p_form_due_at,now() + interval '10 minutes'),
      state_version = state_version + 1
  where id = v_application.id
  returning * into v_application;

  update public.reservations
  set expires_at = greatest(expires_at,p_form_due_at)
  where id = v_application.reservation_id
    and status = 'session_active';

  if not found then raise exception 'POST_APPROVAL_RESERVATION_NOT_ACTIVE'; end if;

  insert into public.post_checkout_audit_events (
    application_id,order_id,actor_id,action,safe_metadata
  ) values (
    v_application.id,v_application.order_id,p_actor_id,
    'post_checkout.form_deadline_extended',
    jsonb_build_object('formDueAt',p_form_due_at)
  );

  return query
  select v_application.id,v_application.form_due_at,v_application.state_version;
end;
$$;

revoke all on function public.skie_extend_post_checkout_form_deadline(uuid,uuid,timestamptz)
from public, anon, authenticated;
grant execute on function public.skie_extend_post_checkout_form_deadline(uuid,uuid,timestamptz)
to service_role;

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
  if length(trim(coalesce(p_worker_id,''))) < 8
    or p_limit < 1 or p_limit > 25
    or p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'POST_APPROVAL_WORKER_CLAIM_INVALID';
  end if;

  update public.post_checkout_payment_actions
  set status = 'retry',
      safe_error_code = 'POST_APPROVAL_ACTION_LEASE_TIMEOUT',
      available_at = now(),
      lease_owner = null,
      lease_expires_at = null
  where status = 'processing'
    and lease_expires_at is not null
    and lease_expires_at <= now();

  return query
  with candidates as (
    select id
    from public.post_checkout_payment_actions
    where status in ('requested','retry')
      and available_at <= now()
      and (lease_expires_at is null or lease_expires_at <= now())
    order by created_at
    for update skip locked
    limit p_limit
  )
  update public.post_checkout_payment_actions action
  set status = 'processing',
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt_count = action.attempt_count + 1,
      last_attempt_at = now()
  from candidates
  where action.id = candidates.id
  returning action.*;
end;
$$;

revoke all on function public.skie_claim_post_checkout_payment_actions(text,integer,integer)
from public, anon, authenticated;
grant execute on function public.skie_claim_post_checkout_payment_actions(text,integer,integer)
to service_role;

commit;
