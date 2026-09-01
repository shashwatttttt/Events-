-- Preserve the first confirmed terminal cancellation result when Stripe and the
-- durable worker report the same cancellation in different orders.

begin;

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
    return query
    select v_application.id,v_application.order_id,v_application.reservation_id;
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

  insert into public.post_checkout_audit_events (
    application_id,order_id,action,safe_metadata
  ) values (
    v_application.id,v_application.order_id,'post_checkout.cancelled',
    jsonb_build_object('reason',v_status)
  );

  return query
  select v_application.id,v_application.order_id,v_application.reservation_id;
end;
$$;

revoke all on function public.skie_mark_post_checkout_cancelled(text,text)
from public, anon, authenticated;
grant execute on function public.skie_mark_post_checkout_cancelled(text,text)
to service_role;

commit;
