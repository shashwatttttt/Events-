-- Keep post-checkout promo reservations consistent across restart, rejection,
-- authorization expiry and Stripe initialization failures.

begin;

create or replace function public.skie_restart_unpaid_post_checkout(
  p_order_id uuid,
  p_failure_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_order public.orders%rowtype;
  v_reservation public.reservations%rowtype;
  v_attempt public.checkout_attempts%rowtype;
begin
  select * into v_application
  from public.post_checkout_applications
  where order_id = p_order_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.status <> 'awaiting_authorization'
    or v_application.payment_status <> 'authorization_pending'
    or v_application.stripe_payment_intent_id is not null then
    raise exception 'POST_APPROVAL_RESTART_NOT_ALLOWED';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  select * into v_reservation from public.reservations where id = v_application.reservation_id for update;
  select * into v_attempt from public.checkout_attempts where id = v_application.checkout_attempt_id for update;

  if v_order.id is null or v_reservation.id is null or v_attempt.id is null then
    raise exception 'POST_APPROVAL_TRANSACTION_INCOMPLETE';
  end if;
  if v_order.status not in ('reserved','checkout_pending')
    or v_reservation.status not in ('reserved','session_active')
    or v_attempt.status not in ('creating_session','session_active','session_expired') then
    raise exception 'POST_APPROVAL_RESTART_NOT_ALLOWED';
  end if;

  update public.post_checkout_applications
  set status = 'rejected',
      payment_status = 'failed',
      failure_code = left(coalesce(p_failure_code,'POST_APPROVAL_RESTARTED'),120),
      next_reminder_at = null,
      state_version = state_version + 1
  where id = v_application.id;

  update public.orders
  set status = 'failed',
      workflow_status = 'payment_failed',
      state_version = state_version + 1
  where id = v_order.id;

  update public.reservations
  set status = 'failed',
      failure_code = left(coalesce(p_failure_code,'POST_APPROVAL_RESTARTED'),120)
  where id = v_reservation.id;

  update public.checkout_attempts
  set status = 'session_failed',
      failure_code = left(coalesce(p_failure_code,'POST_APPROVAL_RESTARTED'),120)
  where id = v_attempt.id;

  update public.promo_redemptions
  set status = 'released',
      released_at = coalesce(released_at,now()),
      updated_at = now()
  where order_id = v_order.id
    and status = 'reserved';

  if v_reservation.allocation_id is not null then
    update public.ticket_allocations
    set status = case when expires_at <= now() then 'expired' else 'unlocked' end,
        version = version + 1,
        updated_at = now()
    where id = v_reservation.allocation_id
      and status = 'checkout_started';
  end if;

  insert into public.post_checkout_audit_events (
    application_id,order_id,action,safe_metadata
  ) values (
    v_application.id,v_order.id,'post_checkout.unpaid_checkout_restarted',
    jsonb_build_object('failureCode',left(coalesce(p_failure_code,'POST_APPROVAL_RESTARTED'),120))
  );
end;
$$;

create or replace function public.skie_fail_post_checkout_initialization(
  p_order_id uuid,
  p_failure_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_order public.orders%rowtype;
  v_reservation public.reservations%rowtype;
begin
  select * into v_application
  from public.post_checkout_applications
  where order_id = p_order_id
  for update;

  if not found then return; end if;
  if v_application.status <> 'awaiting_authorization'
    or v_application.payment_status <> 'authorization_pending' then return; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  select * into v_reservation from public.reservations where id = v_application.reservation_id for update;

  update public.post_checkout_applications
  set status = 'rejected',
      payment_status = 'failed',
      failure_code = left(coalesce(p_failure_code,'CHECKOUT_INITIALIZATION_FAILED'),120),
      next_reminder_at = null,
      state_version = state_version + 1
  where id = v_application.id;

  update public.orders
  set status = 'failed',
      workflow_status = 'payment_failed',
      state_version = state_version + 1
  where id = p_order_id
    and status in ('reserved','checkout_pending','failed');

  update public.reservations
  set status = 'failed',
      failure_code = left(coalesce(p_failure_code,'CHECKOUT_INITIALIZATION_FAILED'),120)
  where id = v_application.reservation_id
    and status in ('reserved','session_active','failed');

  update public.checkout_attempts
  set status = 'session_failed',
      failure_code = left(coalesce(p_failure_code,'CHECKOUT_INITIALIZATION_FAILED'),120)
  where id = v_application.checkout_attempt_id
    and status in ('creating_session','session_active','session_failed','session_expired');

  update public.promo_redemptions
  set status = 'released',
      released_at = coalesce(released_at,now()),
      updated_at = now()
  where order_id = p_order_id
    and status = 'reserved';

  if v_reservation.allocation_id is not null then
    update public.ticket_allocations
    set status = case when expires_at <= now() then 'expired' else 'unlocked' end,
        version = version + 1,
        updated_at = now()
    where id = v_reservation.allocation_id
      and status = 'checkout_started';
  end if;

  insert into public.post_checkout_audit_events (
    application_id,order_id,action,safe_metadata
  ) values (
    v_application.id,p_order_id,'post_checkout.initialization_failed',
    jsonb_build_object('failureCode',left(coalesce(p_failure_code,'CHECKOUT_INITIALIZATION_FAILED'),120))
  );
end;
$$;

create or replace function public.skie_mark_post_checkout_cancelled(
  p_payment_intent_id text,
  p_reason text
)
returns table(application_id uuid, order_id uuid, reservation_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_status text;
begin
  select * into v_application
  from public.post_checkout_applications
  where stripe_payment_intent_id = p_payment_intent_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status = 'captured' then
    raise exception 'POST_APPROVAL_ALREADY_CAPTURED';
  end if;

  if v_application.payment_status in ('cancelled','expired')
    and v_application.status in ('rejected','form_expired','authorization_expired','withdrawn') then
    update public.promo_redemptions
    set status = 'released',
        released_at = coalesce(released_at,now()),
        updated_at = now()
    where order_id = v_application.order_id
      and status = 'reserved';
    return query select v_application.id,v_application.order_id,v_application.reservation_id;
    return;
  end if;

  v_status := case
    when v_application.status = 'form_expired' or p_reason = 'form_expired' then 'form_expired'
    when v_application.status = 'authorization_expired' or p_reason = 'authorization_expired' then 'authorization_expired'
    when v_application.status = 'withdrawn' or p_reason = 'withdrawn' then 'withdrawn'
    else 'rejected'
  end;

  update public.post_checkout_applications
  set status = v_status,
      payment_status = case when v_status = 'authorization_expired' then 'expired' else 'cancelled' end,
      capturable_amount_cents = 0,
      next_reminder_at = null,
      failure_code = null,
      state_version = state_version + 1
  where id = v_application.id
  returning * into v_application;

  update public.post_checkout_payment_actions
  set status = 'completed',
      completed_at = now(),
      safe_error_code = null,
      lease_owner = null,
      lease_expires_at = null
  where application_id = v_application.id
    and action_type = 'cancel'
    and status <> 'completed';

  update public.orders
  set status = 'cancelled',
      workflow_status = case
        when v_status = 'form_expired' then 'form_expired'
        when v_status = 'authorization_expired' then 'authorization_expired'
        else 'rejected'
      end,
      state_version = state_version + 1
  where id = v_application.order_id;

  update public.reservations
  set status = 'cancelled'
  where id = v_application.reservation_id
    and status not in ('fulfilled','refunded','partially_refunded');

  update public.checkout_attempts
  set status = 'session_expired'
  where id = v_application.checkout_attempt_id
    and status <> 'fulfilled';

  update public.promo_redemptions
  set status = 'released',
      released_at = coalesce(released_at,now()),
      updated_at = now()
  where order_id = v_application.order_id
    and status = 'reserved';

  insert into public.post_checkout_audit_events (
    application_id,order_id,action,safe_metadata
  ) values (
    v_application.id,v_application.order_id,'post_checkout.cancelled',
    jsonb_build_object('reason',v_status)
  );

  return query select v_application.id,v_application.order_id,v_application.reservation_id;
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
      ), false) as promo_release_guard
  )
  select
    18,
    authorization_rpc and submit_rpc and decision_rpc and worker_rpc and restart_rpc
      and reservation_guard and reservation_trigger and monotonic_expiry_guard and promo_release_guard,
    jsonb_build_object(
      'authorizationRpc',authorization_rpc,
      'submitRpc',submit_rpc,
      'decisionRpc',decision_rpc,
      'workerRpc',worker_rpc,
      'restartRpc',restart_rpc,
      'reservationGuard',reservation_guard,
      'reservationTrigger',reservation_trigger,
      'monotonicExpiryGuard',monotonic_expiry_guard,
      'promoReleaseGuard',promo_release_guard
    )
  from required;
$$;

revoke all on function public.skie_restart_unpaid_post_checkout(uuid,text)
from public, anon, authenticated;
grant execute on function public.skie_restart_unpaid_post_checkout(uuid,text)
to service_role;

revoke all on function public.skie_fail_post_checkout_initialization(uuid,text)
from public, anon, authenticated;
grant execute on function public.skie_fail_post_checkout_initialization(uuid,text)
to service_role;

revoke all on function public.skie_mark_post_checkout_cancelled(text,text)
from public, anon, authenticated;
grant execute on function public.skie_mark_post_checkout_cancelled(text,text)
to service_role;

revoke all on function public.skie_post_checkout_schema_health()
from public, anon, authenticated;
grant execute on function public.skie_post_checkout_schema_health()
to service_role;

notify pgrst, 'reload schema';

commit;
