-- Reconcile durable post-checkout state after Stripe has already confirmed that
-- a manual-capture PaymentIntent is terminally cancelled. Provider status is
-- verified by the trusted worker before this RPC is called.

begin;

create or replace function public.skie_reconcile_cancelled_post_checkout_action(
  p_action_id uuid,
  p_reason text
)
returns table(application_id uuid, order_id uuid, reservation_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action public.post_checkout_payment_actions%rowtype;
  v_application public.post_checkout_applications%rowtype;
  v_status text;
begin
  if p_reason not in ('rejected','form_expired','authorization_expired','withdrawn') then
    raise exception 'POST_APPROVAL_CANCEL_REASON_INVALID';
  end if;

  select pa.* into v_action
  from public.post_checkout_payment_actions as pa
  where pa.id = p_action_id
  for update;

  if not found then raise exception 'POST_APPROVAL_PAYMENT_ACTION_NOT_FOUND'; end if;

  select pca.* into v_application
  from public.post_checkout_applications as pca
  where pca.id = v_action.application_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.stripe_payment_intent_id is null
    or v_application.stripe_payment_intent_id <> v_action.stripe_payment_intent_id then
    raise exception 'PAYMENT_INTENT_MISMATCH';
  end if;
  if v_application.payment_status = 'captured' then
    raise exception 'POST_APPROVAL_ALREADY_CAPTURED';
  end if;

  v_status := case
    when v_application.status = 'form_expired' or p_reason = 'form_expired' then 'form_expired'
    when v_application.status = 'authorization_expired' or p_reason = 'authorization_expired' then 'authorization_expired'
    when v_application.status = 'withdrawn' or p_reason = 'withdrawn' then 'withdrawn'
    else 'rejected'
  end;

  update public.post_checkout_applications as pca
  set status = v_status,
      payment_status = case when v_status = 'authorization_expired' then 'expired' else 'cancelled' end,
      capturable_amount_cents = 0,
      next_reminder_at = null,
      failure_code = null,
      state_version = pca.state_version + 1
  where pca.id = v_application.id;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;

  update public.orders as o
  set status = 'cancelled',
      workflow_status = case
        when v_status = 'form_expired' then 'form_expired'
        when v_status = 'authorization_expired' then 'authorization_expired'
        else 'rejected'
      end,
      state_version = o.state_version + 1
  where o.id = v_application.order_id;

  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;

  update public.post_checkout_payment_actions as pa
  set status = 'completed',
      completed_at = coalesce(pa.completed_at,now()),
      safe_error_code = null,
      lease_owner = null,
      lease_expires_at = null
  where pa.application_id = v_application.id
    and pa.status <> 'completed';

  -- Secondary cleanup must never prevent the authoritative payment/application
  -- state from reaching a terminal result. Each operation is independently
  -- idempotent and may be retried by later maintenance tooling if required.
  begin
    update public.reservations as r
    set status = 'cancelled',
        failure_code = null
    where r.id = v_application.reservation_id
      and r.status not in ('fulfilled','refunded','partially_refunded');
  exception when others then
    null;
  end;

  begin
    update public.checkout_attempts as ca
    set status = 'session_expired',
        failure_code = null
    where ca.id = v_application.checkout_attempt_id
      and ca.status <> 'fulfilled';
  exception when others then
    null;
  end;

  begin
    update public.promo_redemptions as pr
    set status = 'released',
        released_at = coalesce(pr.released_at,now()),
        updated_at = now()
    where pr.order_id = v_application.order_id
      and pr.status = 'reserved';
  exception when others then
    null;
  end;

  begin
    insert into public.post_checkout_audit_events (
      application_id,order_id,action,safe_metadata
    ) values (
      v_application.id,v_application.order_id,
      'post_checkout.terminal_cancellation_reconciled',
      jsonb_build_object('reason',v_status,'paymentActionId',v_action.id)
    );
  exception when others then
    null;
  end;

  return query
  select v_application.id,v_application.order_id,v_application.reservation_id;
end;
$$;

-- Preserve the existing application service contract while routing terminal
-- cancellation through the hardened action-scoped reconciler. The currently
-- processing action is preferred, then manual-review/retry actions.
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
  v_action_id uuid;
begin
  select pa.id into v_action_id
  from public.post_checkout_payment_actions as pa
  join public.post_checkout_applications as pca
    on pca.id = pa.application_id
  where pca.stripe_payment_intent_id = p_payment_intent_id
  order by
    case pa.status
      when 'processing' then 0
      when 'manual_review' then 1
      when 'retry' then 2
      when 'requested' then 3
      else 4
    end,
    pa.updated_at desc
  limit 1;

  if v_action_id is null then
    raise exception 'POST_APPROVAL_PAYMENT_ACTION_NOT_FOUND';
  end if;

  return query
  select reconciled.application_id,reconciled.order_id,reconciled.reservation_id
  from public.skie_reconcile_cancelled_post_checkout_action(
    v_action_id,
    p_reason
  ) as reconciled;
end;
$$;

revoke all on function public.skie_reconcile_cancelled_post_checkout_action(uuid,text)
from public, anon, authenticated;
grant execute on function public.skie_reconcile_cancelled_post_checkout_action(uuid,text)
to service_role;

revoke all on function public.skie_mark_post_checkout_cancelled(text,text)
from public, anon, authenticated;
grant execute on function public.skie_mark_post_checkout_cancelled(text,text)
to service_role;

notify pgrst, 'reload schema';

commit;
