-- Resolve PL/pgSQL output-column ambiguity reported by `supabase db lint`.
-- Forward-only: staging has already applied migrations 00000 through 00009.

begin;

create or replace function public.skie_prepare_post_checkout_application(
  p_order_id uuid,
  p_form_id text,
  p_form_version integer,
  p_form_snapshot jsonb,
  p_consent_snapshot jsonb,
  p_form_due_at timestamptz
)
returns table(application_id uuid, state_version integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_reservation public.reservations%rowtype;
  v_attempt public.checkout_attempts%rowtype;
  v_application public.post_checkout_applications%rowtype;
begin
  if p_form_due_at <= now() then raise exception 'POST_APPROVAL_FORM_DEADLINE_INVALID'; end if;
  if jsonb_typeof(p_form_snapshot) <> 'object' then raise exception 'POST_APPROVAL_FORM_SNAPSHOT_INVALID'; end if;

  select o.* into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;
  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;
  if v_order.status not in ('reserved','checkout_pending') then raise exception 'POST_APPROVAL_ORDER_NOT_PREPARABLE'; end if;

  select r.* into v_reservation
  from public.reservations as r
  where r.id = v_order.reservation_id
  for update;

  select ca.* into v_attempt
  from public.checkout_attempts as ca
  where ca.order_id = v_order.id
  for update;

  if v_reservation.id is null or v_attempt.id is null then
    raise exception 'POST_APPROVAL_TRANSACTION_INCOMPLETE';
  end if;

  insert into public.post_checkout_applications as pca (
    order_id,reservation_id,checkout_attempt_id,customer_id,event_id,form_id,form_version,
    form_snapshot,consent_snapshot,form_due_at,status,payment_status
  ) values (
    v_order.id,v_reservation.id,v_attempt.id,v_order.customer_id,v_order.event_id,p_form_id,
    greatest(1,p_form_version),p_form_snapshot,coalesce(p_consent_snapshot,'{}'::jsonb),
    p_form_due_at,'awaiting_authorization','authorization_pending'
  )
  on conflict (order_id) do update set
    form_id = excluded.form_id,
    form_version = excluded.form_version,
    form_snapshot = excluded.form_snapshot,
    consent_snapshot = excluded.consent_snapshot,
    form_due_at = excluded.form_due_at,
    state_version = pca.state_version + 1
  where pca.status = 'awaiting_authorization'
  returning pca.* into v_application;

  if v_application.id is null then
    select pca.* into v_application
    from public.post_checkout_applications as pca
    where pca.order_id = v_order.id;
  end if;

  update public.orders as o
  set checkout_mode = 'post_checkout_approval',
      workflow_status = 'checkout_created',
      state_version = o.state_version + 1
  where o.id = v_order.id;

  return query select v_application.id, v_application.state_version;
end;
$$;

create or replace function public.skie_save_post_checkout_draft(
  p_order_id uuid,
  p_customer_id uuid,
  p_answers jsonb,
  p_completion_percentage integer,
  p_expected_state_version integer
)
returns table(application_id uuid, state_version integer, saved_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
begin
  if jsonb_typeof(p_answers) <> 'object' then raise exception 'POST_APPROVAL_ANSWERS_INVALID'; end if;

  select pca.* into v_application
  from public.post_checkout_applications as pca
  where pca.order_id = p_order_id
    and pca.customer_id = p_customer_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.state_version <> p_expected_state_version then raise exception 'POST_APPROVAL_STALE_VERSION'; end if;
  if v_application.status not in ('awaiting_form','draft') or v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_FORM_NOT_EDITABLE';
  end if;
  if now() >= v_application.form_due_at then raise exception 'POST_APPROVAL_FORM_EXPIRED'; end if;

  update public.post_checkout_applications as pca
  set draft_answers = p_answers,
      completion_percentage = greatest(0,least(100,p_completion_percentage)),
      status = 'draft',
      last_activity_at = now(),
      state_version = pca.state_version + 1
  where pca.id = v_application.id
  returning pca.* into v_application;

  update public.orders as o
  set workflow_status = 'form_draft',
      state_version = o.state_version + 1
  where o.id = p_order_id
    and o.workflow_status in ('awaiting_form','form_draft');

  return query select v_application.id, v_application.state_version, v_application.updated_at;
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

  select pca.* into v_application
  from public.post_checkout_applications as pca
  where pca.order_id = p_order_id
    and pca.customer_id = p_customer_id
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

  update public.post_checkout_applications as pca
  set draft_answers = p_answers,
      submitted_answers = p_answers,
      completion_percentage = greatest(0,least(100,p_completion_percentage)),
      status = 'submitted',
      submitted_at = now(),
      review_due_at = p_review_due_at,
      next_reminder_at = null,
      last_activity_at = now(),
      state_version = pca.state_version + 1
  where pca.id = v_application.id
  returning pca.* into v_application;

  update public.reservations as r
  set expires_at = greatest(r.expires_at,p_review_due_at)
  where r.id = v_application.reservation_id
    and r.status in ('session_active','reserved');

  update public.orders as o
  set workflow_status = 'under_review',
      state_version = o.state_version + 1
  where o.id = p_order_id;

  return query select v_application.id,v_application.state_version,v_application.submitted_at;
end;
$$;

create or replace function public.skie_mark_post_checkout_capture_confirmed(
  p_payment_intent_id text,
  p_amount_cents integer
)
returns table(application_id uuid, order_id uuid, reservation_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_decision public.post_checkout_decisions%rowtype;
begin
  select pca.* into v_application
  from public.post_checkout_applications as pca
  where pca.stripe_payment_intent_id = p_payment_intent_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if p_amount_cents <> v_application.authorized_amount_cents then raise exception 'PAYMENT_AMOUNT_MISMATCH'; end if;

  select pcd.* into v_decision
  from public.post_checkout_decisions as pcd
  where pcd.application_id = v_application.id;

  if v_decision.id is null or v_decision.decision not in ('approve','approve_without_form') then
    raise exception 'POST_APPROVAL_CAPTURE_WITHOUT_APPROVAL';
  end if;

  update public.post_checkout_applications as pca
  set status = case when v_decision.decision = 'approve_without_form' then 'approved_override' else 'approved' end,
      payment_status = 'captured',
      capturable_amount_cents = 0,
      state_version = pca.state_version + 1,
      failure_code = null
  where pca.id = v_application.id;

  update public.post_checkout_payment_actions as pa
  set status = 'completed',
      completed_at = now(),
      safe_error_code = null
  where pa.application_id = v_application.id
    and pa.action_type = 'capture'
    and pa.status <> 'completed';

  update public.orders as o
  set workflow_status = 'captured_pending_fulfilment',
      state_version = o.state_version + 1
  where o.id = v_application.order_id;

  return query select v_application.id,v_application.order_id,v_application.reservation_id;
end;
$$;

create or replace function public.skie_mark_post_checkout_fulfilled(
  p_order_id uuid
)
returns table(application_id uuid, order_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_order public.orders%rowtype;
  v_duplicate boolean := false;
  v_valid_ticket_count integer;
begin
  select o.* into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;
  if v_order.checkout_mode <> 'post_checkout_approval' then raise exception 'POST_APPROVAL_MODE_MISMATCH'; end if;
  if v_order.status <> 'fulfilled' then raise exception 'POST_APPROVAL_ORDER_NOT_FULFILLED'; end if;

  select pca.* into v_application
  from public.post_checkout_applications as pca
  where pca.order_id = p_order_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status <> 'captured' then raise exception 'POST_APPROVAL_PAYMENT_NOT_CAPTURED'; end if;
  if v_application.status not in ('approved','approved_override') then
    raise exception 'POST_APPROVAL_APPLICATION_NOT_APPROVED';
  end if;

  select count(*) into v_valid_ticket_count
  from public.tickets as t
  where t.order_id = p_order_id
    and t.status = 'valid';

  if v_valid_ticket_count < 1 then raise exception 'POST_APPROVAL_NO_VALID_TICKETS'; end if;

  if v_order.workflow_status = 'fulfilled' then
    v_duplicate := true;
  else
    update public.orders as o
    set workflow_status = 'fulfilled',
        state_version = o.state_version + 1
    where o.id = p_order_id;

    insert into public.post_checkout_audit_events (
      application_id,order_id,action,safe_metadata
    ) values (
      v_application.id,p_order_id,'post_checkout.fulfilled',
      jsonb_build_object('validTicketCount',v_valid_ticket_count)
    );
  end if;

  return query select v_application.id,p_order_id,v_duplicate;
end;
$$;

create or replace function public.skie_extend_post_checkout_form_deadline(
  p_application_id uuid,
  p_actor_id uuid,
  p_form_due_at timestamptz
)
returns table(application_id uuid, form_due_at timestamptz, state_version integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
begin
  select pca.* into v_application
  from public.post_checkout_applications as pca
  where pca.id = p_application_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.status not in ('awaiting_form','draft')
    or v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_DEADLINE_NOT_EXTENDABLE';
  end if;
  if p_form_due_at <= now() then raise exception 'POST_APPROVAL_FORM_DEADLINE_INVALID'; end if;
  if v_application.capture_before is not null
    and p_form_due_at >= v_application.capture_before - interval '60 minutes' then
    raise exception 'POST_APPROVAL_FORM_DEADLINE_TOO_LATE';
  end if;

  update public.post_checkout_applications as pca
  set form_due_at = p_form_due_at,
      next_reminder_at = least(p_form_due_at,now() + interval '10 minutes'),
      state_version = pca.state_version + 1
  where pca.id = v_application.id
  returning pca.* into v_application;

  update public.reservations as r
  set expires_at = greatest(r.expires_at,p_form_due_at)
  where r.id = v_application.reservation_id
    and r.status = 'session_active';

  if not found then raise exception 'POST_APPROVAL_RESERVATION_NOT_ACTIVE'; end if;

  insert into public.post_checkout_audit_events (
    application_id,order_id,actor_id,action,safe_metadata
  ) values (
    v_application.id,v_application.order_id,p_actor_id,
    'post_checkout.form_deadline_extended',
    jsonb_build_object('formDueAt',p_form_due_at)
  );

  return query select v_application.id,v_application.form_due_at,v_application.state_version;
end;
$$;

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
  select pca.* into v_application
  from public.post_checkout_applications as pca
  where pca.stripe_payment_intent_id = p_payment_intent_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status = 'captured' then raise exception 'POST_APPROVAL_ALREADY_CAPTURED'; end if;

  if v_application.payment_status in ('cancelled','expired')
    and v_application.status in ('rejected','form_expired','authorization_expired','withdrawn') then
    return query select v_application.id,v_application.order_id,v_application.reservation_id;
    return;
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
  where pca.id = v_application.id
  returning pca.* into v_application;

  update public.post_checkout_payment_actions as pa
  set status = 'completed',
      completed_at = now(),
      safe_error_code = null,
      lease_owner = null,
      lease_expires_at = null
  where pa.application_id = v_application.id
    and pa.action_type = 'cancel'
    and pa.status <> 'completed';

  update public.orders as o
  set status = 'cancelled',
      workflow_status = case
        when v_status = 'form_expired' then 'form_expired'
        when v_status = 'authorization_expired' then 'authorization_expired'
        else 'rejected'
      end,
      state_version = o.state_version + 1
  where o.id = v_application.order_id;

  update public.reservations as r
  set status = 'cancelled'
  where r.id = v_application.reservation_id
    and r.status not in ('fulfilled','refunded','partially_refunded');

  update public.checkout_attempts as ca
  set status = 'session_expired'
  where ca.id = v_application.checkout_attempt_id
    and ca.status <> 'fulfilled';

  insert into public.post_checkout_audit_events (
    application_id,order_id,action,safe_metadata
  ) values (
    v_application.id,v_application.order_id,'post_checkout.cancelled',
    jsonb_build_object('reason',v_status)
  );

  return query select v_application.id,v_application.order_id,v_application.reservation_id;
end;
$$;

create or replace function public.skie_retry_post_checkout_payment_action(
  p_application_id uuid,
  p_actor_id uuid
)
returns table(action_id uuid, action_type text, status text, attempt_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_action public.post_checkout_payment_actions%rowtype;
begin
  select pca.* into v_application
  from public.post_checkout_applications as pca
  where pca.id = p_application_id
  for update;

  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;

  select pa.* into v_action
  from public.post_checkout_payment_actions as pa
  where pa.application_id = p_application_id
    and pa.action_type in ('capture','cancel')
  order by pa.created_at desc
  limit 1
  for update;

  if not found then raise exception 'POST_APPROVAL_PAYMENT_ACTION_NOT_FOUND'; end if;
  if v_action.status not in ('retry','failed','manual_review')
    and not (v_action.status = 'processing' and v_action.lease_expires_at <= now()) then
    raise exception 'POST_APPROVAL_PAYMENT_ACTION_NOT_RETRYABLE';
  end if;

  update public.post_checkout_payment_actions as pa
  set status = 'retry',
      available_at = now(),
      lease_owner = null,
      lease_expires_at = null,
      safe_error_code = null,
      completed_at = null
  where pa.id = v_action.id
  returning pa.* into v_action;

  insert into public.post_checkout_audit_events (
    application_id,order_id,actor_id,action,safe_metadata
  ) values (
    v_application.id,v_application.order_id,p_actor_id,
    'post_checkout.payment_action_retried',
    jsonb_build_object(
      'paymentActionId',v_action.id,
      'actionType',v_action.action_type,
      'attemptCount',v_action.attempt_count
    )
  );

  return query select v_action.id,v_action.action_type,v_action.status,v_action.attempt_count;
end;
$$;

revoke all on function public.skie_prepare_post_checkout_application(uuid,text,integer,jsonb,jsonb,timestamptz)
from public, anon, authenticated;
revoke all on function public.skie_save_post_checkout_draft(uuid,uuid,jsonb,integer,integer)
from public, anon, authenticated;
revoke all on function public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)
from public, anon, authenticated;
revoke all on function public.skie_mark_post_checkout_capture_confirmed(text,integer)
from public, anon, authenticated;
revoke all on function public.skie_mark_post_checkout_fulfilled(uuid)
from public, anon, authenticated;
revoke all on function public.skie_extend_post_checkout_form_deadline(uuid,uuid,timestamptz)
from public, anon, authenticated;
revoke all on function public.skie_mark_post_checkout_cancelled(text,text)
from public, anon, authenticated;
revoke all on function public.skie_retry_post_checkout_payment_action(uuid,uuid)
from public, anon, authenticated;

grant execute on function public.skie_prepare_post_checkout_application(uuid,text,integer,jsonb,jsonb,timestamptz)
to service_role;
grant execute on function public.skie_save_post_checkout_draft(uuid,uuid,jsonb,integer,integer)
to service_role;
grant execute on function public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)
to service_role;
grant execute on function public.skie_mark_post_checkout_capture_confirmed(text,integer)
to service_role;
grant execute on function public.skie_mark_post_checkout_fulfilled(uuid)
to service_role;
grant execute on function public.skie_extend_post_checkout_form_deadline(uuid,uuid,timestamptz)
to service_role;
grant execute on function public.skie_mark_post_checkout_cancelled(text,text)
to service_role;
grant execute on function public.skie_retry_post_checkout_payment_action(uuid,uuid)
to service_role;

commit;
