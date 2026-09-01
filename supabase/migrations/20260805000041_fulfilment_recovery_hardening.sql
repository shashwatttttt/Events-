-- Prevent successful payment and ticket state from regressing during duplicate
-- Stripe webhooks, worker retries, or guest-list fulfilment retries.

begin;

create or replace function public.skie_preserve_fulfilled_reservation_state()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if old.status = 'fulfilled'
    and new.status in ('reserved','session_active','payment_received','fulfilment_pending','paid_unfulfilled') then
    new.status := 'fulfilled';
    new.failure_code := old.failure_code;
  end if;
  return new;
end;
$$;

create or replace function public.skie_preserve_fulfilled_order_state()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if old.status = 'fulfilled'
    and new.status in ('reserved','checkout_pending','payment_received','fulfilment_pending','paid_unfulfilled') then
    new.status := 'fulfilled';
    new.fulfilled_at := coalesce(old.fulfilled_at,new.fulfilled_at,now());
    if old.workflow_status = 'fulfilled' then
      new.workflow_status := 'fulfilled';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.skie_preserve_fulfilled_checkout_attempt_state()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if old.status = 'fulfilled'
    and new.status in ('creating_session','session_active','payment_received') then
    new.status := 'fulfilled';
    new.failure_code := old.failure_code;
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_00_prevent_fulfilled_regression on public.reservations;
create trigger reservations_00_prevent_fulfilled_regression
before update on public.reservations
for each row execute function public.skie_preserve_fulfilled_reservation_state();

drop trigger if exists orders_00_prevent_fulfilled_regression on public.orders;
create trigger orders_00_prevent_fulfilled_regression
before update on public.orders
for each row execute function public.skie_preserve_fulfilled_order_state();

drop trigger if exists checkout_attempts_00_prevent_fulfilled_regression on public.checkout_attempts;
create trigger checkout_attempts_00_prevent_fulfilled_regression
before update on public.checkout_attempts
for each row execute function public.skie_preserve_fulfilled_checkout_attempt_state();

-- A guest-list or test retry must reuse the existing offline payment ledger row.
create or replace function public.skie_ignore_duplicate_offline_payment()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.provider in ('free','test') and exists (
    select 1
    from public.payments as existing
    where existing.order_id = new.order_id
      and existing.provider = new.provider
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists payments_00_ignore_duplicate_offline on public.payments;
create trigger payments_00_ignore_duplicate_offline
before insert on public.payments
for each row execute function public.skie_ignore_duplicate_offline_payment();

-- If a complete ticket set already exists, a retry must not manufacture a new
-- set with fresh UUIDs. The existing fulfilment RPC will count the retained rows
-- and restore the durable order state.
create or replace function public.skie_ignore_complete_ticket_retry()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_expected integer;
  v_existing integer;
begin
  select coalesce(sum(line.quantity),0)::integer
  into v_expected
  from public.orders as ordered
  join public.reservation_ticket_lines as line
    on line.reservation_id = ordered.reservation_id
  where ordered.id = new.order_id;

  select count(*)::integer
  into v_existing
  from public.tickets as existing
  where existing.order_id = new.order_id;

  if v_expected > 0 and v_existing >= v_expected then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_00_ignore_complete_retry on public.tickets;
create trigger tickets_00_ignore_complete_retry
before insert on public.tickets
for each row execute function public.skie_ignore_complete_ticket_retry();

create or replace function public.skie_ignore_duplicate_entitlement_retry()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if exists (
    select 1
    from public.entitlements as existing
    where existing.order_line_id = new.order_line_id
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists entitlements_00_ignore_duplicate_retry on public.entitlements;
create trigger entitlements_00_ignore_duplicate_retry
before insert on public.entitlements
for each row execute function public.skie_ignore_duplicate_entitlement_retry();

create or replace function public.skie_prevent_allocation_double_increment()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if old.status = 'ticket_issued'
    and new.status = 'ticket_issued'
    and new.purchased_quantity > old.purchased_quantity then
    new.purchased_quantity := old.purchased_quantity;
  end if;
  return new;
end;
$$;

drop trigger if exists ticket_allocations_00_prevent_double_increment on public.ticket_allocations;
create trigger ticket_allocations_00_prevent_double_increment
before update on public.ticket_allocations
for each row execute function public.skie_prevent_allocation_double_increment();

-- Repair orders where the complete durable ticket and entitlement set already
-- exists but a later duplicate payment/replay moved state backwards.
create temporary table skie_fulfilment_repair_orders (
  order_id uuid primary key
) on commit drop;

insert into skie_fulfilment_repair_orders(order_id)
select ordered.id
from public.orders as ordered
join public.reservations as reservation on reservation.id = ordered.reservation_id
where ordered.status in ('payment_received','fulfilment_pending','paid_unfulfilled','manual_review','fulfilled')
  and exists (
    select 1 from public.payments as payment
    where payment.order_id = ordered.id
      and payment.status in ('payment_received','paid','partially_refunded','disputed','suspended')
  )
  and (select coalesce(sum(line.quantity),0)::integer
       from public.reservation_ticket_lines as line
       where line.reservation_id = reservation.id) > 0
  and (select count(*)::integer
       from public.tickets as ticket
       where ticket.order_id = ordered.id
         and ticket.status not in ('cancelled','refunded','expired'))
      = (select coalesce(sum(line.quantity),0)::integer
         from public.reservation_ticket_lines as line
         where line.reservation_id = reservation.id)
  and (select count(*)::integer
       from public.entitlements as entitlement
       where entitlement.order_id = ordered.id
         and entitlement.status not in ('cancelled','refunded'))
      = (select count(*)::integer
         from public.reservation_product_lines as product
         where product.reservation_id = reservation.id
           and product.redeemable);

update public.reservations as reservation
set status = 'fulfilled',
    failure_code = null
from public.orders as ordered
join skie_fulfilment_repair_orders as repair on repair.order_id = ordered.id
where reservation.id = ordered.reservation_id;

update public.orders as ordered
set status = 'fulfilled',
    workflow_status = case
      when ordered.checkout_mode = 'post_checkout_approval' then 'fulfilled'
      else ordered.workflow_status
    end,
    fulfilled_at = coalesce(ordered.fulfilled_at,now())
from skie_fulfilment_repair_orders as repair
where ordered.id = repair.order_id;

update public.checkout_attempts as attempt
set status = 'fulfilled',
    failure_code = null
from skie_fulfilment_repair_orders as repair
where attempt.order_id = repair.order_id;

update public.payments as payment
set status = 'paid'
from skie_fulfilment_repair_orders as repair
where payment.order_id = repair.order_id
  and payment.status = 'payment_received';

update public.post_checkout_applications as application
set status = case decision.decision
      when 'approve_without_form' then 'approved_override'
      when 'approve' then 'approved'
      else application.status
    end,
    failure_code = null,
    last_activity_at = now(),
    state_version = application.state_version + 1
from skie_fulfilment_repair_orders as repair
join public.post_checkout_decisions as decision on decision.order_id = repair.order_id
where application.order_id = repair.order_id
  and application.status in ('capture_pending','approved','approved_override','manual_review')
  and application.payment_status in ('captured','not_required');

update public.post_checkout_payment_actions as action
set status = 'completed',
    safe_error_code = null,
    lease_owner = null,
    lease_expires_at = null,
    completed_at = coalesce(action.completed_at,now()),
    updated_at = now()
from skie_fulfilment_repair_orders as repair
where action.order_id = repair.order_id
  and action.action_type in ('capture','reconcile')
  and action.status <> 'completed';

update public.stripe_webhook_events as event
set status = 'processed',
    safe_error_code = null,
    lease_expires_at = null,
    processed_at = coalesce(event.processed_at,now()),
    updated_at = now()
where event.status <> 'processed'
  and event.event_type in (
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'payment_intent.amount_capturable_updated',
    'payment_intent.succeeded'
  )
  and exists (
    select 1
    from public.payments as payment
    join skie_fulfilment_repair_orders as repair on repair.order_id = payment.order_id
    where (event.payment_intent_id is not null and payment.stripe_payment_intent_id = event.payment_intent_id)
       or (event.checkout_session_id is not null and payment.stripe_checkout_session_id = event.checkout_session_id)
  );

update public.stripe_webhook_replay_actions as replay
set status = 'completed',
    safe_error_code = null,
    lease_owner = null,
    lease_expires_at = null,
    completed_at = coalesce(replay.completed_at,now()),
    updated_at = now()
from public.stripe_webhook_events as event
where event.stripe_event_id = replay.stripe_event_id
  and event.status = 'processed'
  and replay.status <> 'completed';

-- Retry unresolved fulfilment work once after the idempotency guards are live.
update public.post_checkout_payment_actions as action
set status = 'retry',
    available_at = now(),
    lease_owner = null,
    lease_expires_at = null,
    safe_error_code = null,
    completed_at = null,
    updated_at = now()
from public.orders as ordered
where ordered.id = action.order_id
  and ordered.status in ('payment_received','fulfilment_pending','paid_unfulfilled')
  and action.action_type in ('capture','reconcile')
  and action.status in ('failed','manual_review')
  and action.safe_error_code = 'FULFILMENT_FAILED';

update public.stripe_webhook_events as event
set status = 'temporary_failure',
    safe_error_code = 'FULFILMENT_RETRY_REQUIRED',
    lease_expires_at = null,
    next_attempt_at = now(),
    updated_at = now()
where event.status in ('permanent_failure','manual_review')
  and event.event_type in ('checkout.session.completed','checkout.session.async_payment_succeeded','payment_intent.succeeded')
  and exists (
    select 1
    from public.payments as payment
    join public.orders as ordered on ordered.id = payment.order_id
    where ordered.status in ('payment_received','fulfilment_pending','paid_unfulfilled')
      and ((event.payment_intent_id is not null and payment.stripe_payment_intent_id = event.payment_intent_id)
        or (event.checkout_session_id is not null and payment.stripe_checkout_session_id = event.checkout_session_id))
  );

update public.stripe_webhook_replay_actions as replay
set status = 'retry',
    available_at = now(),
    lease_owner = null,
    lease_expires_at = null,
    safe_error_code = 'FULFILMENT_RETRY_REQUIRED',
    completed_at = null,
    updated_at = now()
from public.stripe_webhook_events as event
where event.stripe_event_id = replay.stripe_event_id
  and event.status = 'temporary_failure'
  and event.safe_error_code = 'FULFILMENT_RETRY_REQUIRED';

-- Advance the fail-closed schema contract only when every existing check and
-- every new fulfilment guard is installed and enabled.
alter function public.skie_post_checkout_schema_health()
  rename to skie_post_checkout_schema_health_v40;

create or replace function public.skie_post_checkout_schema_health()
returns table(schema_version integer, ready boolean, details jsonb)
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_previous_version integer;
  v_previous_ready boolean;
  v_details jsonb;
  v_reservation_guard boolean;
  v_order_guard boolean;
  v_attempt_guard boolean;
  v_offline_guard boolean;
  v_ticket_guard boolean;
  v_entitlement_guard boolean;
  v_allocation_guard boolean;
begin
  select health.schema_version,health.ready,health.details
  into v_previous_version,v_previous_ready,v_details
  from public.skie_post_checkout_schema_health_v40() as health;

  select exists(select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_00_prevent_fulfilled_regression' and not tgisinternal and tgenabled <> 'D') into v_reservation_guard;
  select exists(select 1 from pg_trigger where tgrelid = 'public.orders'::regclass and tgname = 'orders_00_prevent_fulfilled_regression' and not tgisinternal and tgenabled <> 'D') into v_order_guard;
  select exists(select 1 from pg_trigger where tgrelid = 'public.checkout_attempts'::regclass and tgname = 'checkout_attempts_00_prevent_fulfilled_regression' and not tgisinternal and tgenabled <> 'D') into v_attempt_guard;
  select exists(select 1 from pg_trigger where tgrelid = 'public.payments'::regclass and tgname = 'payments_00_ignore_duplicate_offline' and not tgisinternal and tgenabled <> 'D') into v_offline_guard;
  select exists(select 1 from pg_trigger where tgrelid = 'public.tickets'::regclass and tgname = 'tickets_00_ignore_complete_retry' and not tgisinternal and tgenabled <> 'D') into v_ticket_guard;
  select exists(select 1 from pg_trigger where tgrelid = 'public.entitlements'::regclass and tgname = 'entitlements_00_ignore_duplicate_retry' and not tgisinternal and tgenabled <> 'D') into v_entitlement_guard;
  select exists(select 1 from pg_trigger where tgrelid = 'public.ticket_allocations'::regclass and tgname = 'ticket_allocations_00_prevent_double_increment' and not tgisinternal and tgenabled <> 'D') into v_allocation_guard;

  v_details := coalesce(v_details,'{}'::jsonb) || jsonb_build_object(
    'fulfilledReservationRegressionGuard',v_reservation_guard,
    'fulfilledOrderRegressionGuard',v_order_guard,
    'fulfilledAttemptRegressionGuard',v_attempt_guard,
    'duplicateOfflinePaymentGuard',v_offline_guard,
    'completeTicketRetryGuard',v_ticket_guard,
    'duplicateEntitlementRetryGuard',v_entitlement_guard,
    'allocationDoubleIncrementGuard',v_allocation_guard,
    'previousSchemaVersion',v_previous_version
  );

  return query select
    41,
    v_previous_ready
      and v_reservation_guard
      and v_order_guard
      and v_attempt_guard
      and v_offline_guard
      and v_ticket_guard
      and v_entitlement_guard
      and v_allocation_guard,
    v_details;
end;
$$;

revoke all on function public.skie_preserve_fulfilled_reservation_state() from public, anon, authenticated;
revoke all on function public.skie_preserve_fulfilled_order_state() from public, anon, authenticated;
revoke all on function public.skie_preserve_fulfilled_checkout_attempt_state() from public, anon, authenticated;
revoke all on function public.skie_ignore_duplicate_offline_payment() from public, anon, authenticated;
revoke all on function public.skie_ignore_complete_ticket_retry() from public, anon, authenticated;
revoke all on function public.skie_ignore_duplicate_entitlement_retry() from public, anon, authenticated;
revoke all on function public.skie_prevent_allocation_double_increment() from public, anon, authenticated;
revoke all on function public.skie_post_checkout_schema_health_v40() from public, anon, authenticated;
revoke all on function public.skie_post_checkout_schema_health() from public, anon, authenticated;

grant execute on function public.skie_post_checkout_schema_health_v40() to service_role;
grant execute on function public.skie_post_checkout_schema_health() to service_role;

notify pgrst, 'reload schema';
commit;
