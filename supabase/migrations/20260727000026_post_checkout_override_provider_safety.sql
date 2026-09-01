-- Tighten the admin override introduced by migration 25.
-- A form-timeout cancellation may be superseded only before any worker or Stripe
-- attempt has begun. Retry/processing/terminal states must be reconciled instead.

begin;

create or replace function public.skie_request_post_checkout_decision(
  p_application_id uuid,
  p_actor_id uuid,
  p_decision text,
  p_internal_reason text,
  p_customer_message text,
  p_idempotency_key text
)
returns table(decision_id uuid, action_id uuid, action_type text, payment_intent_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_decision public.post_checkout_decisions%rowtype;
  v_action public.post_checkout_payment_actions%rowtype;
  v_timeout_action public.post_checkout_payment_actions%rowtype;
  v_action_type text;
  v_timeout_override boolean := false;
begin
  if p_decision not in ('approve','approve_without_form','reject','withdraw') then
    raise exception 'POST_APPROVAL_DECISION_INVALID';
  end if;
  if length(trim(coalesce(p_internal_reason,''))) < 1 then
    raise exception 'POST_APPROVAL_REASON_REQUIRED';
  end if;

  select application.* into v_application
  from public.post_checkout_applications as application
  where application.id = p_application_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;

  -- The scheduled timeout may queue cancellation immediately before an admin
  -- confirms a deliberate exception. It is safe to supersede only a pristine
  -- action that has never been claimed or sent to Stripe.
  if p_decision = 'approve_without_form'
    and v_application.status = 'form_expired'
    and v_application.payment_status = 'cancel_requested' then
    select action.* into v_timeout_action
    from public.post_checkout_payment_actions as action
    where action.application_id = v_application.id
      and action.action_type = 'cancel'
    order by action.created_at desc
    limit 1
    for update;

    if not found
      or v_timeout_action.status <> 'requested'
      or v_timeout_action.attempt_count <> 0
      or v_timeout_action.last_attempt_at is not null then
      raise exception 'POST_APPROVAL_OVERRIDE_NOT_ALLOWED';
    end if;
    v_timeout_override := true;
  elsif v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_PAYMENT_NOT_AUTHORIZED';
  end if;

  if p_decision in ('approve','approve_without_form') then
    if v_application.stripe_payment_intent_id is null then
      raise exception 'POST_APPROVAL_PAYMENT_NOT_AUTHORIZED';
    end if;
    if v_application.capture_before is null then
      raise exception 'POST_APPROVAL_CAPTURE_DEADLINE_MISSING';
    end if;
    if v_application.capture_before <= now() + interval '60 minutes' then
      raise exception 'POST_APPROVAL_AUTHORIZATION_TOO_CLOSE_TO_EXPIRY';
    end if;
  end if;

  if p_decision = 'approve' and v_application.status not in ('submitted','under_review') then
    raise exception 'POST_APPROVAL_FORM_REQUIRED';
  end if;
  if p_decision = 'approve_without_form'
    and not (
      (v_application.status in ('awaiting_form','draft','submitted','under_review')
        and v_application.payment_status = 'authorized')
      or v_timeout_override
    ) then
    raise exception 'POST_APPROVAL_OVERRIDE_NOT_ALLOWED';
  end if;
  if p_decision in ('reject','withdraw')
    and v_application.status not in ('awaiting_form','draft','submitted','under_review','form_expired') then
    raise exception 'POST_APPROVAL_REJECTION_NOT_ALLOWED';
  end if;

  if v_timeout_override then
    update public.post_checkout_payment_actions as action
    set status = 'completed',
        completed_at = now(),
        safe_error_code = 'POST_APPROVAL_TIMEOUT_SUPERSEDED_BY_ADMIN',
        lease_owner = null,
        lease_expires_at = null
    where action.id = v_timeout_action.id
      and action.status = 'requested'
      and action.attempt_count = 0
      and action.last_attempt_at is null;

    if not found then
      raise exception 'POST_APPROVAL_OVERRIDE_NOT_ALLOWED';
    end if;
  end if;

  insert into public.post_checkout_decisions (
    application_id,order_id,decision,internal_reason,customer_message,actor_id,
    application_status_at_decision,payment_status_at_decision,amount_cents,currency,capture_before
  ) values (
    v_application.id,v_application.order_id,p_decision,trim(p_internal_reason),
    nullif(trim(coalesce(p_customer_message,'')),''),p_actor_id,v_application.status,
    v_application.payment_status,coalesce(v_application.authorized_amount_cents,0),
    v_application.currency,v_application.capture_before
  )
  on conflict (application_id) do nothing
  returning * into v_decision;

  if v_decision.id is null then raise exception 'POST_APPROVAL_ALREADY_DECIDED'; end if;

  v_action_type := case
    when p_decision in ('approve','approve_without_form') then 'capture'
    else 'cancel'
  end;

  insert into public.post_checkout_payment_actions (
    application_id,order_id,decision_id,stripe_payment_intent_id,action_type,
    idempotency_key,requested_by
  ) values (
    v_application.id,v_application.order_id,v_decision.id,v_application.stripe_payment_intent_id,
    v_action_type,p_idempotency_key,p_actor_id
  )
  returning * into v_action;

  update public.post_checkout_applications as application
  set status = case when v_action_type = 'capture' then 'capture_pending' else 'rejection_pending' end,
      payment_status = case when v_action_type = 'capture' then 'capture_requested' else 'cancel_requested' end,
      reviewed_at = now(),
      reviewed_by = p_actor_id,
      override_used = p_decision = 'approve_without_form',
      override_reason = case
        when p_decision = 'approve_without_form' then trim(p_internal_reason)
        else application.override_reason
      end,
      next_reminder_at = null,
      failure_code = null,
      state_version = application.state_version + 1
  where application.id = v_application.id;

  update public.orders as orders
  set workflow_status = case
        when v_action_type = 'capture' then 'capture_pending'
        else 'cancellation_pending'
      end,
      state_version = orders.state_version + 1
  where orders.id = v_application.order_id;

  return query select v_decision.id,v_action.id,v_action.action_type,v_action.stripe_payment_intent_id;
end;
$$;

revoke all on function public.skie_request_post_checkout_decision(uuid,uuid,text,text,text,text)
from public, anon, authenticated;
grant execute on function public.skie_request_post_checkout_decision(uuid,uuid,text,text,text,text)
to service_role;

notify pgrst, 'reload schema';
commit;
