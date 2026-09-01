-- Requeue only Stripe succeeded events linked to the structurally repaired
-- post-checkout action from migration 42. Stripe is read before any worker
-- action and the existing idempotent fulfilment path remains authoritative.

begin;

update public.stripe_webhook_events as event
set status = 'temporary_failure',
    safe_error_code = 'FULFILMENT_RETRY_REQUIRED',
    next_attempt_at = now(),
    lease_expires_at = null,
    updated_at = now()
where event.event_type = 'payment_intent.succeeded'
  and event.payment_intent_id is not null
  and event.status in ('permanent_failure','manual_review')
  and exists (
    select 1
    from public.post_checkout_payment_actions as action
    where action.stripe_payment_intent_id = event.payment_intent_id
      and action.action_type in ('capture','reconcile')
      and action.status = 'retry'
      and action.safe_error_code = 'FULFILMENT_RETRY_REQUIRED'
  );

insert into public.stripe_webhook_replay_actions(
  stripe_event_id,status,available_at,safe_error_code
)
select
  event.stripe_event_id,'retry',now(),'FULFILMENT_RETRY_REQUIRED'
from public.stripe_webhook_events as event
where event.status = 'temporary_failure'
  and event.safe_error_code = 'FULFILMENT_RETRY_REQUIRED'
on conflict (stripe_event_id) do update
set status = 'retry',
    available_at = now(),
    lease_owner = null,
    lease_expires_at = null,
    safe_error_code = 'FULFILMENT_RETRY_REQUIRED',
    completed_at = null,
    updated_at = now()
where public.stripe_webhook_replay_actions.status <> 'processing';

notify pgrst, 'reload schema';
commit;
