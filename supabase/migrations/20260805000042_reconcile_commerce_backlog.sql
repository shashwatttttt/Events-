-- Reconcile historical payment/webhook work only when the durable database
-- already proves that the corresponding provider transition has been applied.
-- No charge, capture, cancellation, refund or ticket is created by this migration.

begin;

-- A ticket remains proof of fulfilment after check-in or entry processing. The
-- previous function required a currently-valid ticket and could therefore make
-- an already fulfilled order appear failed during a later Stripe replay.
create or replace function public.skie_mark_post_checkout_fulfilled(
  p_order_id uuid
)
returns table(application_id uuid, order_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_order public.orders%rowtype;
  v_decision public.post_checkout_decisions%rowtype;
  v_duplicate boolean := false;
  v_issued_ticket_count integer;
  v_target_status text;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;
  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;
  if v_order.checkout_mode <> 'post_checkout_approval' then raise exception 'POST_APPROVAL_MODE_MISMATCH'; end if;
  if v_order.status <> 'fulfilled' then raise exception 'POST_APPROVAL_ORDER_NOT_FULFILLED'; end if;

  select * into v_application
  from public.post_checkout_applications
  where order_id = p_order_id
  for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status not in ('captured','not_required') then
    raise exception 'POST_APPROVAL_PAYMENT_NOT_CAPTURED';
  end if;

  select * into v_decision
  from public.post_checkout_decisions
  where order_id = p_order_id
  limit 1;
  if not found or v_decision.decision not in ('approve','approve_without_form') then
    raise exception 'POST_APPROVAL_APPLICATION_NOT_APPROVED';
  end if;
  v_target_status := case
    when v_decision.decision = 'approve_without_form' then 'approved_override'
    else 'approved'
  end;

  select count(*)::integer into v_issued_ticket_count
  from public.tickets
  where order_id = p_order_id
    and status not in ('cancelled','refunded','expired');
  if v_issued_ticket_count < 1 then raise exception 'POST_APPROVAL_NO_ISSUED_TICKETS'; end if;

  v_duplicate := v_order.workflow_status = 'fulfilled'
    and v_application.status = v_target_status
    and v_application.failure_code is null;

  update public.post_checkout_applications
  set status = v_target_status,
      failure_code = null,
      last_activity_at = now(),
      state_version = case
        when status is distinct from v_target_status or failure_code is not null
          then state_version + 1
        else state_version
      end
  where id = v_application.id;

  update public.orders
  set workflow_status = 'fulfilled',
      state_version = case
        when workflow_status <> 'fulfilled' then state_version + 1
        else state_version
      end,
      fulfilled_at = coalesce(fulfilled_at,now())
  where id = p_order_id;

  if not v_duplicate and not exists (
    select 1
    from public.post_checkout_audit_events
    where order_id = p_order_id and action = 'post_checkout.fulfilled'
  ) then
    insert into public.post_checkout_audit_events(
      application_id,order_id,action,safe_metadata
    ) values (
      v_application.id,p_order_id,'post_checkout.fulfilled',
      jsonb_build_object(
        'issuedTicketCount',v_issued_ticket_count,
        'paymentRequired',v_application.payment_status <> 'not_required',
        'reconciled',true
      )
    );
  end if;

  return query select v_application.id,p_order_id,v_duplicate;
end;
$$;

-- Restore any missing immutable order-line projections from the reservation
-- snapshot. This is safe because each source line is uniquely constrained and
-- the operation does not change price, quantity, payment or stock.
insert into public.order_lines(
  order_id,reservation_ticket_line_id,kind,reference_id,name,quantity,unit_price_cents
)
select
  ordered.id,line.id,'ticket',line.ticket_type_id,line.name,line.quantity,line.unit_price_cents
from public.orders as ordered
join public.reservations as reservation on reservation.id = ordered.reservation_id
join public.reservation_ticket_lines as line on line.reservation_id = reservation.id
where ordered.status in ('payment_received','fulfilment_pending','paid_unfulfilled','manual_review')
  and exists (
    select 1 from public.payments as payment
    where payment.order_id = ordered.id
      and payment.status in ('payment_received','paid','partially_refunded','disputed','suspended')
  )
  and not exists (
    select 1 from public.order_lines as existing
    where existing.order_id = ordered.id
      and existing.reservation_ticket_line_id = line.id
  )
on conflict (order_id,reservation_ticket_line_id) do nothing;

insert into public.order_lines(
  order_id,reservation_product_line_id,kind,reference_id,name,quantity,unit_price_cents
)
select
  ordered.id,line.id,'product',line.product_id,line.name,line.quantity,line.unit_price_cents
from public.orders as ordered
join public.reservations as reservation on reservation.id = ordered.reservation_id
join public.reservation_product_lines as line on line.reservation_id = reservation.id
where ordered.status in ('payment_received','fulfilment_pending','paid_unfulfilled','manual_review')
  and exists (
    select 1 from public.payments as payment
    where payment.order_id = ordered.id
      and payment.status in ('payment_received','paid','partially_refunded','disputed','suspended')
  )
  and not exists (
    select 1 from public.order_lines as existing
    where existing.order_id = ordered.id
      and existing.reservation_product_line_id = line.id
  )
on conflict (order_id,reservation_product_line_id) do nothing;

-- Close payment actions only when durable state proves their intended terminal
-- transition has already completed.
update public.post_checkout_payment_actions as action
set status = 'completed',
    safe_error_code = null,
    lease_owner = null,
    lease_expires_at = null,
    completed_at = coalesce(action.completed_at,now()),
    updated_at = now()
from public.post_checkout_applications as application
join public.orders as ordered on ordered.id = application.order_id
where action.application_id = application.id
  and action.status <> 'completed'
  and (
    (
      action.action_type in ('capture','reconcile')
      and application.payment_status in ('captured','not_required')
      and ordered.status = 'fulfilled'
      and exists (
        select 1 from public.tickets as ticket
        where ticket.order_id = ordered.id
          and ticket.status not in ('cancelled','refunded','expired')
      )
    )
    or (
      action.action_type in ('cancel','reconcile')
      and application.payment_status in ('cancelled','expired')
      and ordered.status in ('cancelled','expired','failed')
    )
  );

-- Requeue a structurally complete captured order once. The worker retrieves the
-- current Stripe PaymentIntent before doing anything, so a succeeded intent is
-- reconciled rather than captured again.
update public.post_checkout_payment_actions as action
set status = 'retry',
    available_at = now(),
    lease_owner = null,
    lease_expires_at = null,
    safe_error_code = 'FULFILMENT_RETRY_REQUIRED',
    completed_at = null,
    updated_at = now()
from public.post_checkout_applications as application
join public.orders as ordered on ordered.id = application.order_id
join public.reservations as reservation on reservation.id = ordered.reservation_id
where action.application_id = application.id
  and action.action_type in ('capture','reconcile')
  and action.status in ('failed','manual_review')
  and action.safe_error_code in ('FULFILMENT_FAILED','TRANSACTION_STORE_UNAVAILABLE','FULFILMENT_RETRY_REQUIRED')
  and application.payment_status = 'captured'
  and ordered.status in ('payment_received','fulfilment_pending','paid_unfulfilled','manual_review')
  and exists (
    select 1 from public.payments as payment
    where payment.order_id = ordered.id
      and payment.status in ('payment_received','paid','partially_refunded','disputed','suspended')
  )
  and exists (
    select 1 from public.reservation_ticket_lines as line
    where line.reservation_id = reservation.id and line.quantity > 0
  )
  and not exists (
    select 1
    from public.reservation_ticket_lines as line
    where line.reservation_id = reservation.id
      and not exists (
        select 1 from public.order_lines as projected
        where projected.order_id = ordered.id
          and projected.reservation_ticket_line_id = line.id
      )
  )
  and not exists (
    select 1
    from public.reservation_product_lines as line
    where line.reservation_id = reservation.id
      and not exists (
        select 1 from public.order_lines as projected
        where projected.order_id = ordered.id
          and projected.reservation_product_line_id = line.id
      )
  );

-- Give any remaining generic payment action a bounded structural diagnosis so
-- it is actionable without exposing customer, order or Stripe identifiers.
update public.post_checkout_payment_actions as action
set safe_error_code = case
      when not exists (
        select 1 from public.payments as payment where payment.order_id = action.order_id
      ) then 'FULFILMENT_PAYMENT_LEDGER_MISSING'
      when not exists (
        select 1
        from public.orders as ordered
        join public.reservation_ticket_lines as line on line.reservation_id = ordered.reservation_id
        where ordered.id = action.order_id and line.quantity > 0
      ) then 'FULFILMENT_TICKET_SNAPSHOT_MISSING'
      when exists (
        select 1
        from public.orders as ordered
        join public.reservation_ticket_lines as line on line.reservation_id = ordered.reservation_id
        where ordered.id = action.order_id
          and not exists (
            select 1 from public.order_lines as projected
            where projected.order_id = ordered.id
              and projected.reservation_ticket_line_id = line.id
          )
      ) then 'FULFILMENT_TICKET_LINE_MISSING'
      when exists (
        select 1
        from public.orders as ordered
        join public.reservation_product_lines as line on line.reservation_id = ordered.reservation_id
        where ordered.id = action.order_id
          and not exists (
            select 1 from public.order_lines as projected
            where projected.order_id = ordered.id
              and projected.reservation_product_line_id = line.id
          )
      ) then 'FULFILMENT_PRODUCT_LINE_MISSING'
      when exists (
        select 1 from public.tickets as ticket where ticket.order_id = action.order_id
      ) then 'FULFILMENT_PARTIAL_OR_TERMINAL_TICKETS'
      else 'FULFILMENT_PROVIDER_REVIEW_REQUIRED'
    end,
    updated_at = now()
where action.status in ('failed','manual_review')
  and action.safe_error_code in ('FULFILMENT_FAILED','TRANSACTION_STORE_UNAVAILABLE','FULFILMENT_RETRY_REQUIRED');

-- Mark a historical Stripe event processed only when a durable record proves
-- that its specific transition was already applied.
update public.stripe_webhook_events as event
set status = 'processed',
    safe_error_code = null,
    lease_expires_at = null,
    processed_at = coalesce(event.processed_at,now()),
    updated_at = now()
where event.status in ('temporary_failure','permanent_failure','manual_review')
  and (
    (
      event.event_type in ('checkout.session.completed','checkout.session.async_payment_succeeded')
      and event.checkout_session_id is not null
      and exists (
        select 1
        from public.checkout_attempts as attempt
        left join public.post_checkout_applications as application
          on application.checkout_attempt_id = attempt.id
        left join public.payments as payment
          on payment.stripe_checkout_session_id = event.checkout_session_id
        where attempt.stripe_checkout_session_id = event.checkout_session_id
          and (
            payment.status in ('payment_received','paid','partially_refunded','refunded','disputed','suspended')
            or application.payment_status in ('authorized','not_required','capture_requested','captured','cancel_requested','cancelled','expired')
          )
      )
    )
    or (
      event.event_type = 'payment_intent.amount_capturable_updated'
      and event.payment_intent_id is not null
      and exists (
        select 1 from public.post_checkout_applications as application
        where application.stripe_payment_intent_id = event.payment_intent_id
          and application.payment_status in ('authorized','capture_requested','captured','cancel_requested','cancelled','expired')
      )
    )
    or (
      event.event_type = 'payment_intent.succeeded'
      and event.payment_intent_id is not null
      and exists (
        select 1
        from public.payments as payment
        join public.orders as ordered on ordered.id = payment.order_id
        where payment.stripe_payment_intent_id = event.payment_intent_id
          and payment.status in ('paid','partially_refunded','refunded','disputed','suspended')
          and ordered.status in ('fulfilled','partially_refunded','refunded','disputed','suspended')
      )
    )
    or (
      event.event_type = 'payment_intent.canceled'
      and event.payment_intent_id is not null
      and (
        exists (
          select 1 from public.post_checkout_applications as application
          where application.stripe_payment_intent_id = event.payment_intent_id
            and application.payment_status in ('cancelled','expired')
        )
        or exists (
          select 1 from public.payments as payment
          where payment.stripe_payment_intent_id = event.payment_intent_id
            and payment.status = 'cancelled'
        )
      )
    )
    or (
      event.event_type in ('checkout.session.expired','checkout.session.async_payment_failed')
      and event.checkout_session_id is not null
      and exists (
        select 1
        from public.checkout_attempts as attempt
        join public.orders as ordered on ordered.id = attempt.order_id
        where attempt.stripe_checkout_session_id = event.checkout_session_id
          and (
            attempt.status in ('session_expired','session_failed','recovery_failed')
            or ordered.status in ('expired','cancelled','failed','recovery_failed')
          )
      )
    )
    or (
      event.event_type = 'payment_intent.payment_failed'
      and event.payment_intent_id is not null
      and exists (
        select 1 from public.payments as payment
        where payment.stripe_payment_intent_id = event.payment_intent_id
          and payment.status = 'failed'
      )
    )
    or (
      event.event_type in ('refund.created','refund.updated')
      and event.refund_id is not null
      and exists (
        select 1 from public.payment_adjustments as adjustment
        where adjustment.provider_object_id = event.refund_id
          and adjustment.kind = 'refund'
      )
    )
    or (
      event.event_type in ('charge.dispute.created','charge.dispute.closed')
      and event.dispute_id is not null
      and exists (
        select 1 from public.payment_adjustments as adjustment
        where adjustment.provider_object_id = event.dispute_id
          and adjustment.kind = 'dispute'
      )
    )
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

-- Replace generic replay codes with a bounded event-class diagnosis for any
-- genuinely unresolved historical record that remains for manual review.
update public.stripe_webhook_events as event
set safe_error_code = case
      when event.event_type in ('checkout.session.completed','checkout.session.async_payment_succeeded')
        then 'WEBHOOK_CHECKOUT_STATE_REVIEW'
      when event.event_type like 'payment_intent.%'
        then 'WEBHOOK_PAYMENT_INTENT_STATE_REVIEW'
      when event.event_type like 'refund.%'
        then 'WEBHOOK_REFUND_STATE_REVIEW'
      when event.event_type like 'charge.dispute.%'
        then 'WEBHOOK_DISPUTE_STATE_REVIEW'
      else 'WEBHOOK_EVENT_STATE_REVIEW'
    end,
    updated_at = now()
where event.status in ('permanent_failure','manual_review')
  and coalesce(event.safe_error_code,'') in ('','WEBHOOK_PROCESSING_FAILED','FULFILMENT_FAILED','TRANSACTION_STORE_UNAVAILABLE');

update public.stripe_webhook_replay_actions as replay
set safe_error_code = event.safe_error_code,
    updated_at = now()
from public.stripe_webhook_events as event
where event.stripe_event_id = replay.stripe_event_id
  and replay.status = 'manual_review'
  and event.status in ('permanent_failure','manual_review');

-- Advance fail-closed readiness only when the prior v41 contract and the
-- checked-in-ticket fulfilment guard are both present.
alter function public.skie_post_checkout_schema_health()
  rename to skie_post_checkout_schema_health_v41;

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
  v_fulfilment_reconciliation_guard boolean := false;
begin
  select health.schema_version,health.ready,health.details
  into v_previous_version,v_previous_ready,v_details
  from public.skie_post_checkout_schema_health_v41() as health;

  select coalesce(
    position('status not in (''cancelled'',''refunded'',''expired'')' in lower(pg_get_functiondef(p.oid))) > 0
      and position('reconciled' in lower(pg_get_functiondef(p.oid))) > 0,
    false
  )
  into v_fulfilment_reconciliation_guard
  from pg_proc as p
  join pg_namespace as n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'skie_mark_post_checkout_fulfilled'
  limit 1;

  v_details := coalesce(v_details,'{}'::jsonb) || jsonb_build_object(
    'postCheckoutFulfilmentReconciliationGuard',v_fulfilment_reconciliation_guard,
    'previousSchemaVersion',v_previous_version
  );

  return query select
    42,
    v_previous_ready and v_fulfilment_reconciliation_guard,
    v_details;
end;
$$;

revoke all on function public.skie_mark_post_checkout_fulfilled(uuid)
from public, anon, authenticated;
revoke all on function public.skie_post_checkout_schema_health_v41()
from public, anon, authenticated;
revoke all on function public.skie_post_checkout_schema_health()
from public, anon, authenticated;

grant execute on function public.skie_mark_post_checkout_fulfilled(uuid)
to service_role;
grant execute on function public.skie_post_checkout_schema_health_v41()
to service_role;
grant execute on function public.skie_post_checkout_schema_health()
to service_role;

notify pgrst, 'reload schema';
commit;
