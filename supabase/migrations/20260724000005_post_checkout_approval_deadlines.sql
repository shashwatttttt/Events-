-- Harden review holds, capture-deadline checks and rejection availability.

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
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;
  if v_order.checkout_mode <> 'post_checkout_approval' then raise exception 'POST_APPROVAL_MODE_MISMATCH'; end if;
  if p_amount_cents <> v_order.total_cents or upper(p_currency) <> upper(v_order.currency) then
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

  update public.post_checkout_applications
  set stripe_checkout_session_id = coalesce(stripe_checkout_session_id,p_stripe_session_id),
      stripe_payment_intent_id = p_payment_intent_id,
      authorized_amount_cents = p_amount_cents,
      capturable_amount_cents = p_capturable_cents,
      currency = upper(p_currency),
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
  where id = v_application.id
  returning * into v_application;

  update public.checkout_attempts
  set stripe_checkout_session_id = coalesce(stripe_checkout_session_id,p_stripe_session_id),
      stripe_payment_intent_id = p_payment_intent_id,
      status = 'session_active'
  where id = v_application.checkout_attempt_id;

  update public.reservations
  set status = 'session_active',
      expires_at = greatest(expires_at, v_application.form_due_at)
  where id = v_application.reservation_id
    and status in ('reserved','session_active');

  update public.orders
  set status = 'checkout_pending',
      workflow_status = case
        when workflow_status in ('checkout_created','authorization_pending') then 'awaiting_form'
        else workflow_status
      end,
      state_version = state_version + 1
  where id = p_order_id;

  return query select v_application.id, v_duplicate;
end;
$$;

create or replace function public.skie_submit_post_checkout_application(
  p_order_id uuid,
  p_customer_id uuid,
  p_answers jsonb,
  p_completion_percentage integer,
  p_expected_state_version integer,
  p_review_due_at timestamptz
)
returns table(application_id uuid, state_version integer, submitted_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
begin
  if jsonb_typeof(p_answers) <> 'object' then raise exception 'POST_APPROVAL_ANSWERS_INVALID'; end if;
  if p_review_due_at <= now() then raise exception 'POST_APPROVAL_REVIEW_DEADLINE_INVALID'; end if;

  select * into v_application
  from public.post_checkout_applications
  where order_id = p_order_id and customer_id = p_customer_id
  for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.state_version <> p_expected_state_version then raise exception 'POST_APPROVAL_STALE_VERSION'; end if;
  if v_application.status not in ('awaiting_form','draft') or v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_FORM_NOT_SUBMITTABLE';
  end if;
  if now() >= v_application.form_due_at then raise exception 'POST_APPROVAL_FORM_EXPIRED'; end if;
  if v_application.capture_before is not null
    and p_review_due_at >= v_application.capture_before - interval '60 minutes' then
    raise exception 'POST_APPROVAL_REVIEW_DEADLINE_TOO_LATE';
  end if;

  update public.post_checkout_applications
  set draft_answers = p_answers,
      submitted_answers = p_answers,
      completion_percentage = greatest(0,least(100,p_completion_percentage)),
      status = 'submitted',
      submitted_at = now(),
      review_due_at = p_review_due_at,
      next_reminder_at = null,
      last_activity_at = now(),
      state_version = state_version + 1
  where id = v_application.id
  returning * into v_application;

  update public.reservations
  set expires_at = greatest(expires_at,p_review_due_at)
  where id = v_application.reservation_id
    and status in ('session_active','reserved');

  update public.orders
  set workflow_status = 'under_review',
      state_version = state_version + 1
  where id = p_order_id;

  return query select v_application.id,v_application.state_version,v_application.submitted_at;
end;
$$;

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
  v_action_type text;
begin
  if p_decision not in ('approve','approve_without_form','reject','withdraw') then
    raise exception 'POST_APPROVAL_DECISION_INVALID';
  end if;
  if length(trim(coalesce(p_internal_reason,''))) < 1 then
    raise exception 'POST_APPROVAL_REASON_REQUIRED';
  end if;

  select * into v_application
  from public.post_checkout_applications
  where id = p_application_id
  for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_PAYMENT_NOT_AUTHORIZED';
  end if;

  if p_decision in ('approve','approve_without_form') then
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
    and v_application.status not in ('awaiting_form','draft','submitted','under_review') then
    raise exception 'POST_APPROVAL_OVERRIDE_NOT_ALLOWED';
  end if;
  if p_decision in ('reject','withdraw')
    and v_application.status not in ('awaiting_form','draft','submitted','under_review','form_expired') then
    raise exception 'POST_APPROVAL_REJECTION_NOT_ALLOWED';
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

  update public.post_checkout_applications
  set status = case when v_action_type = 'capture' then 'capture_pending' else 'rejection_pending' end,
      payment_status = case when v_action_type = 'capture' then 'capture_requested' else 'cancel_requested' end,
      reviewed_at = now(),
      reviewed_by = p_actor_id,
      override_used = p_decision = 'approve_without_form',
      override_reason = case
        when p_decision = 'approve_without_form' then trim(p_internal_reason)
        else override_reason
      end,
      next_reminder_at = null,
      state_version = state_version + 1
  where id = v_application.id;

  update public.orders
  set workflow_status = case
        when v_action_type = 'capture' then 'capture_pending'
        else 'cancellation_pending'
      end,
      state_version = state_version + 1
  where id = v_application.order_id;

  return query select v_decision.id,v_action.id,v_action.action_type,v_action.stripe_payment_intent_id;
end;
$$;

revoke all on function public.skie_record_post_checkout_authorization(uuid,text,text,integer,integer,text,timestamptz)
from public, anon, authenticated;
revoke all on function public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)
from public, anon, authenticated;
revoke all on function public.skie_request_post_checkout_decision(uuid,uuid,text,text,text,text)
from public, anon, authenticated;

grant execute on function public.skie_record_post_checkout_authorization(uuid,text,text,integer,integer,text,timestamptz)
to service_role;
grant execute on function public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)
to service_role;
grant execute on function public.skie_request_post_checkout_decision(uuid,uuid,text,text,text,text)
to service_role;

commit;
