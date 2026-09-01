-- Close historical Stripe success/progression events only when durable
-- post-checkout state proves the customer already has a fully fulfilled order.
-- This migration performs no Stripe mutation and creates no payment or ticket.

begin;

create or replace function public.skie_reconcile_fulfilled_post_checkout_webhook_history()
returns table(events_completed integer, replay_actions_completed integer)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_events_completed integer := 0;
  v_replay_actions_completed integer := 0;
begin
  with proven_fulfilment as materialized (
    select
      application.id as application_id,
      application.stripe_payment_intent_id,
      coalesce(
        application.stripe_checkout_session_id,
        attempt.stripe_checkout_session_id
      ) as stripe_checkout_session_id,
      coalesce(
        nullif((
          select coalesce(sum(line.quantity),0)::integer
          from public.order_lines as line
          where line.order_id = ordered.id and line.kind = 'ticket'
        ),0),
        (
          select coalesce(sum(line.quantity),0)::integer
          from public.reservation_ticket_lines as line
          where line.reservation_id = ordered.reservation_id
        ),
        0
      ) as v_expected_ticket_count,
      (
        select count(*)::integer
        from public.tickets as ticket
        where ticket.order_id = ordered.id
          and ticket.status not in ('cancelled','refunded','expired')
      ) as v_issued_ticket_count
    from public.post_checkout_applications as application
    join public.orders as ordered on ordered.id = application.order_id
    left join public.checkout_attempts as attempt
      on attempt.id = application.checkout_attempt_id
    where ordered.checkout_mode = 'post_checkout_approval'
      and ordered.status = 'fulfilled'
      and ordered.workflow_status = 'fulfilled'
      and application.status in ('approved','approved_override')
      and application.failure_code is null
      and (
        application.payment_status = 'not_required'
        or exists (
          select 1
          from public.payments as payment
          where payment.order_id = ordered.id
            and payment.status in (
              'payment_received','paid','partially_refunded','refunded','disputed','suspended'
            )
            and (
              application.stripe_payment_intent_id is null
              or payment.stripe_payment_intent_id = application.stripe_payment_intent_id
            )
        )
      )
  )
  update public.stripe_webhook_events as event
  set status = 'processed',
      safe_error_code = null,
      lease_expires_at = null,
      next_attempt_at = now(),
      processed_at = coalesce(event.processed_at,now()),
      updated_at = now()
  where event.status in ('temporary_failure','permanent_failure','manual_review')
    and event.event_type in (
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'payment_intent.amount_capturable_updated',
      'payment_intent.succeeded'
    )
    and exists (
      select 1
      from proven_fulfilment as proof
      where proof.v_expected_ticket_count > 0
        and proof.v_issued_ticket_count >= proof.v_expected_ticket_count
        and (
          (
            event.payment_intent_id is not null
            and proof.stripe_payment_intent_id = event.payment_intent_id
          )
          or (
            event.checkout_session_id is not null
            and proof.stripe_checkout_session_id = event.checkout_session_id
          )
        )
    );
  get diagnostics v_events_completed = row_count;

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
    and replay.status not in ('completed','processing');
  get diagnostics v_replay_actions_completed = row_count;

  return query select v_events_completed,v_replay_actions_completed;
end;
$$;

-- Reconcile the currently known historical backlog immediately. The same
-- proof-based function is retained for the scheduled worker to run before
-- replay processing so this class of stale event cannot accumulate again.
select *
from public.skie_reconcile_fulfilled_post_checkout_webhook_history();

-- Advance fail-closed database readiness after the reusable reconciliation
-- function and its complete-ticket proof are installed.
alter function public.skie_post_checkout_schema_health()
  rename to skie_post_checkout_schema_health_v44;

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
  v_fulfilled_webhook_history_guard boolean := false;
begin
  select health.schema_version,health.ready,health.details
  into v_previous_version,v_previous_ready,v_details
  from public.skie_post_checkout_schema_health_v44() as health;

  select coalesce(
    position('v_expected_ticket_count' in lower(pg_get_functiondef(proc.oid))) > 0
      and position('v_issued_ticket_count' in lower(pg_get_functiondef(proc.oid))) > 0
      and position('payment_intent.amount_capturable_updated' in lower(pg_get_functiondef(proc.oid))) > 0
      and position('stripe_webhook_replay_actions' in lower(pg_get_functiondef(proc.oid))) > 0
      and position('replay.status not in (''completed'',''processing'')' in lower(pg_get_functiondef(proc.oid))) > 0,
    false
  )
  into v_fulfilled_webhook_history_guard
  from pg_proc as proc
  join pg_namespace as namespace on namespace.oid = proc.pronamespace
  where namespace.nspname = 'public'
    and proc.proname = 'skie_reconcile_fulfilled_post_checkout_webhook_history'
  limit 1;

  v_details := coalesce(v_details,'{}'::jsonb) || jsonb_build_object(
    'fulfilledPostCheckoutWebhookHistoryGuard',v_fulfilled_webhook_history_guard,
    'previousSchemaVersion',v_previous_version
  );

  return query select
    45,
    v_previous_ready and v_previous_version >= 44 and v_fulfilled_webhook_history_guard,
    v_details;
end;
$$;

revoke all on function public.skie_reconcile_fulfilled_post_checkout_webhook_history()
from public, anon, authenticated;
revoke all on function public.skie_post_checkout_schema_health_v44()
from public, anon, authenticated;
revoke all on function public.skie_post_checkout_schema_health()
from public, anon, authenticated;

grant execute on function public.skie_reconcile_fulfilled_post_checkout_webhook_history()
to service_role;
grant execute on function public.skie_post_checkout_schema_health_v44()
to service_role;
grant execute on function public.skie_post_checkout_schema_health()
to service_role;

notify pgrst, 'reload schema';
commit;
