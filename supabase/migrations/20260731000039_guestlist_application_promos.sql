-- Dedicated guest-list application promos.
-- Eligible ticket lines are discounted in full; product/add-on lines remain payable.
-- A zero-total guest-list request bypasses Stripe but still requires the mandatory
-- application form and an explicit admin approve/reject decision before fulfilment.

begin;

-- Extend promo purpose without weakening percentage, fixed or tracking controls.
alter table public.promo_codes
  drop constraint if exists promo_codes_discount_type_check;
alter table public.promo_codes
  drop constraint if exists promo_codes_discount_value_check;
alter table public.promo_codes
  drop constraint if exists promo_codes_guestlist_product_scope_check;

alter table public.promo_codes
  add constraint promo_codes_discount_type_check
  check (discount_type in ('percentage','fixed','tracking','guestlist'));

alter table public.promo_codes
  add constraint promo_codes_discount_value_check
  check (
    (discount_type = 'percentage' and percent_off > 0 and percent_off <= 100 and amount_off_cents is null)
    or (discount_type = 'fixed' and amount_off_cents > 0 and percent_off is null)
    or (discount_type in ('tracking','guestlist') and percent_off is null and amount_off_cents is null)
  );

alter table public.promo_codes
  add constraint promo_codes_guestlist_product_scope_check
  check (discount_type <> 'guestlist' or cardinality(product_ids) = 0);

-- A no-payment approval is valid and distinct from missing or failed payment.
alter table public.post_checkout_applications
  drop constraint if exists post_checkout_applications_payment_status_check;
alter table public.post_checkout_applications
  add constraint post_checkout_applications_payment_status_check
  check (payment_status in (
    'authorization_pending','authorized','not_required','capture_requested','captured',
    'cancel_requested','cancelled','expired','failed','reconciliation_required'
  ));

-- Reminders apply to paid authorisations and no-payment guest-list applications.
drop index if exists public.post_checkout_applications_reminder_idx;
create index post_checkout_applications_reminder_idx
  on public.post_checkout_applications(next_reminder_at)
  where status in ('awaiting_form','draft')
    and payment_status in ('authorized','not_required');

create or replace function public.skie_build_guestlist_discount_allocation(
  p_promo_code_id uuid,
  p_ticket_lines jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_promo public.promo_codes%rowtype;
  v_line jsonb;
  v_reference_id text;
  v_line_cents integer;
  v_allocation jsonb := '[]'::jsonb;
begin
  select * into v_promo
  from public.promo_codes
  where id = p_promo_code_id;
  if not found or v_promo.discount_type <> 'guestlist' then
    raise exception 'GUESTLIST_PROMO_REQUIRED';
  end if;
  if jsonb_typeof(p_ticket_lines) <> 'array' then
    raise exception 'ORDER_DISCOUNT_ALLOCATION_INVALID';
  end if;

  for v_line in select value from jsonb_array_elements(p_ticket_lines)
  loop
    v_reference_id := v_line ->> 'ticket_type_id';
    v_line_cents := coalesce((v_line ->> 'quantity')::integer,0)
      * coalesce((v_line ->> 'unit_price_cents')::integer,0);
    if v_line_cents > 0
      and (
        cardinality(v_promo.ticket_type_ids) = 0
        or v_reference_id = any(v_promo.ticket_type_ids)
      ) then
      v_allocation := v_allocation || jsonb_build_array(jsonb_build_object(
        'kind','ticket',
        'reference_id',v_reference_id,
        'discount_cents',v_line_cents
      ));
    end if;
  end loop;

  if jsonb_array_length(v_allocation) = 0 then
    raise exception 'PROMO_ITEMS_NOT_ELIGIBLE';
  end if;
  return v_allocation;
end;
$$;

-- Preserve the validated standard promo implementation and expose a wrapper
-- under the existing application contract.
alter function public.skie_reserve_checkout_with_promo(
  uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,text,uuid,integer
) rename to skie_reserve_checkout_with_promo_standard;

create or replace function public.skie_reserve_checkout_with_promo(
  p_customer_id uuid,
  p_customer_email text,
  p_customer_name text,
  p_event_id text,
  p_event_title text,
  p_event_public_capacity integer,
  p_currency text,
  p_expires_at timestamptz,
  p_ticket_lines jsonb,
  p_product_lines jsonb default '[]'::jsonb,
  p_allocation_id text default null,
  p_promo_code text default null,
  p_reservation_key uuid default gen_random_uuid(),
  p_version integer default 1
)
returns table(
  reservation_id uuid,
  order_id uuid,
  checkout_attempt_id uuid,
  idempotency_key uuid,
  discount_cents integer,
  promo_code_id uuid
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_promo public.promo_codes%rowtype;
  v_reserved record;
  v_subtotal integer;
  v_eligible_ticket_cents integer;
  v_ticket_units integer;
  v_discount_allocation jsonb;
begin
  if p_promo_code is null or p_promo_code !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$' then
    raise exception using errcode = '22023', message = 'PROMO_INVALID';
  end if;

  select * into v_promo
  from public.promo_codes
  where lower(code) = lower(trim(p_promo_code));

  if not found or v_promo.discount_type <> 'guestlist' then
    return query
    select * from public.skie_reserve_checkout_with_promo_standard(
      p_customer_id,p_customer_email,p_customer_name,p_event_id,p_event_title,
      p_event_public_capacity,p_currency,p_expires_at,p_ticket_lines,p_product_lines,
      p_allocation_id,p_promo_code,p_reservation_key,p_version
    );
    return;
  end if;

  select * into v_promo
  from public.promo_codes
  where id = v_promo.id
  for update;

  if not v_promo.active or v_promo.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'PROMO_NOT_AVAILABLE';
  end if;
  if v_promo.valid_from is not null and v_promo.valid_from > now() then
    raise exception using errcode = 'P0001', message = 'PROMO_NOT_STARTED';
  end if;
  if v_promo.expires_at is not null and v_promo.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'PROMO_EXPIRED';
  end if;
  if cardinality(v_promo.event_ids) > 0 and not (p_event_id = any(v_promo.event_ids)) then
    raise exception using errcode = 'P0001', message = 'PROMO_EVENT_RESTRICTED';
  end if;
  if cardinality(v_promo.product_ids) > 0 then
    raise exception using errcode = 'P0001', message = 'GUESTLIST_PRODUCTS_NOT_DISCOUNTABLE';
  end if;

  select
    coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer),0)
    + (
      select coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer),0)
      from jsonb_array_elements(coalesce(p_product_lines,'[]'::jsonb)) as product(line)
    )
  into v_subtotal
  from jsonb_array_elements(coalesce(p_ticket_lines,'[]'::jsonb)) as ticket(line);

  if v_subtotal < v_promo.minimum_order_cents then
    raise exception using errcode = 'P0001', message = 'PROMO_MINIMUM_NOT_MET';
  end if;
  if v_promo.first_purchase_only and exists(
    select 1
    from public.orders
    where customer_id = p_customer_id
      and status in (
        'payment_received','fulfilment_pending','paid_unfulfilled','fulfilled',
        'partially_refunded','refunded','disputed','suspended'
      )
  ) then
    raise exception using errcode = 'P0001', message = 'PROMO_FIRST_PURCHASE_ONLY';
  end if;

  select
    coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer),0),
    coalesce(sum((line ->> 'quantity')::integer),0)
  into v_eligible_ticket_cents,v_ticket_units
  from jsonb_array_elements(coalesce(p_ticket_lines,'[]'::jsonb)) as ticket(line)
  where cardinality(v_promo.ticket_type_ids) = 0
    or line ->> 'ticket_type_id' = any(v_promo.ticket_type_ids);

  if v_eligible_ticket_cents <= 0 or v_ticket_units <= 0 then
    raise exception using errcode = 'P0001', message = 'PROMO_ITEMS_NOT_ELIGIBLE';
  end if;

  select * into v_reserved
  from public.skie_reserve_checkout_v2(
    p_customer_id,p_customer_email,p_customer_name,p_event_id,p_event_title,
    p_event_public_capacity,p_currency,p_expires_at,p_ticket_lines,p_product_lines,
    p_allocation_id,v_eligible_ticket_cents,p_reservation_key,p_version
  );

  perform public.skie_claim_promo_usage(
    v_promo.id,v_reserved.reservation_id,v_reserved.order_id,p_customer_id,p_event_id,
    v_ticket_units,v_subtotal,v_eligible_ticket_cents,v_subtotal-v_eligible_ticket_cents,
    p_expires_at
  );

  v_discount_allocation := public.skie_build_guestlist_discount_allocation(
    v_promo.id,p_ticket_lines
  );

  update public.orders
  set discount_allocation = v_discount_allocation
  where id = v_reserved.order_id;

  update public.reservations
  set promo_code_id = v_promo.id
  where id = v_reserved.reservation_id;

  return query select
    v_reserved.reservation_id,
    v_reserved.order_id,
    v_reserved.checkout_attempt_id,
    v_reserved.idempotency_key,
    v_eligible_ticket_cents,
    v_promo.id;
end;
$$;

create or replace function public.skie_activate_guestlist_application(
  p_order_id uuid
)
returns table(application_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_order public.orders%rowtype;
  v_application public.post_checkout_applications%rowtype;
  v_promo public.promo_codes%rowtype;
  v_duplicate boolean := false;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;
  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;
  if v_order.checkout_mode <> 'post_checkout_approval' then raise exception 'POST_APPROVAL_MODE_MISMATCH'; end if;
  if v_order.total_cents <> 0 then raise exception 'GUESTLIST_PAYMENT_STILL_REQUIRED'; end if;

  select promo.* into v_promo
  from public.reservations as reservation
  join public.promo_codes as promo on promo.id = reservation.promo_code_id
  where reservation.id = v_order.reservation_id;
  if not found or v_promo.discount_type <> 'guestlist' then raise exception 'GUESTLIST_PROMO_REQUIRED'; end if;

  select * into v_application
  from public.post_checkout_applications
  where order_id = p_order_id
  for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;

  if v_application.payment_status = 'not_required'
    and v_application.status in ('awaiting_form','draft','submitted','under_review') then
    v_duplicate := true;
  elsif v_application.payment_status <> 'authorization_pending'
    or v_application.status <> 'awaiting_authorization'
    or v_application.stripe_checkout_session_id is not null
    or v_application.stripe_payment_intent_id is not null then
    raise exception 'GUESTLIST_APPLICATION_NOT_ACTIVATABLE';
  end if;

  if not v_duplicate then
    update public.post_checkout_applications
    set status = 'awaiting_form',
        payment_status = 'not_required',
        authorized_amount_cents = 0,
        capturable_amount_cents = 0,
        capture_before = null,
        next_reminder_at = least(form_due_at,now() + interval '10 minutes'),
        last_activity_at = now(),
        state_version = state_version + 1,
        failure_code = null
    where id = v_application.id
    returning * into v_application;

    update public.checkout_attempts
    set status = 'session_active',
        provider_expires_at = v_application.form_due_at,
        failure_code = null
    where id = v_application.checkout_attempt_id;

    update public.reservations
    set status = 'session_active',
        expires_at = greatest(expires_at,v_application.form_due_at),
        failure_code = null
    where id = v_application.reservation_id
      and status in ('reserved','session_active');

    update public.orders
    set status = 'checkout_pending',
        workflow_status = 'awaiting_form',
        state_version = state_version + 1
    where id = p_order_id;

    insert into public.post_checkout_audit_events(
      application_id,order_id,action,safe_metadata
    ) values (
      v_application.id,p_order_id,'post_checkout.guestlist_activated',
      jsonb_build_object('paymentRequired',false,'ticketDiscountCents',v_order.discount_cents)
    );
  end if;

  return query select v_application.id,v_duplicate;
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
set search_path = public, pg_catalog
as $$
declare
  v_application public.post_checkout_applications%rowtype;
begin
  if jsonb_typeof(p_answers) <> 'object' then raise exception 'POST_APPROVAL_ANSWERS_INVALID'; end if;
  select * into v_application
  from public.post_checkout_applications
  where order_id = p_order_id and customer_id = p_customer_id
  for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.state_version <> p_expected_state_version then raise exception 'POST_APPROVAL_STALE_VERSION'; end if;
  if v_application.status not in ('awaiting_form','draft')
    or v_application.payment_status not in ('authorized','not_required') then
    raise exception 'POST_APPROVAL_FORM_NOT_EDITABLE';
  end if;
  if now() >= v_application.form_due_at then raise exception 'POST_APPROVAL_FORM_EXPIRED'; end if;

  update public.post_checkout_applications
  set draft_answers = p_answers,
      completion_percentage = greatest(0,least(100,p_completion_percentage)),
      status = 'draft',
      last_activity_at = now(),
      state_version = state_version + 1
  where id = v_application.id
  returning * into v_application;

  update public.orders
  set workflow_status = 'form_draft',state_version = state_version + 1
  where id = p_order_id and workflow_status in ('awaiting_form','form_draft');

  return query select v_application.id,v_application.state_version,v_application.updated_at;
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
set search_path = public, pg_catalog
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
  if v_application.status not in ('awaiting_form','draft')
    or v_application.payment_status not in ('authorized','not_required') then
    raise exception 'POST_APPROVAL_FORM_NOT_SUBMITTABLE';
  end if;
  if now() >= v_application.form_due_at then raise exception 'POST_APPROVAL_FORM_EXPIRED'; end if;
  if v_application.payment_status = 'authorized'
    and v_application.capture_before is not null
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
  set workflow_status = 'under_review',state_version = state_version + 1
  where id = p_order_id;

  return query select v_application.id,v_application.state_version,v_application.submitted_at;
end;
$$;

create or replace function public.skie_request_guestlist_decision(
  p_application_id uuid,
  p_actor_id uuid,
  p_decision text,
  p_internal_reason text,
  p_customer_message text
)
returns table(decision_id uuid, action_type text, order_id uuid)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_order public.orders%rowtype;
  v_decision public.post_checkout_decisions%rowtype;
  v_promo public.promo_codes%rowtype;
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
  if v_application.payment_status <> 'not_required' then raise exception 'GUESTLIST_PAYMENT_STATE_INVALID'; end if;
  if v_application.stripe_checkout_session_id is not null
    or v_application.stripe_payment_intent_id is not null then
    raise exception 'GUESTLIST_STRIPE_REFERENCE_INVALID';
  end if;

  select * into v_order
  from public.orders
  where id = v_application.order_id
  for update;
  if not found or v_order.total_cents <> 0 then raise exception 'GUESTLIST_PAYMENT_STILL_REQUIRED'; end if;

  select promo.* into v_promo
  from public.reservations as reservation
  join public.promo_codes as promo on promo.id = reservation.promo_code_id
  where reservation.id = v_application.reservation_id;
  if not found or v_promo.discount_type <> 'guestlist' then raise exception 'GUESTLIST_PROMO_REQUIRED'; end if;

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

  insert into public.post_checkout_decisions(
    application_id,order_id,decision,internal_reason,customer_message,actor_id,
    application_status_at_decision,payment_status_at_decision,amount_cents,currency,capture_before
  ) values (
    v_application.id,v_application.order_id,p_decision,trim(p_internal_reason),
    nullif(trim(coalesce(p_customer_message,'')),''),p_actor_id,v_application.status,
    v_application.payment_status,0,v_application.currency,null
  )
  on conflict (application_id) do nothing
  returning * into v_decision;
  if v_decision.id is null then raise exception 'POST_APPROVAL_ALREADY_DECIDED'; end if;

  if p_decision in ('approve','approve_without_form') then
    v_action_type := 'fulfil';
    update public.post_checkout_applications
    set status = case when p_decision = 'approve_without_form' then 'approved_override' else 'approved' end,
        reviewed_at = now(),
        reviewed_by = p_actor_id,
        override_used = p_decision = 'approve_without_form',
        override_reason = case when p_decision = 'approve_without_form' then trim(p_internal_reason) else override_reason end,
        next_reminder_at = null,
        failure_code = null,
        state_version = state_version + 1,
        last_activity_at = now()
    where id = v_application.id;

    update public.orders
    set workflow_status = 'capture_pending',state_version = state_version + 1
    where id = v_application.order_id;
  else
    v_action_type := 'release';
    update public.post_checkout_applications
    set status = case when p_decision = 'withdraw' then 'withdrawn' else 'rejected' end,
        payment_status = 'cancelled',
        reviewed_at = now(),
        reviewed_by = p_actor_id,
        next_reminder_at = null,
        failure_code = null,
        state_version = state_version + 1,
        last_activity_at = now()
    where id = v_application.id;

    update public.checkout_attempts
    set status = 'session_failed',failure_code = 'GUESTLIST_APPLICATION_RELEASED'
    where id = v_application.checkout_attempt_id
      and status in ('creating_session','session_active');

    update public.reservations
    set status = 'failed',failure_code = 'GUESTLIST_APPLICATION_RELEASED'
    where id = v_application.reservation_id
      and status in ('reserved','session_active');

    update public.orders
    set status = 'failed',workflow_status = 'rejected',state_version = state_version + 1
    where id = v_application.order_id
      and status in ('reserved','checkout_pending');

    update public.promo_redemptions
    set status = 'released',released_at = coalesce(released_at,now())
    where order_id = v_application.order_id and status = 'reserved';
  end if;

  insert into public.post_checkout_audit_events(
    application_id,order_id,actor_id,action,safe_metadata
  ) values (
    v_application.id,v_application.order_id,p_actor_id,
    'post_checkout.guestlist_' || p_decision,
    jsonb_build_object('decisionId',v_decision.id,'actionType',v_action_type)
  );

  return query select v_decision.id,v_action_type,v_application.order_id;
end;
$$;

create or replace function public.skie_mark_guestlist_manual_review(
  p_order_id uuid,
  p_failure_code text
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update public.post_checkout_applications
  set status = 'manual_review',
      failure_code = left(coalesce(p_failure_code,'GUESTLIST_FULFILMENT_FAILED'),120),
      state_version = state_version + 1,
      last_activity_at = now()
  where order_id = p_order_id and payment_status = 'not_required';

  update public.orders
  set workflow_status = 'manual_review',state_version = state_version + 1
  where id = p_order_id;

  insert into public.post_checkout_audit_events(order_id,action,safe_metadata)
  values (
    p_order_id,'post_checkout.guestlist_manual_review',
    jsonb_build_object('failureCode',left(coalesce(p_failure_code,'GUESTLIST_FULFILMENT_FAILED'),120))
  );
end;
$$;

create or replace function public.skie_expire_guestlist_application(
  p_application_id uuid,
  p_reason text
)
returns table(application_id uuid, order_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_status text;
  v_duplicate boolean := false;
begin
  if p_reason not in ('form_expired','review_expired') then
    raise exception 'GUESTLIST_EXPIRY_REASON_INVALID';
  end if;

  select * into v_application
  from public.post_checkout_applications
  where id = p_application_id
  for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status in ('cancelled','expired') then
    v_duplicate := true;
    return query select v_application.id,v_application.order_id,v_duplicate;
    return;
  end if;
  if v_application.payment_status <> 'not_required' then raise exception 'GUESTLIST_PAYMENT_STATE_INVALID'; end if;
  if v_application.status not in ('awaiting_form','draft','submitted','under_review') then
    raise exception 'GUESTLIST_APPLICATION_NOT_EXPIRABLE';
  end if;

  v_status := case when p_reason = 'form_expired' then 'form_expired' else 'rejected' end;

  update public.post_checkout_applications
  set status = v_status,
      payment_status = 'expired',
      next_reminder_at = null,
      failure_code = upper(p_reason),
      state_version = state_version + 1,
      last_activity_at = now()
  where id = v_application.id;

  update public.checkout_attempts
  set status = 'session_expired',failure_code = upper(p_reason)
  where id = v_application.checkout_attempt_id
    and status in ('creating_session','session_active');

  update public.reservations
  set status = 'expired',failure_code = upper(p_reason)
  where id = v_application.reservation_id
    and status in ('reserved','session_active');

  update public.orders
  set status = 'expired',
      workflow_status = case when p_reason = 'form_expired' then 'form_expired' else 'rejected' end,
      state_version = state_version + 1
  where id = v_application.order_id
    and status in ('reserved','checkout_pending');

  update public.promo_redemptions
  set status = 'released',released_at = coalesce(released_at,now())
  where order_id = v_application.order_id and status = 'reserved';

  insert into public.post_checkout_audit_events(
    application_id,order_id,action,safe_metadata
  ) values (
    v_application.id,v_application.order_id,'post_checkout.guestlist_' || p_reason,
    jsonb_build_object('paymentRequired',false)
  );

  return query select v_application.id,v_application.order_id,v_duplicate;
end;
$$;

create or replace function public.skie_mark_post_checkout_fulfilled(
  p_order_id uuid
)
returns table(application_id uuid, order_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_application public.post_checkout_applications%rowtype;
  v_order public.orders%rowtype;
  v_duplicate boolean := false;
  v_valid_ticket_count integer;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;
  if not found then raise exception 'POST_APPROVAL_ORDER_NOT_FOUND'; end if;
  if v_order.checkout_mode <> 'post_checkout_approval' then raise exception 'POST_APPROVAL_MODE_MISMATCH'; end if;
  if v_order.status <> 'fulfilled' then raise exception 'POST_APPROVAL_ORDER_NOT_FULFILLED'; end if;

  select * into v_application
  from public.post_checkout_applications
  where order_id = p_order_id
  for update;
  if not found then raise exception 'POST_APPROVAL_APPLICATION_NOT_FOUND'; end if;
  if v_application.payment_status not in ('captured','not_required') then
    raise exception 'POST_APPROVAL_PAYMENT_NOT_CAPTURED';
  end if;
  if v_application.status not in ('approved','approved_override') then
    raise exception 'POST_APPROVAL_APPLICATION_NOT_APPROVED';
  end if;

  select count(*) into v_valid_ticket_count
  from public.tickets
  where order_id = p_order_id and status = 'valid';
  if v_valid_ticket_count < 1 then raise exception 'POST_APPROVAL_NO_VALID_TICKETS'; end if;

  if v_order.workflow_status = 'fulfilled' then
    v_duplicate := true;
  else
    update public.orders
    set workflow_status = 'fulfilled',state_version = state_version + 1
    where id = p_order_id;

    insert into public.post_checkout_audit_events(
      application_id,order_id,action,safe_metadata
    ) values (
      v_application.id,p_order_id,'post_checkout.fulfilled',
      jsonb_build_object(
        'validTicketCount',v_valid_ticket_count,
        'paymentRequired',v_application.payment_status <> 'not_required'
      )
    );
  end if;

  return query select v_application.id,p_order_id,v_duplicate;
end;
$$;

-- Replace admin classification so an approved no-payment application is complete
-- only after its ticket has been durably fulfilled.
create or replace function public.skie_list_post_checkout_admin_page(
  p_filter text default 'active',
  p_search text default '',
  p_event_id text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 50
)
returns table(application_id uuid, created_at timestamptz, admin_bucket text)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with source_rows as (
    select
      application.id,
      application.created_at,
      application.status,
      application.payment_status,
      application.capture_before,
      application.event_id,
      coalesce(orders.status,'') as order_status,
      latest_action.action_type,
      latest_action.status as action_status,
      coalesce(latest_action.attempt_count,0) as action_attempt_count,
      coalesce(reservation.expected_subtotal_cents,orders.subtotal_cents,orders.total_cents,0) as subtotal_cents,
      coalesce(reservation.expected_discount_cents,orders.discount_cents,0) as discount_cents,
      coalesce(reservation.expected_total_cents,orders.total_cents,0) as expected_total_cents,
      coalesce(orders.total_cents,0) as total_cents,
      lower(concat_ws(' ',
        profile.first_name,profile.last_name,profile.email,application.event_id,promo.code,promo.internal_name
      )) as search_text
    from public.post_checkout_applications as application
    left join public.profiles as profile on profile.id = application.customer_id
    left join public.orders as orders on orders.id = application.order_id
    left join public.reservations as reservation on reservation.id = application.reservation_id
    left join public.promo_codes as promo on promo.id = reservation.promo_code_id
    left join lateral (
      select action.action_type,action.status,action.attempt_count
      from public.post_checkout_payment_actions as action
      where action.application_id = application.id
      order by action.created_at desc,action.id desc
      limit 1
    ) as latest_action on true
    where (p_event_id is null or application.event_id = p_event_id)
      and (
        trim(coalesce(p_search,'')) = ''
        or lower(concat_ws(' ',
          profile.first_name,profile.last_name,profile.email,application.event_id,promo.code,promo.internal_name
        )) like '%' || lower(trim(p_search)) || '%'
      )
  ), classified as (
    select
      row.*,
      row.status = 'form_expired'
        and row.payment_status = 'cancel_requested'
        and row.action_type = 'cancel'
        and row.action_status = 'requested'
        and row.action_attempt_count = 0 as recoverable_timeout,
      case
        when row.subtotal_cents - row.discount_cents <> row.total_cents
          or row.expected_total_cents <> row.total_cents
          or row.status = 'manual_review'
          or row.payment_status in ('failed','reconciliation_required')
          or row.action_status in ('failed','manual_review')
          or (row.payment_status = 'captured' and row.order_status <> 'fulfilled')
          or (
            row.status in ('approved','approved_override')
            and row.payment_status = 'not_required'
            and row.order_status <> 'fulfilled'
          )
          or (
            row.status in ('approved','approved_override')
            and row.payment_status not in ('captured','not_required')
            and coalesce(row.action_status,'') not in ('requested','processing','retry')
          )
          or (
            row.status in ('rejected','form_expired','authorization_expired','withdrawn')
            and row.payment_status not in ('cancelled','expired')
            and coalesce(row.action_status,'') not in ('requested','processing','retry')
            and not (
              row.status = 'form_expired'
              and row.payment_status = 'cancel_requested'
              and row.action_type = 'cancel'
              and row.action_status = 'requested'
              and row.action_attempt_count = 0
            )
          ) then 'attention'
        when (
          row.status in ('approved','approved_override')
          and row.payment_status in ('captured','not_required')
          and row.order_status = 'fulfilled'
        ) or (
          row.status in ('rejected','form_expired','authorization_expired','withdrawn')
          and row.payment_status in ('cancelled','expired')
        ) then 'completed'
        else 'active'
      end as admin_bucket
    from source_rows as row
  ), filtered as (
    select classified.*
    from classified
    where case p_filter
      when 'attention' then classified.admin_bucket = 'attention'
      when 'completed' then classified.admin_bucket = 'completed'
      when 'needs_form' then classified.status in ('awaiting_form','draft') or classified.recoverable_timeout
      when 'review' then classified.status in ('submitted','under_review')
      when 'expiry' then classified.capture_before is not null
        and classified.capture_before <= now() + interval '12 hours'
        and classified.payment_status in ('authorized','capture_requested','cancel_requested')
        and classified.admin_bucket <> 'completed'
      when 'all' then true
      else classified.admin_bucket = 'active'
    end
  )
  select filtered.id,filtered.created_at,filtered.admin_bucket
  from filtered
  where p_cursor_created_at is null
    or filtered.created_at < p_cursor_created_at
    or (
      filtered.created_at = p_cursor_created_at
      and p_cursor_id is not null
      and filtered.id < p_cursor_id
    )
  order by filtered.created_at desc,filtered.id desc
  limit greatest(1,least(coalesce(p_limit,50),100));
$$;

create or replace function public.skie_guestlist_application_schema_health()
returns table(schema_version integer, ready boolean, details jsonb)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with checks as (
    select
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.promo_codes'::regclass
          and conname = 'promo_codes_guestlist_product_scope_check'
          and convalidated
      ) as guestlist_scope_guard,
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.post_checkout_applications'::regclass
          and conname = 'post_checkout_applications_payment_status_check'
          and position('not_required' in pg_get_constraintdef(oid)) > 0
          and convalidated
      ) as no_payment_state_guard,
      to_regprocedure('public.skie_activate_guestlist_application(uuid)') is not null as activation_rpc,
      to_regprocedure('public.skie_request_guestlist_decision(uuid,uuid,text,text,text)') is not null as decision_rpc,
      to_regprocedure('public.skie_expire_guestlist_application(uuid,text)') is not null as expiry_rpc,
      to_regprocedure('public.skie_mark_guestlist_manual_review(uuid,text)') is not null as review_rpc,
      to_regprocedure('public.skie_build_guestlist_discount_allocation(uuid,jsonb)') is not null as allocation_rpc,
      coalesce((
        select position('guestlist' in lower(pg_get_functiondef(p.oid))) > 0
          and position('p_product_lines' in pg_get_functiondef(p.oid)) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_reserve_checkout_with_promo'
        limit 1
      ),false) as reserve_guard,
      coalesce((
        select position('not_required' in lower(pg_get_functiondef(p.oid))) > 0
          and position('order_status <> ''fulfilled''' in lower(pg_get_functiondef(p.oid))) > 0
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'skie_list_post_checkout_admin_page'
        limit 1
      ),false) as admin_guard
  )
  select
    39,
    guestlist_scope_guard and no_payment_state_guard and activation_rpc and decision_rpc
      and expiry_rpc and review_rpc and allocation_rpc and reserve_guard and admin_guard,
    jsonb_build_object(
      'guestlistScopeGuard',guestlist_scope_guard,
      'noPaymentStateGuard',no_payment_state_guard,
      'activationRpc',activation_rpc,
      'decisionRpc',decision_rpc,
      'expiryRpc',expiry_rpc,
      'reviewRpc',review_rpc,
      'allocationRpc',allocation_rpc,
      'reserveGuard',reserve_guard,
      'adminGuard',admin_guard
    )
  from checks;
$$;

revoke all on function public.skie_build_guestlist_discount_allocation(uuid,jsonb)
from public, anon, authenticated;
revoke all on function public.skie_reserve_checkout_with_promo(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,text,uuid,integer)
from public, anon, authenticated;
revoke all on function public.skie_activate_guestlist_application(uuid)
from public, anon, authenticated;
revoke all on function public.skie_save_post_checkout_draft(uuid,uuid,jsonb,integer,integer)
from public, anon, authenticated;
revoke all on function public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)
from public, anon, authenticated;
revoke all on function public.skie_request_guestlist_decision(uuid,uuid,text,text,text)
from public, anon, authenticated;
revoke all on function public.skie_mark_guestlist_manual_review(uuid,text)
from public, anon, authenticated;
revoke all on function public.skie_expire_guestlist_application(uuid,text)
from public, anon, authenticated;
revoke all on function public.skie_mark_post_checkout_fulfilled(uuid)
from public, anon, authenticated;
revoke all on function public.skie_list_post_checkout_admin_page(text,text,text,timestamptz,uuid,integer)
from public, anon, authenticated;
revoke all on function public.skie_guestlist_application_schema_health()
from public, anon, authenticated;

grant execute on function public.skie_build_guestlist_discount_allocation(uuid,jsonb)
to service_role;
grant execute on function public.skie_reserve_checkout_with_promo(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,text,uuid,integer)
to service_role;
grant execute on function public.skie_activate_guestlist_application(uuid)
to service_role;
grant execute on function public.skie_save_post_checkout_draft(uuid,uuid,jsonb,integer,integer)
to service_role;
grant execute on function public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)
to service_role;
grant execute on function public.skie_request_guestlist_decision(uuid,uuid,text,text,text)
to service_role;
grant execute on function public.skie_mark_guestlist_manual_review(uuid,text)
to service_role;
grant execute on function public.skie_expire_guestlist_application(uuid,text)
to service_role;
grant execute on function public.skie_mark_post_checkout_fulfilled(uuid)
to service_role;
grant execute on function public.skie_list_post_checkout_admin_page(text,text,text,timestamptz,uuid,integer)
to service_role;
grant execute on function public.skie_guestlist_application_schema_health()
to service_role;

notify pgrst, 'reload schema';
commit;
