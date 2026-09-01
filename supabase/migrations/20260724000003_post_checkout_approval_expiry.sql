-- Atomic automatic expiry for incomplete post-checkout applications.

begin;

create or replace function public.skie_request_post_checkout_expiry(
  p_application_id uuid,
  p_idempotency_key text
)
returns table(action_id uuid, payment_intent_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_action public.post_checkout_payment_actions%rowtype;
begin
  select * into v_application
  from public.post_checkout_applications
  where id = p_application_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.status not in ('awaiting_form','draft') then
    raise exception 'POST_APPROVAL_EXPIRY_NOT_ALLOWED';
  end if;
  if v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_PAYMENT_NOT_AUTHORIZED';
  end if;
  if now() < v_application.form_due_at then
    raise exception 'POST_APPROVAL_FORM_NOT_EXPIRED';
  end if;

  insert into public.post_checkout_payment_actions (
    application_id,order_id,stripe_payment_intent_id,action_type,status,idempotency_key
  ) values (
    v_application.id,v_application.order_id,v_application.stripe_payment_intent_id,
    'cancel','requested',p_idempotency_key
  )
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_action;

  update public.post_checkout_applications
  set status = 'form_expired',
      payment_status = 'cancel_requested',
      next_reminder_at = null,
      state_version = state_version + 1
  where id = v_application.id;

  update public.orders
  set workflow_status = 'cancellation_pending',
      state_version = state_version + 1
  where id = v_application.order_id;

  insert into public.post_checkout_audit_events (
    application_id,order_id,action,safe_metadata
  ) values (
    v_application.id,v_application.order_id,'post_checkout.form_expired',
    jsonb_build_object('formDueAt',v_application.form_due_at)
  );

  return query select v_action.id,v_action.stripe_payment_intent_id;
end;
$$;

revoke all on function public.skie_request_post_checkout_expiry(uuid,text)
from public, anon, authenticated;
grant execute on function public.skie_request_post_checkout_expiry(uuid,text)
to service_role;

commit;
