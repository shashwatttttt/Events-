-- Repair production post-checkout authorization reconciliation.
-- Stripe returns ISO currencies in lowercase, while SKIE stores normalized uppercase currencies.

begin;

create or replace function public.skie_record_post_checkout_authorization(
  p_order_id uuid,
  p_stripe_session_id text,
  p_payment_intent_id text,
  p_amount_cents integer,
  p_capturable_cents integer,
  p_currency text,
  p_capture_before timestamptz
)
returns table(application_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_application public.post_checkout_applications%rowtype;
  v_duplicate boolean := false;
  v_currency text := upper(trim(coalesce(p_currency,'')));
begin
  if v_currency !~ '^[A-Z]{3}$' then
    raise exception 'POST_APPROVAL_CURRENCY_INVALID';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;
  if v_order.checkout_mode <> 'post_checkout_approval' then
    raise exception 'POST_APPROVAL_MODE_MISMATCH';
  end if;
  if p_amount_cents <> v_order.total_cents or v_currency <> upper(v_order.currency) then
    raise exception 'PAYMENT_AMOUNT_MISMATCH';
  end if;
  if p_capturable_cents < 0 or p_capturable_cents > p_amount_cents then
    raise exception 'PAYMENT_AMOUNT_MISMATCH';
  end if;

  select * into v_application
    from public.post_checkout_applications
    where order_id = p_order_id
    for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;

  if v_application.stripe_payment_intent_id is not null then
    if v_application.stripe_payment_intent_id <> p_payment_intent_id then
      raise exception 'PAYMENT_INTENT_MISMATCH';
    end if;
    v_duplicate := true;
  end if;

  update public.post_checkout_applications set
    stripe_checkout_session_id = coalesce(stripe_checkout_session_id,p_stripe_session_id),
    stripe_payment_intent_id = p_payment_intent_id,
    authorized_amount_cents = p_amount_cents,
    capturable_amount_cents = p_capturable_cents,
    currency = v_currency,
    capture_before = p_capture_before,
    status = case when status = 'awaiting_authorization' then 'awaiting_form' else status end,
    payment_status = 'authorized',
    next_reminder_at = case
      when status in ('awaiting_authorization','awaiting_form','draft')
        then least(form_due_at, now() + interval '10 minutes')
      else next_reminder_at
    end,
    last_activity_at = now(),
    state_version = state_version + 1,
    failure_code = null
  where id = v_application.id;

  update public.checkout_attempts set
    stripe_checkout_session_id = coalesce(stripe_checkout_session_id,p_stripe_session_id),
    stripe_payment_intent_id = p_payment_intent_id,
    status = 'session_active'
  where id = v_application.checkout_attempt_id;

  update public.reservations set status = 'session_active'
  where id = v_application.reservation_id
    and status in ('reserved','session_active');

  update public.orders set
    status = 'checkout_pending',
    workflow_status = case
      when workflow_status in ('checkout_created','authorization_pending') then 'awaiting_form'
      else workflow_status
    end,
    state_version = state_version + 1
  where id = p_order_id;

  return query select v_application.id, v_duplicate;
end;
$$;

revoke all on function public.skie_record_post_checkout_authorization(
  uuid,text,text,integer,integer,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.skie_record_post_checkout_authorization(
  uuid,text,text,integer,integer,text,timestamptz
) to service_role;

commit;
