-- SKIE EVENTS post-checkout approval foundation.
-- Additive only. Apply to isolated staging before production.

begin;

create extension if not exists pgcrypto;

alter table public.orders
  add column if not exists checkout_mode text not null default 'standard',
  add column if not exists workflow_status text not null default 'standard',
  add column if not exists state_version integer not null default 1;

alter table public.orders
  drop constraint if exists orders_checkout_mode_check;
alter table public.orders
  add constraint orders_checkout_mode_check
  check (checkout_mode in ('standard','post_checkout_approval'));

alter table public.orders
  drop constraint if exists orders_workflow_status_check;
alter table public.orders
  add constraint orders_workflow_status_check
  check (workflow_status in (
    'standard','checkout_created','authorization_pending','awaiting_form','form_draft',
    'under_review','capture_pending','captured_pending_fulfilment','fulfilled',
    'cancellation_pending','rejected','form_expired','authorization_expired',
    'payment_failed','manual_review'
  ));

create table if not exists public.post_checkout_applications (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete restrict,
  reservation_id uuid not null unique references public.reservations(id) on delete restrict,
  checkout_attempt_id uuid not null unique references public.checkout_attempts(id) on delete restrict,
  customer_id uuid not null references public.profiles(id) on delete restrict,
  event_id text not null check (length(event_id) between 1 and 120),
  form_id text not null check (length(form_id) between 1 and 120),
  form_version integer not null default 1 check (form_version > 0),
  form_snapshot jsonb not null check (jsonb_typeof(form_snapshot) = 'object'),
  draft_answers jsonb not null default '{}'::jsonb check (jsonb_typeof(draft_answers) = 'object'),
  submitted_answers jsonb check (submitted_answers is null or jsonb_typeof(submitted_answers) = 'object'),
  consent_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(consent_snapshot) = 'object'),
  status text not null default 'awaiting_authorization' check (status in (
    'awaiting_authorization','awaiting_form','draft','submitted','under_review',
    'capture_pending','approved','approved_override','rejection_pending','rejected',
    'form_expired','authorization_expired','withdrawn','manual_review'
  )),
  payment_status text not null default 'authorization_pending' check (payment_status in (
    'authorization_pending','authorized','capture_requested','captured',
    'cancel_requested','cancelled','expired','failed','reconciliation_required'
  )),
  completion_percentage integer not null default 0 check (completion_percentage between 0 and 100),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  authorized_amount_cents integer check (authorized_amount_cents is null or authorized_amount_cents >= 0),
  capturable_amount_cents integer check (capturable_amount_cents is null or capturable_amount_cents >= 0),
  currency text not null default 'AUD' check (currency ~ '^[A-Z]{3}$'),
  form_due_at timestamptz not null,
  review_due_at timestamptz,
  capture_before timestamptz,
  next_reminder_at timestamptz,
  reminder_count integer not null default 0 check (reminder_count between 0 and 20),
  last_reminder_at timestamptz,
  last_activity_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete restrict,
  override_used boolean not null default false,
  override_reason text,
  failure_code text,
  state_version integer not null default 1 check (state_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (capturable_amount_cents is null or authorized_amount_cents is null or capturable_amount_cents <= authorized_amount_cents),
  check (form_due_at > created_at)
);

create index if not exists post_checkout_applications_customer_idx
  on public.post_checkout_applications(customer_id, created_at desc);
create index if not exists post_checkout_applications_review_idx
  on public.post_checkout_applications(status, capture_before, updated_at desc);
create index if not exists post_checkout_applications_reminder_idx
  on public.post_checkout_applications(next_reminder_at)
  where status in ('awaiting_form','draft') and payment_status = 'authorized';

create table if not exists public.post_checkout_decisions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references public.post_checkout_applications(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  decision text not null check (decision in ('approve','approve_without_form','reject','withdraw')),
  internal_reason text not null check (length(internal_reason) between 1 and 3000),
  customer_message text,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  application_status_at_decision text not null,
  payment_status_at_decision text not null,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  capture_before timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.post_checkout_payment_actions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.post_checkout_applications(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  decision_id uuid references public.post_checkout_decisions(id) on delete restrict,
  stripe_payment_intent_id text not null,
  action_type text not null check (action_type in ('capture','cancel','reconcile')),
  status text not null default 'requested' check (status in (
    'requested','processing','completed','retry','failed','manual_review'
  )),
  idempotency_key text not null unique check (length(idempotency_key) between 16 and 240),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  safe_error_code text,
  requested_by uuid references public.profiles(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists post_checkout_payment_actions_queue_idx
  on public.post_checkout_payment_actions(status, available_at, created_at)
  where status in ('requested','retry');

create or replace trigger post_checkout_applications_touch_updated_at
before update on public.post_checkout_applications
for each row execute function public.skie_touch_updated_at();

create or replace trigger post_checkout_payment_actions_touch_updated_at
before update on public.post_checkout_payment_actions
for each row execute function public.skie_touch_updated_at();

alter table public.post_checkout_applications enable row level security;
alter table public.post_checkout_decisions enable row level security;
alter table public.post_checkout_payment_actions enable row level security;

-- These tables are accessed only by trusted server routes through the service role.
revoke all on public.post_checkout_applications from anon, authenticated;
revoke all on public.post_checkout_decisions from anon, authenticated;
revoke all on public.post_checkout_payment_actions from anon, authenticated;

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

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;
  if v_order.status not in ('reserved','checkout_pending') then raise exception 'POST_APPROVAL_ORDER_NOT_PREPARABLE'; end if;

  select * into v_reservation from public.reservations where id = v_order.reservation_id for update;
  select * into v_attempt from public.checkout_attempts where order_id = v_order.id for update;
  if v_reservation.id is null or v_attempt.id is null then raise exception 'POST_APPROVAL_TRANSACTION_INCOMPLETE'; end if;

  insert into public.post_checkout_applications (
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
    state_version = public.post_checkout_applications.state_version + 1
  where public.post_checkout_applications.status = 'awaiting_authorization'
  returning * into v_application;

  if v_application.id is null then
    select * into v_application from public.post_checkout_applications where order_id = v_order.id;
  end if;

  update public.orders set
    checkout_mode = 'post_checkout_approval',
    workflow_status = 'checkout_created',
    state_version = state_version + 1
  where id = v_order.id;

  return query select v_application.id, v_application.state_version;
end;
$$;

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
  if p_capturable_cents < 0 or p_capturable_cents > p_amount_cents then raise exception 'PAYMENT_AMOUNT_MISMATCH'; end if;

  select * into v_application from public.post_checkout_applications where order_id = p_order_id for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;

  if v_application.stripe_payment_intent_id is not null then
    if v_application.stripe_payment_intent_id <> p_payment_intent_id then raise exception 'PAYMENT_INTENT_MISMATCH'; end if;
    v_duplicate := true;
  end if;

  update public.post_checkout_applications set
    stripe_checkout_session_id = coalesce(stripe_checkout_session_id,p_stripe_session_id),
    stripe_payment_intent_id = p_payment_intent_id,
    authorized_amount_cents = p_amount_cents,
    capturable_amount_cents = p_capturable_cents,
    currency = upper(p_currency),
    capture_before = p_capture_before,
    status = case when status = 'awaiting_authorization' then 'awaiting_form' else status end,
    payment_status = 'authorized',
    next_reminder_at = case when status in ('awaiting_authorization','awaiting_form','draft') then least(form_due_at, now() + interval '10 minutes') else next_reminder_at end,
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
  where id = v_application.reservation_id and status in ('reserved','session_active');

  update public.orders set
    status = 'checkout_pending',
    workflow_status = case when workflow_status in ('checkout_created','authorization_pending') then 'awaiting_form' else workflow_status end,
    state_version = state_version + 1
  where id = p_order_id;

  return query select v_application.id, v_duplicate;
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
  select * into v_application from public.post_checkout_applications
    where order_id = p_order_id and customer_id = p_customer_id for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.state_version <> p_expected_state_version then raise exception 'POST_APPROVAL_STALE_VERSION'; end if;
  if v_application.status not in ('awaiting_form','draft') or v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_FORM_NOT_EDITABLE';
  end if;
  if now() >= v_application.form_due_at then raise exception 'POST_APPROVAL_FORM_EXPIRED'; end if;

  update public.post_checkout_applications set
    draft_answers = p_answers,
    completion_percentage = greatest(0,least(100,p_completion_percentage)),
    status = 'draft',
    last_activity_at = now(),
    state_version = state_version + 1
  where id = v_application.id
  returning * into v_application;

  update public.orders set workflow_status = 'form_draft', state_version = state_version + 1
  where id = p_order_id and workflow_status in ('awaiting_form','form_draft');

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
  select * into v_application from public.post_checkout_applications
    where order_id = p_order_id and customer_id = p_customer_id for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.state_version <> p_expected_state_version then raise exception 'POST_APPROVAL_STALE_VERSION'; end if;
  if v_application.status not in ('awaiting_form','draft') or v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_FORM_NOT_SUBMITTABLE';
  end if;
  if now() >= v_application.form_due_at then raise exception 'POST_APPROVAL_FORM_EXPIRED'; end if;

  update public.post_checkout_applications set
    draft_answers = p_answers,
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

  update public.orders set workflow_status = 'under_review', state_version = state_version + 1
  where id = p_order_id;

  return query select v_application.id, v_application.state_version, v_application.submitted_at;
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
  if p_decision not in ('approve','approve_without_form','reject','withdraw') then raise exception 'POST_APPROVAL_DECISION_INVALID'; end if;
  if length(trim(coalesce(p_internal_reason,''))) < 1 then raise exception 'POST_APPROVAL_REASON_REQUIRED'; end if;

  select * into v_application from public.post_checkout_applications where id = p_application_id for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status <> 'authorized' then raise exception 'POST_APPROVAL_PAYMENT_NOT_AUTHORIZED'; end if;
  if v_application.capture_before is not null and v_application.capture_before <= now() + interval '60 minutes' then
    raise exception 'POST_APPROVAL_AUTHORIZATION_TOO_CLOSE_TO_EXPIRY';
  end if;
  if p_decision = 'approve' and v_application.status not in ('submitted','under_review') then
    raise exception 'POST_APPROVAL_FORM_REQUIRED';
  end if;
  if p_decision = 'approve_without_form' and v_application.status not in ('awaiting_form','draft','submitted','under_review') then
    raise exception 'POST_APPROVAL_OVERRIDE_NOT_ALLOWED';
  end if;

  insert into public.post_checkout_decisions (
    application_id,order_id,decision,internal_reason,customer_message,actor_id,
    application_status_at_decision,payment_status_at_decision,amount_cents,currency,capture_before
  ) values (
    v_application.id,v_application.order_id,p_decision,trim(p_internal_reason),nullif(trim(coalesce(p_customer_message,'')),''),
    p_actor_id,v_application.status,v_application.payment_status,coalesce(v_application.authorized_amount_cents,0),
    v_application.currency,v_application.capture_before
  )
  on conflict (application_id) do nothing
  returning * into v_decision;

  if v_decision.id is null then raise exception 'POST_APPROVAL_ALREADY_DECIDED'; end if;

  v_action_type := case when p_decision in ('approve','approve_without_form') then 'capture' else 'cancel' end;

  insert into public.post_checkout_payment_actions (
    application_id,order_id,decision_id,stripe_payment_intent_id,action_type,idempotency_key,requested_by
  ) values (
    v_application.id,v_application.order_id,v_decision.id,v_application.stripe_payment_intent_id,
    v_action_type,p_idempotency_key,p_actor_id
  ) returning * into v_action;

  update public.post_checkout_applications set
    status = case when v_action_type = 'capture' then 'capture_pending' else 'rejection_pending' end,
    payment_status = case when v_action_type = 'capture' then 'capture_requested' else 'cancel_requested' end,
    reviewed_at = now(),
    reviewed_by = p_actor_id,
    override_used = p_decision = 'approve_without_form',
    override_reason = case when p_decision = 'approve_without_form' then trim(p_internal_reason) else override_reason end,
    state_version = state_version + 1
  where id = v_application.id;

  update public.orders set
    workflow_status = case when v_action_type = 'capture' then 'capture_pending' else 'cancellation_pending' end,
    state_version = state_version + 1
  where id = v_application.order_id;

  return query select v_decision.id,v_action.id,v_action.action_type,v_action.stripe_payment_intent_id;
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
  select * into v_application from public.post_checkout_applications
    where stripe_payment_intent_id = p_payment_intent_id for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if p_amount_cents <> v_application.authorized_amount_cents then raise exception 'PAYMENT_AMOUNT_MISMATCH'; end if;
  select * into v_decision from public.post_checkout_decisions where application_id = v_application.id;
  if v_decision.id is null or v_decision.decision not in ('approve','approve_without_form') then
    raise exception 'POST_APPROVAL_CAPTURE_WITHOUT_APPROVAL';
  end if;

  update public.post_checkout_applications set
    status = case when v_decision.decision = 'approve_without_form' then 'approved_override' else 'approved' end,
    payment_status = 'captured',
    capturable_amount_cents = 0,
    state_version = state_version + 1,
    failure_code = null
  where id = v_application.id;

  update public.post_checkout_payment_actions set status = 'completed', completed_at = now(), safe_error_code = null
  where application_id = v_application.id and action_type = 'capture' and status <> 'completed';

  update public.orders set workflow_status = 'captured_pending_fulfilment', state_version = state_version + 1
  where id = v_application.order_id;

  return query select v_application.id,v_application.order_id,v_application.reservation_id;
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
  select * into v_application from public.post_checkout_applications
    where stripe_payment_intent_id = p_payment_intent_id for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status = 'captured' then raise exception 'POST_APPROVAL_ALREADY_CAPTURED'; end if;

  v_status := case
    when p_reason = 'form_expired' then 'form_expired'
    when p_reason = 'authorization_expired' then 'authorization_expired'
    else 'rejected'
  end;

  update public.post_checkout_applications set
    status = v_status,
    payment_status = case when p_reason = 'authorization_expired' then 'expired' else 'cancelled' end,
    capturable_amount_cents = 0,
    next_reminder_at = null,
    failure_code = null,
    state_version = state_version + 1
  where id = v_application.id;

  update public.post_checkout_payment_actions set status = 'completed', completed_at = now(), safe_error_code = null
  where application_id = v_application.id and action_type = 'cancel' and status <> 'completed';

  update public.orders set
    status = 'cancelled',
    workflow_status = case when p_reason = 'form_expired' then 'form_expired' when p_reason = 'authorization_expired' then 'authorization_expired' else 'rejected' end,
    state_version = state_version + 1
  where id = v_application.order_id;

  update public.reservations set status = 'cancelled'
  where id = v_application.reservation_id and status not in ('fulfilled','refunded','partially_refunded');

  update public.checkout_attempts set status = 'session_expired'
  where id = v_application.checkout_attempt_id and status <> 'fulfilled';

  return query select v_application.id,v_application.order_id,v_application.reservation_id;
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
  select * into v_application from public.post_checkout_applications where id = p_application_id for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.status not in ('awaiting_form','draft') or v_application.payment_status <> 'authorized' then
    raise exception 'POST_APPROVAL_DEADLINE_NOT_EXTENDABLE';
  end if;
  if p_form_due_at <= now() then raise exception 'POST_APPROVAL_FORM_DEADLINE_INVALID'; end if;
  if v_application.capture_before is not null and p_form_due_at >= v_application.capture_before - interval '60 minutes' then
    raise exception 'POST_APPROVAL_FORM_DEADLINE_TOO_LATE';
  end if;

  update public.post_checkout_applications set
    form_due_at = p_form_due_at,
    next_reminder_at = least(p_form_due_at,now() + interval '10 minutes'),
    state_version = state_version + 1
  where id = v_application.id
  returning * into v_application;

  insert into public.audit_logs (id,actor_id,actor_email,action,entity_type,entity_id,metadata,created_at)
  select 'audit_' || replace(gen_random_uuid()::text,'-',''),p_actor_id,coalesce(p.email,'system'),
    'post_checkout.form_deadline_extended','post_checkout_application',v_application.id::text,
    jsonb_build_object('formDueAt',p_form_due_at),now()
  from public.profiles p where p.id = p_actor_id;

  return query select v_application.id,v_application.form_due_at,v_application.state_version;
end;
$$;

create or replace function public.skie_mark_post_checkout_reminder_queued(
  p_application_id uuid,
  p_next_reminder_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.post_checkout_applications set
    reminder_count = reminder_count + 1,
    last_reminder_at = now(),
    next_reminder_at = p_next_reminder_at,
    state_version = state_version + 1
  where id = p_application_id
    and status in ('awaiting_form','draft')
    and payment_status = 'authorized';
end;
$$;

revoke all on function public.skie_prepare_post_checkout_application(uuid,text,integer,jsonb,jsonb,timestamptz) from public, anon, authenticated;
revoke all on function public.skie_record_post_checkout_authorization(uuid,text,text,integer,integer,text,timestamptz) from public, anon, authenticated;
revoke all on function public.skie_save_post_checkout_draft(uuid,uuid,jsonb,integer,integer) from public, anon, authenticated;
revoke all on function public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz) from public, anon, authenticated;
revoke all on function public.skie_request_post_checkout_decision(uuid,uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.skie_mark_post_checkout_capture_confirmed(text,integer) from public, anon, authenticated;
revoke all on function public.skie_mark_post_checkout_cancelled(text,text) from public, anon, authenticated;
revoke all on function public.skie_extend_post_checkout_form_deadline(uuid,uuid,timestamptz) from public, anon, authenticated;
revoke all on function public.skie_mark_post_checkout_reminder_queued(uuid,timestamptz) from public, anon, authenticated;

grant execute on function public.skie_prepare_post_checkout_application(uuid,text,integer,jsonb,jsonb,timestamptz) to service_role;
grant execute on function public.skie_record_post_checkout_authorization(uuid,text,text,integer,integer,text,timestamptz) to service_role;
grant execute on function public.skie_save_post_checkout_draft(uuid,uuid,jsonb,integer,integer) to service_role;
grant execute on function public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz) to service_role;
grant execute on function public.skie_request_post_checkout_decision(uuid,uuid,text,text,text,text) to service_role;
grant execute on function public.skie_mark_post_checkout_capture_confirmed(text,integer) to service_role;
grant execute on function public.skie_mark_post_checkout_cancelled(text,text) to service_role;
grant execute on function public.skie_extend_post_checkout_form_deadline(uuid,uuid,timestamptz) to service_role;
grant execute on function public.skie_mark_post_checkout_reminder_queued(uuid,timestamptz) to service_role;

commit;
