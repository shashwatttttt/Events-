-- Enforce promised review deadlines and Stripe capture-window safety.
-- Cancellation remains idempotent and inventory is released only after Stripe
-- confirms that the card authorisation is no longer capturable.

begin;

create index if not exists post_checkout_review_timeout_idx
  on public.post_checkout_applications(review_due_at)
  where status in ('submitted','under_review') and payment_status = 'authorized';

create index if not exists post_checkout_capture_timeout_idx
  on public.post_checkout_applications(capture_before)
  where status in ('awaiting_form','draft','submitted','under_review')
    and payment_status = 'authorized';

create or replace function public.skie_request_post_checkout_timeout(
  p_application_id uuid,
  p_reason text,
  p_idempotency_key text,
  p_capture_safety_minutes integer default 60
)
returns table(action_id uuid, payment_intent_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_action public.post_checkout_payment_actions%rowtype;
  v_safety_minutes integer;
  v_target_status text;
  v_failure_code text;
begin
  if p_reason not in ('form_expired','review_expired','authorization_expired') then
    raise exception 'POST_APPROVAL_TIMEOUT_REASON_INVALID';
  end if;
  if length(trim(coalesce(p_idempotency_key,''))) < 16 then
    raise exception 'POST_APPROVAL_TIMEOUT_IDEMPOTENCY_INVALID';
  end if;

  v_safety_minutes := greatest(30,least(coalesce(p_capture_safety_minutes,60),24 * 60));

  select pca.* into v_application
  from public.post_checkout_applications as pca
  where pca.id = p_application_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_PAYMENT_NOT_AUTHORIZED';
  end if;
  if v_application.stripe_payment_intent_id is null then
    raise exception 'POST_APPROVAL_PAYMENT_INTENT_MISSING';
  end if;

  if p_reason = 'form_expired' then
    if v_application.status not in ('awaiting_form','draft') then
      raise exception 'POST_APPROVAL_TIMEOUT_NOT_ALLOWED';
    end if;
    if now() < v_application.form_due_at then
      raise exception 'POST_APPROVAL_TIMEOUT_NOT_DUE';
    end if;
    v_target_status := 'form_expired';
    v_failure_code := 'POST_APPROVAL_FORM_DEADLINE_EXPIRED';
  elsif p_reason = 'review_expired' then
    if v_application.status not in ('submitted','under_review')
      or v_application.review_due_at is null then
      raise exception 'POST_APPROVAL_TIMEOUT_NOT_ALLOWED';
    end if;
    if now() < v_application.review_due_at then
      raise exception 'POST_APPROVAL_TIMEOUT_NOT_DUE';
    end if;
    v_target_status := 'rejection_pending';
    v_failure_code := 'POST_APPROVAL_REVIEW_DEADLINE_EXPIRED';
  else
    if v_application.status not in ('awaiting_form','draft','submitted','under_review')
      or v_application.capture_before is null then
      raise exception 'POST_APPROVAL_TIMEOUT_NOT_ALLOWED';
    end if;
    if now() < v_application.capture_before - make_interval(mins => v_safety_minutes) then
      raise exception 'POST_APPROVAL_TIMEOUT_NOT_DUE';
    end if;
    v_target_status := 'authorization_expired';
    v_failure_code := 'POST_APPROVAL_CAPTURE_WINDOW_CLOSING';
  end if;

  insert into public.post_checkout_payment_actions as pa (
    application_id,order_id,stripe_payment_intent_id,action_type,status,
    idempotency_key,available_at,safe_error_code
  ) values (
    v_application.id,v_application.order_id,v_application.stripe_payment_intent_id,
    'cancel','requested',p_idempotency_key,now(),null
  )
  on conflict (application_id,action_type) where action_type = 'cancel'
  do update set
    status = case
      when pa.status = 'processing' and pa.lease_expires_at > now() then 'processing'
      else 'requested'
    end,
    available_at = least(pa.available_at,now()),
    lease_owner = case
      when pa.status = 'processing' and pa.lease_expires_at > now() then pa.lease_owner
      else null
    end,
    lease_expires_at = case
      when pa.status = 'processing' and pa.lease_expires_at > now() then pa.lease_expires_at
      else null
    end,
    safe_error_code = null,
    completed_at = case
      when pa.status = 'processing' and pa.lease_expires_at > now() then pa.completed_at
      else null
    end
  returning pa.* into v_action;

  update public.post_checkout_applications as pca
  set status = v_target_status,
      payment_status = 'cancel_requested',
      next_reminder_at = null,
      failure_code = v_failure_code,
      state_version = pca.state_version + 1
  where pca.id = v_application.id;

  update public.orders as o
  set workflow_status = 'cancellation_pending',
      state_version = o.state_version + 1
  where o.id = v_application.order_id;

  insert into public.post_checkout_audit_events (
    application_id,order_id,action,safe_metadata
  ) values (
    v_application.id,v_application.order_id,
    'post_checkout.' || p_reason,
    jsonb_build_object(
      'reason',p_reason,
      'formDueAt',v_application.form_due_at,
      'reviewDueAt',v_application.review_due_at,
      'captureBefore',v_application.capture_before,
      'captureSafetyMinutes',v_safety_minutes,
      'paymentActionId',v_action.id
    )
  );

  return query select v_action.id,v_action.stripe_payment_intent_id;
end;
$$;

create or replace function public.skie_request_post_checkout_expiry(
  p_application_id uuid,
  p_idempotency_key text
)
returns table(action_id uuid, payment_intent_id text)
language sql
security definer
set search_path = public
as $$
  select timeout_action.action_id,timeout_action.payment_intent_id
  from public.skie_request_post_checkout_timeout(
    p_application_id,
    'form_expired',
    p_idempotency_key,
    60
  ) as timeout_action;
$$;

revoke all on function public.skie_request_post_checkout_timeout(uuid,text,text,integer)
from public, anon, authenticated;
revoke all on function public.skie_request_post_checkout_expiry(uuid,text)
from public, anon, authenticated;

grant execute on function public.skie_request_post_checkout_timeout(uuid,text,text,integer)
to service_role;
grant execute on function public.skie_request_post_checkout_expiry(uuid,text)
to service_role;

commit;
