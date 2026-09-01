-- Make post-checkout application/admin status reconciliation idempotent after
-- durable ticket fulfilment. This migration never charges, captures, refunds,
-- cancels or creates a ticket. It only accepts an already fulfilled order when
-- the paid ledger and complete issued-ticket set prove the transition occurred.

begin;

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
  v_decision text;
  v_audit_action text;
  v_target_status text;
  v_expected_ticket_count integer := 0;
  v_issued_ticket_count integer := 0;
  v_payment_proven boolean := false;
  v_duplicate boolean := false;
begin
  select ordered.* into v_order
  from public.orders as ordered
  where ordered.id = p_order_id
  for update;
  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;
  if v_order.checkout_mode <> 'post_checkout_approval' then
    raise exception 'POST_APPROVAL_MODE_MISMATCH';
  end if;
  if v_order.status <> 'fulfilled' then
    raise exception 'POST_APPROVAL_ORDER_NOT_FULFILLED';
  end if;

  select application.* into v_application
  from public.post_checkout_applications as application
  where application.order_id = p_order_id
  for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;

  -- A no-payment guest-list approval is already proven by its distinct durable
  -- state. A paid application requires a payment ledger row for this order and,
  -- when present, the same PaymentIntent stored on the application.
  if v_application.payment_status = 'not_required' then
    v_payment_proven := true;
  else
    select exists (
      select 1
      from public.payments as payment
      where payment.order_id = p_order_id
        and payment.status in (
          'payment_received','paid','partially_refunded','refunded','disputed','suspended'
        )
        and (
          v_application.stripe_payment_intent_id is null
          or payment.stripe_payment_intent_id = v_application.stripe_payment_intent_id
        )
    ) into v_payment_proven;
  end if;
  if not v_payment_proven then raise exception 'POST_APPROVAL_PAYMENT_NOT_CAPTURED'; end if;

  -- Require the complete immutable ticket quantity, not merely one surviving
  -- ticket. Order lines are authoritative; reservation snapshots are a safe
  -- fallback for historical orders whose projection was repaired later.
  select coalesce(sum(line.quantity),0)::integer into v_expected_ticket_count
  from public.order_lines as line
  where line.order_id = p_order_id and line.kind = 'ticket';

  if v_expected_ticket_count < 1 then
    select coalesce(sum(line.quantity),0)::integer into v_expected_ticket_count
    from public.reservation_ticket_lines as line
    where line.reservation_id = v_order.reservation_id;
  end if;
  if v_expected_ticket_count < 1 then
    raise exception 'POST_APPROVAL_TICKET_SNAPSHOT_MISSING';
  end if;

  select count(*)::integer into v_issued_ticket_count
  from public.tickets as ticket
  where ticket.order_id = p_order_id
    and ticket.status not in ('cancelled','refunded','expired');
  if v_issued_ticket_count < v_expected_ticket_count then
    raise exception 'POST_APPROVAL_TICKET_SET_INCOMPLETE';
  end if;

  -- Prefer the immutable decision record. Historical records may have already
  -- reached an approved application state or retained the corresponding audit
  -- event even when the decision projection drifted; either remains proof of
  -- prior admin approval and does not create a new decision.
  select decision.decision into v_decision
  from public.post_checkout_decisions as decision
  where decision.order_id = p_order_id
    and decision.decision in ('approve','approve_without_form')
  order by decision.created_at desc
  limit 1;

  if v_decision is null then
    select audit.action into v_audit_action
    from public.post_checkout_audit_events as audit
    where audit.order_id = p_order_id
      and audit.action in (
        'post_checkout.approve',
        'post_checkout.approve_without_form',
        'post_checkout.fulfilled'
      )
    order by audit.created_at desc
    limit 1;
  end if;

  v_target_status := case
    when v_decision = 'approve_without_form'
      or v_audit_action = 'post_checkout.approve_without_form'
      or v_application.status = 'approved_override'
      or v_application.override_used
      then 'approved_override'
    when v_decision = 'approve'
      or v_audit_action in ('post_checkout.approve','post_checkout.fulfilled')
      or v_application.status = 'approved'
      then 'approved'
    else null
  end;
  if v_target_status is null then
    raise exception 'POST_APPROVAL_APPLICATION_NOT_APPROVED';
  end if;

  v_duplicate := v_order.workflow_status = 'fulfilled'
    and v_application.status = v_target_status
    and v_application.failure_code is null
    and (
      v_application.payment_status = 'not_required'
      or v_application.payment_status = 'captured'
    );

  update public.post_checkout_applications as application
  set status = v_target_status,
      payment_status = case
        when application.payment_status = 'not_required' then 'not_required'
        else 'captured'
      end,
      failure_code = null,
      last_activity_at = now(),
      updated_at = now(),
      state_version = case
        when application.status is distinct from v_target_status
          or application.failure_code is not null
          or application.payment_status not in ('captured','not_required')
          then application.state_version + 1
        else application.state_version
      end
  where application.id = v_application.id;

  update public.orders as ordered
  set workflow_status = 'fulfilled',
      fulfilled_at = coalesce(ordered.fulfilled_at,now()),
      updated_at = now(),
      state_version = case
        when ordered.workflow_status <> 'fulfilled' then ordered.state_version + 1
        else ordered.state_version
      end
  where ordered.id = p_order_id;

  -- Close every duplicate capture/reconcile action only after the proof above.
  update public.post_checkout_payment_actions as action
  set status = 'completed',
      safe_error_code = null,
      lease_owner = null,
      lease_expires_at = null,
      completed_at = coalesce(action.completed_at,now()),
      updated_at = now()
  where action.application_id = v_application.id
    and action.action_type in ('capture','reconcile')
    and action.status <> 'completed';

  -- A succeeded Stripe event linked to this already fulfilled PaymentIntent is
  -- processed, and its replay action is closed. This prevents the same durable
  -- success from being replayed forever after the customer already has tickets.
  update public.stripe_webhook_events as event
  set status = 'processed',
      safe_error_code = null,
      lease_expires_at = null,
      next_attempt_at = now(),
      processed_at = coalesce(event.processed_at,now()),
      updated_at = now()
  where event.event_type = 'payment_intent.succeeded'
    and v_application.stripe_payment_intent_id is not null
    and event.payment_intent_id = v_application.stripe_payment_intent_id
    and event.status <> 'processed';

  update public.stripe_webhook_replay_actions as replay
  set status = 'completed',
      safe_error_code = null,
      lease_owner = null,
      lease_expires_at = null,
      completed_at = coalesce(replay.completed_at,now()),
      updated_at = now()
  from public.stripe_webhook_events as event
  where event.stripe_event_id = replay.stripe_event_id
    and event.event_type = 'payment_intent.succeeded'
    and v_application.stripe_payment_intent_id is not null
    and event.payment_intent_id = v_application.stripe_payment_intent_id
    and event.status = 'processed'
    and replay.status <> 'completed';

  if not exists (
    select 1
    from public.post_checkout_audit_events as audit
    where audit.order_id = p_order_id
      and audit.action = 'post_checkout.fulfilled'
  ) then
    insert into public.post_checkout_audit_events(
      application_id,order_id,action,safe_metadata
    ) values (
      v_application.id,
      p_order_id,
      'post_checkout.fulfilled',
      jsonb_build_object(
        'issuedTicketCount',v_issued_ticket_count,
        'expectedTicketCount',v_expected_ticket_count,
        'paymentRequired',v_application.payment_status <> 'not_required',
        'reconciled',true,
        'statusSyncRepair',true
      )
    );
  end if;

  return query select v_application.id,p_order_id,v_duplicate;
end;
$$;

-- Reconcile existing fulfilled post-checkout orders. Every candidate still
-- passes all proof guards inside the function; an unrelated malformed record
-- is left for manual review without blocking this additive migration.
do $$
declare
  candidate record;
begin
  for candidate in
    select ordered.id
    from public.orders as ordered
    join public.post_checkout_applications as application
      on application.order_id = ordered.id
    where ordered.checkout_mode = 'post_checkout_approval'
      and ordered.status = 'fulfilled'
      and (
        ordered.workflow_status <> 'fulfilled'
        or application.status not in ('approved','approved_override')
        or application.failure_code is not null
        or exists (
          select 1
          from public.post_checkout_payment_actions as action
          where action.application_id = application.id
            and action.action_type in ('capture','reconcile')
            and action.status <> 'completed'
        )
        or exists (
          select 1
          from public.stripe_webhook_events as event
          where event.event_type = 'payment_intent.succeeded'
            and event.payment_intent_id = application.stripe_payment_intent_id
            and event.status <> 'processed'
        )
      )
  loop
    begin
      perform 1
      from public.skie_mark_post_checkout_fulfilled(candidate.id);
    exception when others then
      -- Preserve genuine structural exceptions for the existing recovery UI.
      null;
    end;
  end loop;
end;
$$;

-- Advance the fail-closed schema contract only when the complete-ticket proof,
-- paid-ledger proof and replay/action closure are present in the reconciler.
alter function public.skie_post_checkout_schema_health()
  rename to skie_post_checkout_schema_health_v42;

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
  v_status_reconciliation_guard boolean := false;
begin
  select health.schema_version,health.ready,health.details
  into v_previous_version,v_previous_ready,v_details
  from public.skie_post_checkout_schema_health_v42() as health;

  select coalesce(
    position('v_expected_ticket_count' in lower(pg_get_functiondef(proc.oid))) > 0
      and position('payment.status in (' in lower(pg_get_functiondef(proc.oid))) > 0
      and position('post_checkout_payment_actions' in lower(pg_get_functiondef(proc.oid))) > 0
      and position('stripe_webhook_replay_actions' in lower(pg_get_functiondef(proc.oid))) > 0
      and position('statussyncrepair' in lower(pg_get_functiondef(proc.oid))) > 0,
    false
  )
  into v_status_reconciliation_guard
  from pg_proc as proc
  join pg_namespace as namespace on namespace.oid = proc.pronamespace
  where namespace.nspname = 'public'
    and proc.proname = 'skie_mark_post_checkout_fulfilled'
  limit 1;

  v_details := coalesce(v_details,'{}'::jsonb) || jsonb_build_object(
    'postCheckoutStatusReconciliationGuard',v_status_reconciliation_guard,
    'previousSchemaVersion',v_previous_version
  );

  return query select
    44,
    v_previous_ready and v_previous_version >= 42 and v_status_reconciliation_guard,
    v_details;
end;
$$;

revoke all on function public.skie_mark_post_checkout_fulfilled(uuid)
from public, anon, authenticated;
revoke all on function public.skie_post_checkout_schema_health_v42()
from public, anon, authenticated;
revoke all on function public.skie_post_checkout_schema_health()
from public, anon, authenticated;

grant execute on function public.skie_mark_post_checkout_fulfilled(uuid)
to service_role;
grant execute on function public.skie_post_checkout_schema_health_v42()
to service_role;
grant execute on function public.skie_post_checkout_schema_health()
to service_role;

notify pgrst, 'reload schema';
commit;
