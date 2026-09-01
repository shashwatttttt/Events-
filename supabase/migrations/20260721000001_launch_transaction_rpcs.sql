-- SKIE EVENTS atomic transaction functions.
-- Requires 20260721_launch_transaction_foundation.sql.

begin;

create or replace function public.skie_reserve_checkout(
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
  p_expected_discount_cents integer default 0,
  p_reservation_key uuid default gen_random_uuid(),
  p_version integer default 1
)
returns table(reservation_id uuid, order_id uuid, checkout_attempt_id uuid, idempotency_key uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_reservation_id uuid;
  v_order_id uuid;
  v_attempt_id uuid;
  v_idempotency_key uuid;
  v_subtotal integer;
  v_total integer;
  v_ticket_total integer;
  v_line jsonb;
  v_line_id uuid;
  v_issued integer;
  v_reserved integer;
  v_customer_issued integer;
  v_customer_reserved integer;
  v_sold integer;
  v_allocation public.ticket_allocations;
begin
  if p_expires_at <= v_now or p_expires_at > v_now + interval '24 hours' then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_EXPIRY';
  end if;
  if p_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'INVALID_CURRENCY';
  end if;
  if jsonb_typeof(p_ticket_lines) <> 'array' or jsonb_array_length(p_ticket_lines) <> 1 then
    raise exception using errcode = '22023', message = 'ONE_TICKET_LINE_REQUIRED';
  end if;
  if jsonb_typeof(p_product_lines) <> 'array' or jsonb_array_length(p_product_lines) > 20 then
    raise exception using errcode = '22023', message = 'INVALID_PRODUCT_LINES';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('event:' || p_event_id, 0));
  perform 1 from public.profiles where id = p_customer_id for key share;
  if not found then
    raise exception using errcode = '23503', message = 'CUSTOMER_NOT_FOUND';
  end if;
  if p_allocation_id is not null then
    select * into v_allocation from public.ticket_allocations where id = p_allocation_id for update;
    if not found
      or v_allocation.customer_id <> p_customer_id
      or v_allocation.event_id <> p_event_id
      or v_allocation.status <> 'unlocked'
      or v_allocation.expires_at <= v_now then
      raise exception using errcode = 'P0001', message = 'ALLOCATION_NOT_AVAILABLE';
    end if;
  end if;

  select coalesce(sum((line ->> 'quantity')::integer), 0)
    into v_ticket_total
    from jsonb_array_elements(p_ticket_lines) as lines(line);
  if v_ticket_total < 1 or v_ticket_total > 20 then
    raise exception using errcode = '22023', message = 'INVALID_TICKET_QUANTITY';
  end if;

  select count(*)::integer into v_issued
    from public.tickets
    where event_id = p_event_id
      and status not in ('cancelled','refunded','expired');
  select coalesce(sum(line.quantity), 0)::integer into v_reserved
    from public.reservations reservation
    join public.reservation_ticket_lines line on line.reservation_id = reservation.id
    where reservation.event_id = p_event_id
      and reservation.expires_at > v_now
      and reservation.status in ('reserved','session_active','payment_received','fulfilment_pending','paid_unfulfilled');
  if v_issued + v_reserved + v_ticket_total > p_event_public_capacity then
    raise exception using errcode = 'P0001', message = 'EVENT_CAPACITY_EXCEEDED';
  end if;

  for v_line in select value from jsonb_array_elements(p_ticket_lines)
  loop
    if coalesce((v_line ->> 'quantity')::integer, 0) < 1
      or coalesce((v_line ->> 'quantity')::integer, 0) > 20
      or coalesce((v_line ->> 'unit_price_cents')::integer, -1) < 0
      or coalesce((v_line ->> 'capacity')::integer, -1) < 0
      or coalesce((v_line ->> 'customer_limit')::integer, 0) < 1 then
      raise exception using errcode = '22023', message = 'INVALID_TICKET_LINE';
    end if;
    if p_allocation_id is not null and (
      v_allocation.ticket_type_id <> v_line ->> 'ticket_type_id'
      or v_allocation.price_cents <> (v_line ->> 'unit_price_cents')::integer
      or v_allocation.purchased_quantity + (v_line ->> 'quantity')::integer > v_allocation.max_quantity
    ) then
      raise exception using errcode = 'P0001', message = 'ALLOCATION_LIMIT_EXCEEDED';
    end if;

    select count(*)::integer into v_issued
      from public.tickets
      where event_id = p_event_id
        and ticket_type_id = v_line ->> 'ticket_type_id'
        and status not in ('cancelled','refunded','expired');
    select coalesce(sum(line.quantity), 0)::integer into v_reserved
      from public.reservations reservation
      join public.reservation_ticket_lines line on line.reservation_id = reservation.id
      where reservation.event_id = p_event_id
        and line.ticket_type_id = v_line ->> 'ticket_type_id'
        and reservation.expires_at > v_now
        and reservation.status in ('reserved','session_active','payment_received','fulfilment_pending','paid_unfulfilled');
    if v_issued + v_reserved + (v_line ->> 'quantity')::integer > (v_line ->> 'capacity')::integer then
      raise exception using errcode = 'P0001', message = 'TICKET_CAPACITY_EXCEEDED';
    end if;

    select count(*)::integer into v_customer_issued
      from public.tickets
      where customer_id = p_customer_id
        and event_id = p_event_id
        and ticket_type_id = v_line ->> 'ticket_type_id'
        and status not in ('cancelled','refunded','expired');
    select coalesce(sum(line.quantity), 0)::integer into v_customer_reserved
      from public.reservations reservation
      join public.reservation_ticket_lines line on line.reservation_id = reservation.id
      where reservation.customer_id = p_customer_id
        and reservation.event_id = p_event_id
        and line.ticket_type_id = v_line ->> 'ticket_type_id'
        and reservation.expires_at > v_now
        and reservation.status in ('reserved','session_active','payment_received','fulfilment_pending','paid_unfulfilled');
    if v_customer_issued + v_customer_reserved + (v_line ->> 'quantity')::integer > (v_line ->> 'customer_limit')::integer then
      raise exception using errcode = 'P0001', message = 'CUSTOMER_TICKET_LIMIT_EXCEEDED';
    end if;
  end loop;

  for v_line in select value from jsonb_array_elements(p_product_lines)
  loop
    if coalesce((v_line ->> 'quantity')::integer, 0) < 1
      or coalesce((v_line ->> 'quantity')::integer, 0) > 100
      or coalesce((v_line ->> 'unit_price_cents')::integer, -1) < 0
      or coalesce((v_line ->> 'stock_quantity')::integer, -1) < 0
      or coalesce((v_line ->> 'max_per_customer')::integer, 0) < 1 then
      raise exception using errcode = '22023', message = 'INVALID_PRODUCT_LINE';
    end if;
    select coalesce(sum(line.quantity - line.refunded_quantity), 0)::integer into v_sold
      from public.order_lines line
      join public.orders ordered on ordered.id = line.order_id
      where line.kind = 'product'
        and line.reference_id = v_line ->> 'product_id'
        and ordered.status in ('fulfilled','partially_refunded','disputed','suspended');
    select coalesce(sum(line.quantity), 0)::integer into v_reserved
      from public.reservations reservation
      join public.reservation_product_lines line on line.reservation_id = reservation.id
      where line.product_id = v_line ->> 'product_id'
        and reservation.expires_at > v_now
        and reservation.status in ('reserved','session_active','payment_received','fulfilment_pending','paid_unfulfilled');
    if v_sold + v_reserved + (v_line ->> 'quantity')::integer > (v_line ->> 'stock_quantity')::integer then
      raise exception using errcode = 'P0001', message = 'PRODUCT_STOCK_EXCEEDED';
    end if;

    select coalesce(sum(line.quantity - line.refunded_quantity), 0)::integer into v_customer_issued
      from public.order_lines line
      join public.orders ordered on ordered.id = line.order_id
      where line.kind = 'product'
        and line.reference_id = v_line ->> 'product_id'
        and ordered.customer_id = p_customer_id
        and ordered.status in ('fulfilled','partially_refunded','disputed','suspended');
    select coalesce(sum(line.quantity), 0)::integer into v_customer_reserved
      from public.reservations reservation
      join public.reservation_product_lines line on line.reservation_id = reservation.id
      where line.product_id = v_line ->> 'product_id'
        and reservation.customer_id = p_customer_id
        and reservation.expires_at > v_now
        and reservation.status in ('reserved','session_active','payment_received','fulfilment_pending','paid_unfulfilled');
    if v_customer_issued + v_customer_reserved + (v_line ->> 'quantity')::integer > (v_line ->> 'max_per_customer')::integer then
      raise exception using errcode = 'P0001', message = 'CUSTOMER_PRODUCT_LIMIT_EXCEEDED';
    end if;
  end loop;

  select coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer), 0)
    + (select coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer), 0)
       from jsonb_array_elements(p_product_lines) as product_lines(line))
    into v_subtotal
    from jsonb_array_elements(p_ticket_lines) as ticket_lines(line);
  v_total := v_subtotal - p_expected_discount_cents;
  if p_expected_discount_cents < 0 or v_total < 0 then
    raise exception using errcode = '22023', message = 'INVALID_DISCOUNT';
  end if;

  insert into public.reservations(
    reservation_key,version,customer_id,event_id,allocation_id,status,currency,
    expected_subtotal_cents,expected_discount_cents,expected_total_cents,expires_at,
    customer_email,customer_name,event_title
  ) values (
    p_reservation_key,p_version,p_customer_id,p_event_id,p_allocation_id,'reserved',p_currency,
    v_subtotal,p_expected_discount_cents,v_total,p_expires_at,
    lower(p_customer_email),p_customer_name,p_event_title
  ) returning id into v_reservation_id;

  for v_line in select value from jsonb_array_elements(p_ticket_lines)
  loop
    insert into public.reservation_ticket_lines(
      reservation_id,ticket_type_id,name,quantity,unit_price_cents,
      ticket_type_capacity,event_public_capacity,customer_limit
    ) values (
      v_reservation_id,v_line ->> 'ticket_type_id',v_line ->> 'name',
      (v_line ->> 'quantity')::integer,(v_line ->> 'unit_price_cents')::integer,
      (v_line ->> 'capacity')::integer,p_event_public_capacity,
      (v_line ->> 'customer_limit')::integer
    );
  end loop;

  for v_line in select value from jsonb_array_elements(p_product_lines)
  loop
    insert into public.reservation_product_lines(
      reservation_id,product_id,name,quantity,unit_price_cents,stock_quantity,
      max_per_customer,units_per_purchase,redeemable
    ) values (
      v_reservation_id,v_line ->> 'product_id',v_line ->> 'name',
      (v_line ->> 'quantity')::integer,(v_line ->> 'unit_price_cents')::integer,
      (v_line ->> 'stock_quantity')::integer,(v_line ->> 'max_per_customer')::integer,
      coalesce((v_line ->> 'units_per_purchase')::integer,1),
      coalesce((v_line ->> 'redeemable')::boolean,false)
    );
  end loop;

  insert into public.orders(
    reservation_id,customer_id,event_id,allocation_id,status,currency,
    subtotal_cents,discount_cents,total_cents
  ) values (
    v_reservation_id,p_customer_id,p_event_id,p_allocation_id,'reserved',p_currency,
    v_subtotal,p_expected_discount_cents,v_total
  ) returning id into v_order_id;

  for v_line_id, v_line in
    select line.id, to_jsonb(line) from public.reservation_ticket_lines line where line.reservation_id = v_reservation_id
  loop
    insert into public.order_lines(
      order_id,reservation_ticket_line_id,kind,reference_id,name,quantity,unit_price_cents
    ) values (
      v_order_id,v_line_id,'ticket',v_line ->> 'ticket_type_id',v_line ->> 'name',
      (v_line ->> 'quantity')::integer,(v_line ->> 'unit_price_cents')::integer
    );
  end loop;
  for v_line_id, v_line in
    select line.id, to_jsonb(line) from public.reservation_product_lines line where line.reservation_id = v_reservation_id
  loop
    insert into public.order_lines(
      order_id,reservation_product_line_id,kind,reference_id,name,quantity,unit_price_cents
    ) values (
      v_order_id,v_line_id,'product',v_line ->> 'product_id',v_line ->> 'name',
      (v_line ->> 'quantity')::integer,(v_line ->> 'unit_price_cents')::integer
    );
  end loop;

  insert into public.checkout_attempts(reservation_id,reservation_version,order_id)
    values (v_reservation_id,p_version,v_order_id)
    returning id, checkout_attempts.idempotency_key into v_attempt_id, v_idempotency_key;

  if p_allocation_id is not null then
    update public.ticket_allocations set status = 'checkout_started' where id = p_allocation_id;
  end if;

  return query select v_reservation_id,v_order_id,v_attempt_id,v_idempotency_key;
end;
$$;

create or replace function public.skie_link_stripe_session(
  p_checkout_attempt_id uuid,
  p_stripe_session_id text,
  p_provider_expires_at timestamptz
)
returns public.checkout_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.checkout_attempts;
begin
  select * into v_attempt from public.checkout_attempts where id = p_checkout_attempt_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'CHECKOUT_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.stripe_checkout_session_id is not null then
    if v_attempt.stripe_checkout_session_id <> p_stripe_session_id then
      raise exception using errcode = '23505', message = 'CHECKOUT_SESSION_ALREADY_LINKED';
    end if;
    return v_attempt;
  end if;
  if v_attempt.status <> 'creating_session' then
    raise exception using errcode = 'P0001', message = 'CHECKOUT_ATTEMPT_NOT_LINKABLE';
  end if;
  if not exists(
    select 1 from public.reservations reservation
    where reservation.id = v_attempt.reservation_id and reservation.status = 'reserved'
  ) then
    raise exception using errcode = 'P0001', message = 'RESERVATION_NOT_LINKABLE';
  end if;
  update public.checkout_attempts
    set stripe_checkout_session_id = p_stripe_session_id,
        provider_expires_at = p_provider_expires_at,
        status = 'session_active'
    where id = p_checkout_attempt_id
    returning * into v_attempt;
  update public.reservations set status = 'session_active' where id = v_attempt.reservation_id;
  update public.orders set status = 'checkout_pending' where reservation_id = v_attempt.reservation_id;
  return v_attempt;
end;
$$;

create or replace function public.skie_upsert_ticket_allocation(
  p_id text,
  p_customer_id uuid,
  p_event_id text,
  p_ticket_type_id text,
  p_max_quantity integer,
  p_price_cents integer,
  p_expires_at timestamptz,
  p_approved_by uuid,
  p_approved_at timestamptz
)
returns public.ticket_allocations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allocation public.ticket_allocations;
  v_active boolean;
begin
  select * into v_allocation from public.ticket_allocations where id = p_id for update;
  if found then
    select exists(
      select 1 from public.reservations reservation
      where reservation.allocation_id = p_id
        and reservation.status in ('reserved','session_active','payment_received','fulfilment_pending','paid_unfulfilled')
    ) into v_active;
    if v_active then
      if v_allocation.customer_id = p_customer_id
        and v_allocation.event_id = p_event_id
        and v_allocation.ticket_type_id = p_ticket_type_id
        and v_allocation.max_quantity = p_max_quantity
        and v_allocation.price_cents = p_price_cents
        and v_allocation.expires_at = p_expires_at then
        return v_allocation;
      end if;
      raise exception using errcode = 'P0001', message = 'ACTIVE_CHECKOUT_CONFLICT';
    end if;
    update public.ticket_allocations
      set customer_id = p_customer_id,event_id = p_event_id,ticket_type_id = p_ticket_type_id,
          max_quantity = p_max_quantity,price_cents = p_price_cents,expires_at = p_expires_at,
          approved_by = p_approved_by,approved_at = p_approved_at,status = 'unlocked',version = version + 1
      where id = p_id returning * into v_allocation;
    return v_allocation;
  end if;
  insert into public.ticket_allocations(
    id,customer_id,event_id,ticket_type_id,max_quantity,price_cents,status,
    expires_at,approved_by,approved_at
  ) values (
    p_id,p_customer_id,p_event_id,p_ticket_type_id,p_max_quantity,p_price_cents,'unlocked',
    p_expires_at,p_approved_by,p_approved_at
  ) returning * into v_allocation;
  return v_allocation;
end;
$$;

create or replace function public.skie_mutate_ticket_allocation(
  p_id text,
  p_action text,
  p_expires_at timestamptz default null
)
returns public.ticket_allocations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allocation public.ticket_allocations;
  v_has_active_session boolean;
  v_now timestamptz := now();
begin
  select * into v_allocation from public.ticket_allocations where id = p_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ALLOCATION_NOT_FOUND'; end if;
  if p_action not in ('extend','unlock','cancel') then
    raise exception using errcode = '22023', message = 'INVALID_ALLOCATION_ACTION'; end if;
  select exists(
    select 1 from public.reservations reservation
    join public.checkout_attempts attempt on attempt.reservation_id = reservation.id
    where reservation.allocation_id = p_id
      and reservation.status in ('session_active','payment_received','fulfilment_pending','paid_unfulfilled')
      and attempt.status in ('session_active','payment_received','fulfilled','manual_review','recovery_failed')
  ) into v_has_active_session;
  if v_has_active_session then
    raise exception using errcode = 'P0001', message = 'ACTIVE_CHECKOUT_CONFLICT';
  end if;
  if p_action in ('extend','unlock') and exists(
    select 1 from public.reservations reservation
    where reservation.allocation_id = p_id and reservation.status = 'reserved'
  ) then raise exception using errcode = 'P0001', message = 'CHECKOUT_CREATION_CONFLICT'; end if;
  if p_action = 'cancel' then
    update public.reservations set status = 'cancelled'
      where allocation_id = p_id and status in ('reserved','session_active');
    update public.orders set status = 'cancelled'
      where allocation_id = p_id and status in ('reserved','checkout_pending');
    update public.ticket_allocations set status = 'cancelled',version = version + 1 where id = p_id returning * into v_allocation;
  elsif p_action = 'extend' then
    if p_expires_at is null or p_expires_at <= v_now then
      raise exception using errcode = '22023', message = 'INVALID_ALLOCATION_EXPIRY'; end if;
    update public.ticket_allocations set status = 'unlocked',expires_at = p_expires_at,version = version + 1
      where id = p_id returning * into v_allocation;
  else
    update public.ticket_allocations set status = 'unlocked',version = version + 1
      where id = p_id returning * into v_allocation;
  end if;
  return v_allocation;
end;
$$;

create or replace function public.skie_record_stripe_webhook(
  p_stripe_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_provider_created_at timestamptz,
  p_api_version text default null,
  p_object_id text default null,
  p_checkout_session_id text default null,
  p_payment_intent_id text default null,
  p_charge_id text default null,
  p_refund_id text default null,
  p_dispute_id text default null,
  p_correlation_id uuid default gen_random_uuid()
)
returns table(inserted boolean, status text, correlation_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with row_insert as (
    insert into public.stripe_webhook_events(
      stripe_event_id,event_type,livemode,api_version,object_id,checkout_session_id,
      payment_intent_id,charge_id,refund_id,dispute_id,provider_created_at,correlation_id
    ) values (
      p_stripe_event_id,p_event_type,p_livemode,p_api_version,p_object_id,p_checkout_session_id,
      p_payment_intent_id,p_charge_id,p_refund_id,p_dispute_id,p_provider_created_at,p_correlation_id
    ) on conflict (stripe_event_id) do nothing
    returning true as inserted, stripe_webhook_events.status, stripe_webhook_events.correlation_id
  )
  select * from row_insert
  union all
  select false, event.status, event.correlation_id
    from public.stripe_webhook_events event
    where event.stripe_event_id = p_stripe_event_id and not exists (select 1 from row_insert)
  limit 1;
end;
$$;

create or replace function public.skie_claim_stripe_webhook(p_lease_seconds integer default 60)
returns setof public.stripe_webhook_events
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select stripe_event_id
    from public.stripe_webhook_events
    where status in ('received','temporary_failure')
      and next_attempt_at <= now()
      and (lease_expires_at is null or lease_expires_at <= now())
    order by provider_created_at, received_at
    for update skip locked
    limit 1
  )
  update public.stripe_webhook_events event
    set status = 'processing',
        processing_attempts = event.processing_attempts + 1,
        lease_expires_at = now() + make_interval(secs => greatest(10, least(p_lease_seconds, 300)))
    from candidate
    where event.stripe_event_id = candidate.stripe_event_id
    returning event.*;
end;
$$;

create or replace function public.skie_record_payment_received(
  p_stripe_event_id text,
  p_stripe_session_id text,
  p_payment_intent_id text,
  p_amount_cents integer,
  p_currency text,
  p_provider_created_at timestamptz,
  p_metadata_order_id text,
  p_client_reference_order_id text
)
returns table(reservation_id uuid, order_id uuid, duplicate boolean, failure_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.checkout_attempts;
  v_reservation public.reservations;
  v_order public.orders;
  v_duplicate boolean := false;
begin
  select * into v_attempt from public.checkout_attempts
    where stripe_checkout_session_id = p_stripe_session_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ORPHAN_STRIPE_SESSION'; end if;
  select * into v_reservation from public.reservations where id = v_attempt.reservation_id for update;
  select * into v_order from public.orders ordered where ordered.reservation_id = v_reservation.id for update;
  if p_metadata_order_id is null or p_client_reference_order_id is null
    or p_metadata_order_id <> v_order.id::text or p_client_reference_order_id <> v_order.id::text then
    update public.reservations set status = 'manual_review', failure_code = 'PAYMENT_ORDER_REFERENCE_MISMATCH' where id = v_reservation.id;
    update public.orders set status = 'manual_review' where id = v_order.id;
    update public.checkout_attempts set status = 'manual_review',failure_code = 'PAYMENT_ORDER_REFERENCE_MISMATCH' where id = v_attempt.id;
    return query select v_reservation.id,v_order.id,false,'PAYMENT_ORDER_REFERENCE_MISMATCH'::text;
    return;
  end if;
  if p_amount_cents <> v_reservation.expected_total_cents or upper(p_currency) <> v_reservation.currency then
    update public.reservations set status = 'manual_review', failure_code = 'PAYMENT_AMOUNT_MISMATCH' where id = v_reservation.id;
    update public.orders set status = 'manual_review' where id = v_order.id;
    update public.checkout_attempts set status = 'manual_review',failure_code = 'PAYMENT_AMOUNT_MISMATCH' where id = v_attempt.id;
    return query select v_reservation.id,v_order.id,false,'PAYMENT_AMOUNT_MISMATCH'::text;
    return;
  end if;
  if v_attempt.stripe_payment_intent_id is not null and v_attempt.stripe_payment_intent_id <> p_payment_intent_id then
    update public.reservations set status = 'manual_review', failure_code = 'PAYMENT_INTENT_MISMATCH' where id = v_reservation.id;
    update public.orders set status = 'manual_review' where id = v_order.id;
    update public.checkout_attempts set status = 'manual_review',failure_code = 'PAYMENT_INTENT_MISMATCH' where id = v_attempt.id;
    return query select v_reservation.id,v_order.id,false,'PAYMENT_INTENT_MISMATCH'::text;
    return;
  end if;
  if exists(select 1 from public.payments where stripe_payment_intent_id = p_payment_intent_id) then
    v_duplicate := true;
  else
    insert into public.payments(
      order_id,checkout_attempt_id,provider,status,stripe_checkout_session_id,
      stripe_payment_intent_id,amount_cents,currency,provider_created_at
    ) values (
      v_order.id,v_attempt.id,'stripe','payment_received',p_stripe_session_id,
      p_payment_intent_id,p_amount_cents,v_reservation.currency,p_provider_created_at
    );
  end if;
  update public.checkout_attempts set stripe_payment_intent_id = p_payment_intent_id, status = 'payment_received' where id = v_attempt.id;
  update public.reservations set status = 'payment_received', failure_code = null where id = v_reservation.id;
  update public.orders set status = 'payment_received', paid_at = coalesce(p_provider_created_at,now()) where id = v_order.id;
  update public.stripe_webhook_events set status = 'processing' where stripe_event_id = p_stripe_event_id;
  return query select v_reservation.id,v_order.id,v_duplicate,null::text;
end;
$$;

create or replace function public.skie_mark_paid_unfulfilled(
  p_reservation_id uuid,
  p_safe_error_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reservations set status = 'paid_unfulfilled', failure_code = left(p_safe_error_code,120) where id = p_reservation_id;
  update public.orders set status = 'paid_unfulfilled' where reservation_id = p_reservation_id;
end;
$$;

create or replace function public.skie_record_offline_payment(
  p_order_id uuid,
  p_provider text,
  p_provider_reference text
)
returns table(reservation_id uuid, order_id uuid, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_attempt public.checkout_attempts;
  v_duplicate boolean;
begin
  if p_provider not in ('test','free') then
    raise exception using errcode = '22023', message = 'INVALID_OFFLINE_PROVIDER';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ORDER_NOT_FOUND'; end if;
  if p_provider = 'free' and v_order.total_cents <> 0 then
    raise exception using errcode = 'P0001', message = 'FREE_ORDER_AMOUNT_INVALID';
  end if;
  select * into v_attempt from public.checkout_attempts attempt where attempt.order_id = v_order.id for update;
  select exists(
    select 1 from public.payments where provider = p_provider and provider_reference = p_provider_reference
  ) into v_duplicate;
  if not v_duplicate then
    insert into public.payments(
      order_id,checkout_attempt_id,provider,provider_reference,status,amount_cents,currency,provider_created_at
    ) values (
      v_order.id,v_attempt.id,p_provider,p_provider_reference,'payment_received',v_order.total_cents,v_order.currency,now()
    );
  end if;
  update public.checkout_attempts set status = 'payment_received' where id = v_attempt.id;
  update public.reservations set status = 'payment_received',failure_code = null where id = v_order.reservation_id;
  update public.orders set status = 'payment_received',paid_at = coalesce(paid_at,now()) where id = v_order.id;
  return query select v_order.reservation_id,v_order.id,v_duplicate;
end;
$$;

create or replace function public.skie_fulfil_payment(
  p_reservation_id uuid,
  p_tickets jsonb,
  p_entitlements jsonb default '[]'::jsonb
)
returns table(order_id uuid, ticket_count integer, entitlement_count integer, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations;
  v_order public.orders;
  v_expected_tickets integer;
  v_ticket jsonb;
  v_entitlement jsonb;
  v_order_line public.order_lines;
  v_ticket_count integer;
  v_entitlement_count integer;
begin
  select * into v_reservation from public.reservations where id = p_reservation_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND'; end if;
  select * into v_order from public.orders where reservation_id = p_reservation_id for update;
  if v_reservation.status = 'fulfilled' and v_order.status = 'fulfilled' then
    select count(*)::integer into v_ticket_count from public.tickets where tickets.order_id = v_order.id;
    select count(*)::integer into v_entitlement_count from public.entitlements where entitlements.order_id = v_order.id;
    return query select v_order.id,v_ticket_count,v_entitlement_count,true;
    return;
  end if;
  if v_reservation.status not in ('payment_received','fulfilment_pending','paid_unfulfilled') then
    raise exception using errcode = 'P0001', message = 'RESERVATION_NOT_PAID';
  end if;
  select coalesce(sum(quantity),0)::integer into v_expected_tickets
    from public.reservation_ticket_lines where reservation_id = p_reservation_id;
  if jsonb_typeof(p_tickets) <> 'array' or jsonb_array_length(p_tickets) <> v_expected_tickets then
    raise exception using errcode = '22023', message = 'TICKET_COUNT_MISMATCH';
  end if;

  update public.reservations set status = 'fulfilment_pending', failure_code = null where id = p_reservation_id;
  update public.orders set status = 'fulfilment_pending' where id = v_order.id;

  for v_ticket in select value from jsonb_array_elements(p_tickets)
  loop
    select * into v_order_line from public.order_lines line
      where line.order_id = v_order.id and line.kind = 'ticket' and line.reference_id = v_ticket ->> 'ticket_type_id';
    if not found then raise exception using errcode = '22023', message = 'TICKET_LINE_NOT_FOUND'; end if;
    insert into public.tickets(
      id,order_id,order_line_id,event_id,customer_id,ticket_type_id,ticket_code,
      token_hash,token_preview,holder_name,status
    ) values (
      (v_ticket ->> 'id')::uuid,v_order.id,v_order_line.id,v_order.event_id,v_order.customer_id,
      v_ticket ->> 'ticket_type_id',v_ticket ->> 'ticket_code',v_ticket ->> 'token_hash',
      left(v_ticket ->> 'token_preview',12),v_ticket ->> 'holder_name','valid'
    ) on conflict (id) do nothing;
  end loop;

  for v_entitlement in select value from jsonb_array_elements(p_entitlements)
  loop
    select * into v_order_line from public.order_lines line
      where line.order_id = v_order.id and line.kind = 'product' and line.reference_id = v_entitlement ->> 'product_id';
    if not found then raise exception using errcode = '22023', message = 'PRODUCT_LINE_NOT_FOUND'; end if;
    insert into public.entitlements(
      id,order_id,order_line_id,event_id,customer_id,product_id,name,
      quantity_total,quantity_remaining,status
    ) values (
      (v_entitlement ->> 'id')::uuid,v_order.id,v_order_line.id,v_order.event_id,v_order.customer_id,
      v_entitlement ->> 'product_id',v_entitlement ->> 'name',
      (v_entitlement ->> 'quantity_total')::integer,(v_entitlement ->> 'quantity_total')::integer,'active'
    ) on conflict (id) do nothing;
  end loop;

  select count(*)::integer into v_ticket_count from public.tickets where tickets.order_id = v_order.id;
  if v_ticket_count <> v_expected_tickets then
    raise exception using errcode = 'P0001', message = 'TICKET_FULFILMENT_INCOMPLETE';
  end if;
  select count(*)::integer into v_entitlement_count from public.entitlements where entitlements.order_id = v_order.id;
  update public.payments set status = 'paid' where payments.order_id = v_order.id;
  update public.checkout_attempts set status = 'fulfilled' where reservation_id = p_reservation_id;
  update public.reservations set status = 'fulfilled' where id = p_reservation_id;
  update public.orders set status = 'fulfilled', fulfilled_at = now() where id = v_order.id;
  if v_order.allocation_id is not null then
    update public.ticket_allocations allocation
      set purchased_quantity = allocation.purchased_quantity + v_expected_tickets,
          status = 'ticket_issued'
      where id = v_order.allocation_id;
  end if;
  return query select v_order.id,v_ticket_count,v_entitlement_count,false;
end;
$$;

create or replace function public.skie_check_in(
  p_ticket_id uuid,
  p_token_hash text,
  p_expected_event_id text,
  p_actor_id uuid,
  p_notes text default ''
)
returns table(result text, ticket_status text, checked_in_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.tickets;
  v_role public.user_role;
  v_result text;
begin
  select role into v_role from public.profiles where id = p_actor_id;
  if v_role not in ('admin','super_admin') and not exists(
    select 1 from public.event_staff_assignments
    where user_id = p_actor_id and event_id = p_expected_event_id and active
      and role in ('scanner_only','door_staff','event_admin')
  ) then raise exception using errcode = '42501', message = 'EVENT_ASSIGNMENT_REQUIRED'; end if;
  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found then v_result := 'invalid';
  elsif v_ticket.token_hash <> p_token_hash then v_result := 'invalid';
  elsif v_ticket.event_id <> p_expected_event_id then v_result := 'wrong_event';
  elsif v_ticket.status = 'checked_in' then v_result := 'already_checked_in';
  elsif v_ticket.status <> 'valid' then v_result := v_ticket.status;
  else
    v_result := 'valid';
    update public.tickets set status = 'checked_in', checked_in_at = now(), checked_in_by = p_actor_id where id = p_ticket_id returning * into v_ticket;
  end if;
  if found then
    insert into public.check_ins(ticket_id,event_id,scanned_by,result,notes)
      values (p_ticket_id,p_expected_event_id,p_actor_id,v_result,left(coalesce(p_notes,''),1000));
  end if;
  return query select v_result,v_ticket.status,v_ticket.checked_in_at;
end;
$$;

create or replace function public.skie_redeem_entitlement(
  p_entitlement_id uuid,
  p_expected_event_id text,
  p_quantity integer,
  p_actor_id uuid,
  p_idempotency_key uuid
)
returns public.entitlements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entitlement public.entitlements;
  v_role public.user_role;
begin
  select role into v_role from public.profiles where id = p_actor_id;
  if v_role not in ('admin','super_admin') and not exists(
    select 1 from public.event_staff_assignments
    where user_id = p_actor_id and event_id = p_expected_event_id and active
      and role in ('door_staff','event_admin')
  ) then raise exception using errcode = '42501', message = 'EVENT_ASSIGNMENT_REQUIRED'; end if;
  if exists(select 1 from public.entitlement_redemptions where idempotency_key = p_idempotency_key) then
    select entitlement.* into v_entitlement from public.entitlements entitlement where id = p_entitlement_id;
    return v_entitlement;
  end if;
  select * into v_entitlement from public.entitlements where id = p_entitlement_id for update;
  if not found or v_entitlement.event_id <> p_expected_event_id then
    raise exception using errcode = 'P0002', message = 'ENTITLEMENT_NOT_FOUND';
  end if;
  if v_entitlement.status <> 'active' or p_quantity < 1 or p_quantity > v_entitlement.quantity_remaining then
    raise exception using errcode = 'P0001', message = 'ENTITLEMENT_NOT_REDEEMABLE';
  end if;
  update public.entitlements
    set quantity_remaining = quantity_remaining - p_quantity,
        status = case when quantity_remaining - p_quantity = 0 then 'redeemed' else 'active' end
    where id = p_entitlement_id returning * into v_entitlement;
  insert into public.entitlement_redemptions(entitlement_id,event_id,quantity,redeemed_by,idempotency_key)
    values (p_entitlement_id,p_expected_event_id,p_quantity,p_actor_id,p_idempotency_key);
  return v_entitlement;
end;
$$;

create or replace function public.skie_claim_notification(
  p_channel text,
  p_lease_seconds integer default 60
)
returns setof public.notification_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select id from public.notification_outbox
    where channel = p_channel
      and status in ('queued','temporary_failure')
      and available_at <= now()
      and attempt_count < max_attempts
      and (lease_expires_at is null or lease_expires_at <= now())
    order by available_at,id
    for update skip locked limit 1
  )
  update public.notification_outbox item
    set status = 'claimed',attempt_count = item.attempt_count + 1,
        lease_expires_at = now() + make_interval(secs => greatest(10,least(p_lease_seconds,300)))
    from candidate where item.id = candidate.id returning item.*;
end;
$$;

create or replace function public.skie_claim_promo_usage(
  p_promo_code_id uuid,
  p_reservation_id uuid,
  p_order_id uuid,
  p_customer_id uuid,
  p_event_id text,
  p_ticket_units integer,
  p_original_subtotal_cents integer,
  p_discount_cents integer,
  p_final_total_cents integer,
  p_reserved_until timestamptz
)
returns public.promo_redemptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_promo public.promo_codes;
  v_redemption public.promo_redemptions;
  v_uses integer;
  v_units integer;
  v_customer_uses integer;
begin
  select * into v_promo from public.promo_codes where id = p_promo_code_id for update;
  if not found or not v_promo.active or v_promo.status <> 'active'
    or (v_promo.valid_from is not null and v_promo.valid_from > now())
    or (v_promo.expires_at is not null and v_promo.expires_at <= now()) then
    raise exception using errcode = 'P0001', message = 'PROMO_NOT_AVAILABLE';
  end if;
  update public.promo_redemptions set status = 'released',released_at = now()
    where promo_code_id = p_promo_code_id and status = 'reserved' and reserved_until <= now();
  select count(*)::integer,coalesce(sum(discounted_ticket_units),0)::integer
    into v_uses,v_units from public.promo_redemptions
    where promo_code_id = p_promo_code_id and status in ('reserved','finalized','refunded','disputed');
  select count(*)::integer into v_customer_uses from public.promo_redemptions
    where promo_code_id = p_promo_code_id and customer_id = p_customer_id
      and status in ('reserved','finalized','refunded','disputed');
  if v_promo.max_redemptions is not null and v_uses >= v_promo.max_redemptions then
    raise exception using errcode = 'P0001', message = 'PROMO_REDEMPTION_LIMIT'; end if;
  if v_promo.max_discounted_ticket_units is not null and v_units + p_ticket_units > v_promo.max_discounted_ticket_units then
    raise exception using errcode = 'P0001', message = 'PROMO_TICKET_UNIT_LIMIT'; end if;
  if v_promo.max_uses_per_customer is not null and v_customer_uses >= v_promo.max_uses_per_customer then
    raise exception using errcode = 'P0001', message = 'PROMO_CUSTOMER_LIMIT'; end if;
  insert into public.promo_redemptions(
    promo_code_id,reservation_id,order_id,customer_id,event_id,status,
    discounted_ticket_units,original_subtotal_cents,discount_cents,final_total_cents,reserved_until
  ) values (
    p_promo_code_id,p_reservation_id,p_order_id,p_customer_id,p_event_id,'reserved',
    p_ticket_units,p_original_subtotal_cents,p_discount_cents,p_final_total_cents,p_reserved_until
  ) returning * into v_redemption;
  return v_redemption;
end;
$$;

create or replace function public.skie_mark_webhook_result(
  p_stripe_event_id text,
  p_status text,
  p_safe_error_code text default null,
  p_retry_after_seconds integer default 60
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('processed','temporary_failure','permanent_failure','manual_review') then
    raise exception using errcode = '22023', message = 'INVALID_WEBHOOK_STATUS';
  end if;
  update public.stripe_webhook_events
    set status = p_status,
        safe_error_code = left(p_safe_error_code,120),
        next_attempt_at = case when p_status = 'temporary_failure'
          then now() + make_interval(secs => greatest(10,least(p_retry_after_seconds,86400)))
          else next_attempt_at end,
        lease_expires_at = null,
        processed_at = case when p_status = 'processed' then now() else processed_at end
    where stripe_event_id = p_stripe_event_id;
  if not found then raise exception using errcode = 'P0002', message = 'WEBHOOK_EVENT_NOT_FOUND'; end if;
end;
$$;

create or replace function public.skie_expire_checkout_session(
  p_stripe_session_id text,
  p_result text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.checkout_attempts;
begin
  if p_result not in ('expired','failed','orphan','manual_review') then
    raise exception using errcode = '22023', message = 'INVALID_SESSION_RESULT';
  end if;
  select * into v_attempt from public.checkout_attempts
    where stripe_checkout_session_id = p_stripe_session_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'CHECKOUT_ATTEMPT_NOT_FOUND'; end if;
  if v_attempt.status in ('payment_received','fulfilled') then return; end if;
  update public.checkout_attempts
    set status = case p_result when 'expired' then 'session_expired' when 'failed' then 'session_failed'
      when 'orphan' then 'orphan_session' else 'manual_review' end
    where id = v_attempt.id;
  update public.reservations set status = case when p_result = 'expired' then 'expired'
      when p_result = 'failed' then 'failed' else 'manual_review' end
    where id = v_attempt.reservation_id and status in ('reserved','session_active');
  update public.orders set status = case when p_result = 'expired' then 'expired'
      when p_result = 'failed' then 'failed' else 'manual_review' end
    where reservation_id = v_attempt.reservation_id and status in ('reserved','checkout_pending');
  update public.promo_redemptions set status = 'released',released_at = now()
    where reservation_id = v_attempt.reservation_id and status = 'reserved';
  update public.ticket_allocations allocation
    set status = case when allocation.expires_at <= now() then 'expired' else 'unlocked' end
    from public.reservations reservation
    where reservation.id = v_attempt.reservation_id
      and allocation.id = reservation.allocation_id
      and allocation.status = 'checkout_started';
end;
$$;

create or replace function public.skie_apply_refund(
  p_payment_intent_id text,
  p_refund_id text,
  p_refund_status text,
  p_amount_cents integer,
  p_currency text,
  p_provider_created_at timestamptz,
  p_line_attribution jsonb default null
)
returns table(order_id uuid, resulting_status text, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments;
  v_order public.orders;
  v_adjustment public.payment_adjustments;
  v_total_refunded integer;
  v_item jsonb;
  v_line public.order_lines;
  v_duplicate boolean := false;
begin
  select * into v_payment from public.payments where stripe_payment_intent_id = p_payment_intent_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'PAYMENT_NOT_FOUND'; end if;
  select * into v_order from public.orders where id = v_payment.order_id for update;
  select * into v_adjustment from public.payment_adjustments where provider_object_id = p_refund_id;
  if found and v_adjustment.status = p_refund_status then
    v_duplicate := true;
    return query select v_order.id,v_order.status,v_duplicate;
    return;
  end if;
  if upper(p_currency) <> v_payment.currency or p_amount_cents < 0 or p_amount_cents > v_payment.amount_cents then
    raise exception using errcode = 'P0001', message = 'REFUND_AMOUNT_MISMATCH';
  end if;
  if p_refund_status not in ('pending','succeeded','failed') then
    raise exception using errcode = '22023', message = 'INVALID_REFUND_STATUS';
  end if;
  if v_adjustment.id is not null then
    update public.payment_adjustments
      set status = p_refund_status,line_attribution = coalesce(p_line_attribution,line_attribution),updated_at = now()
      where id = v_adjustment.id;
  else
    insert into public.payment_adjustments(
      payment_id,order_id,kind,provider_object_id,status,amount_cents,currency,line_attribution,provider_created_at
    ) values (
      v_payment.id,v_order.id,'refund',p_refund_id,p_refund_status,p_amount_cents,v_payment.currency,p_line_attribution,p_provider_created_at
    );
  end if;
  if p_refund_status = 'failed' then
    return query select v_order.id,v_order.status,false;
    return;
  elsif p_refund_status = 'pending' then
    update public.payments set status = 'refund_pending' where id = v_payment.id;
    update public.orders set status = 'refund_pending' where id = v_order.id;
    update public.reservations set status = 'refund_pending' where id = v_order.reservation_id;
    return query select v_order.id,'refund_pending',false;
    return;
  end if;

  select coalesce(sum(amount_cents),0)::integer into v_total_refunded
    from public.payment_adjustments
    where payment_id = v_payment.id and kind = 'refund' and status = 'succeeded';
  update public.payments set refunded_cents = v_total_refunded where id = v_payment.id;
  update public.orders set refunded_cents = v_total_refunded where id = v_order.id;

  if v_total_refunded >= v_payment.amount_cents then
    update public.payments set status = 'refunded' where id = v_payment.id;
    update public.orders set status = 'refunded' where id = v_order.id;
    update public.reservations set status = 'refunded' where id = v_order.reservation_id;
    update public.tickets set status = 'refunded' where tickets.order_id = v_order.id and status <> 'refunded';
    update public.entitlements set status = 'refunded' where entitlements.order_id = v_order.id and status <> 'refunded';
    update public.promo_redemptions set status = 'refunded' where promo_redemptions.order_id = v_order.id and status = 'finalized';
    return query select v_order.id,'refunded',false;
    return;
  end if;

  if p_line_attribution is null or jsonb_typeof(p_line_attribution) <> 'array' then
    update public.payments set status = 'manual_review' where id = v_payment.id;
    update public.orders set status = 'manual_review' where id = v_order.id;
    update public.reservations set status = 'manual_review',failure_code = 'UNATTRIBUTABLE_PARTIAL_REFUND' where id = v_order.reservation_id;
    return query select v_order.id,'manual_review',false;
    return;
  end if;

  for v_item in select value from jsonb_array_elements(p_line_attribution)
  loop
    select * into v_line from public.order_lines
      where id = (v_item ->> 'order_line_id')::uuid and order_lines.order_id = v_order.id for update;
    if not found then raise exception using errcode = '22023', message = 'REFUND_LINE_NOT_FOUND'; end if;
    if coalesce((v_item ->> 'quantity')::integer,0) < 0
      or coalesce((v_item ->> 'amount_cents')::integer,-1) < 0 then
      raise exception using errcode = '22023', message = 'INVALID_REFUND_ATTRIBUTION'; end if;
    update public.order_lines
      set refunded_quantity = refunded_quantity + (v_item ->> 'quantity')::integer,
          refunded_cents = refunded_cents + (v_item ->> 'amount_cents')::integer
      where id = v_line.id;
    if v_line.kind = 'ticket' and v_item ? 'ticket_ids' then
      update public.tickets set status = 'refunded'
        where tickets.order_id = v_order.id and id in (
          select value::text::uuid from jsonb_array_elements_text(v_item -> 'ticket_ids')
        );
    elsif v_line.kind = 'product' and v_item ? 'entitlement_ids' then
      update public.entitlements set status = 'refunded'
        where entitlements.order_id = v_order.id and id in (
          select value::text::uuid from jsonb_array_elements_text(v_item -> 'entitlement_ids')
        );
    end if;
  end loop;
  update public.payments set status = 'partially_refunded' where id = v_payment.id;
  update public.orders set status = 'partially_refunded' where id = v_order.id;
  update public.reservations set status = 'partially_refunded' where id = v_order.reservation_id;
  return query select v_order.id,'partially_refunded',false;
end;
$$;

create or replace function public.skie_mark_payment_intent_terminal(
  p_payment_intent_id text,
  p_result text
)
returns table(order_id uuid, resulting_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments;
  v_order public.orders;
begin
  if p_result not in ('failed','cancelled') then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_RESULT';
  end if;
  select * into v_payment from public.payments where stripe_payment_intent_id = p_payment_intent_id for update;
  if not found then
    select orders.* into v_order
      from public.checkout_attempts
      join public.orders on orders.id = checkout_attempts.order_id
      where checkout_attempts.stripe_payment_intent_id = p_payment_intent_id
      for update of orders;
  else
    select * into v_order from public.orders where id = v_payment.order_id for update;
  end if;
  if v_order.id is null then raise exception using errcode = 'P0002', message = 'PAYMENT_NOT_FOUND'; end if;
  if v_order.status in ('fulfilled','refunded','partially_refunded','disputed','suspended') then
    return query select v_order.id,v_order.status;
    return;
  end if;
  update public.orders set status = p_result where id = v_order.id;
  update public.reservations set status = p_result where id = v_order.reservation_id
    and status in ('reserved','session_active','payment_received','fulfilment_pending');
  update public.checkout_attempts attempt set status = 'session_failed',failure_code = 'PAYMENT_INTENT_' || upper(p_result)
    where attempt.order_id = v_order.id and attempt.status <> 'fulfilled';
  update public.payments set status = p_result where id = v_payment.id;
  update public.promo_redemptions redemption set status = 'released',released_at = now()
    where redemption.order_id = v_order.id and redemption.status = 'reserved';
  return query select v_order.id,p_result;
end;
$$;

create or replace function public.skie_mark_recovery_resolved(p_reservation_id uuid)
returns table(order_id uuid, resulting_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_expected integer;
  v_actual integer;
begin
  select * into v_order from public.orders where reservation_id = p_reservation_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ORDER_NOT_FOUND'; end if;
  select coalesce(sum(quantity),0)::integer into v_expected
    from public.reservation_ticket_lines where reservation_id = p_reservation_id;
  select count(*)::integer into v_actual from public.tickets where tickets.order_id = v_order.id;
  if v_expected < 1 or v_actual <> v_expected or not exists(
    select 1 from public.payments where payments.order_id = v_order.id and status in ('paid','payment_received')
  ) then
    raise exception using errcode = 'P0001', message = 'RECOVERY_NOT_PROVABLY_FULFILLED';
  end if;
  update public.payments set status = 'paid' where payments.order_id = v_order.id and status = 'payment_received';
  update public.checkout_attempts set status = 'fulfilled',failure_code = null where checkout_attempts.order_id = v_order.id;
  update public.reservations set status = 'fulfilled',failure_code = null where id = p_reservation_id;
  update public.orders set status = 'fulfilled',fulfilled_at = coalesce(fulfilled_at,now()) where id = v_order.id;
  return query select v_order.id,'fulfilled'::text;
end;
$$;

create or replace function public.skie_apply_dispute(
  p_payment_intent_id text,
  p_dispute_id text,
  p_dispute_status text,
  p_amount_cents integer,
  p_currency text,
  p_provider_created_at timestamptz
)
returns table(order_id uuid, resulting_status text, duplicate boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments;
  v_order public.orders;
  v_existing public.payment_adjustments;
begin
  select * into v_payment from public.payments where stripe_payment_intent_id = p_payment_intent_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'PAYMENT_NOT_FOUND'; end if;
  select * into v_order from public.orders where id = v_payment.order_id for update;
  select * into v_existing from public.payment_adjustments where provider_object_id = p_dispute_id for update;
  if found and v_existing.status = p_dispute_status then
    return query select v_order.id,v_order.status,true;
    return;
  end if;
  if upper(p_currency) <> v_payment.currency or p_amount_cents <> v_payment.amount_cents
    or p_dispute_status not in ('needs_response','won','lost','closed') then
    raise exception using errcode = 'P0001', message = 'INVALID_DISPUTE';
  end if;
  insert into public.payment_adjustments(
    payment_id,order_id,kind,provider_object_id,status,amount_cents,currency,provider_created_at
  ) values (
    v_payment.id,v_order.id,'dispute',p_dispute_id,p_dispute_status,p_amount_cents,v_payment.currency,p_provider_created_at
  ) on conflict (provider_object_id) do update set status = excluded.status,updated_at = now();
  if p_dispute_status = 'needs_response' then
    update public.tickets set status_before_suspension = status,status = 'suspended'
      where tickets.order_id = v_order.id and status not in ('cancelled','refunded','expired','suspended');
    update public.entitlements set status_before_suspension = status,status = 'suspended'
      where entitlements.order_id = v_order.id and status not in ('cancelled','refunded','suspended');
    update public.payments set status = 'disputed' where id = v_payment.id;
    update public.orders set status = 'disputed' where id = v_order.id;
    update public.reservations set status = 'disputed' where id = v_order.reservation_id;
    update public.promo_redemptions set status = 'disputed' where promo_redemptions.order_id = v_order.id and status = 'finalized';
    return query select v_order.id,'disputed',false;
  elsif p_dispute_status = 'won' then
    update public.tickets set status = coalesce(status_before_suspension,'valid'),status_before_suspension = null
      where tickets.order_id = v_order.id and status = 'suspended';
    update public.entitlements set status = coalesce(status_before_suspension,'active'),status_before_suspension = null
      where entitlements.order_id = v_order.id and status = 'suspended';
    update public.payments set status = 'paid' where id = v_payment.id;
    update public.orders set status = 'fulfilled' where id = v_order.id;
    update public.reservations set status = 'fulfilled' where id = v_order.reservation_id;
    update public.promo_redemptions set status = 'finalized' where promo_redemptions.order_id = v_order.id and status = 'disputed';
    return query select v_order.id,'fulfilled',false;
  else
    update public.tickets set status = 'refunded',status_before_suspension = null where tickets.order_id = v_order.id;
    update public.entitlements set status = 'refunded',status_before_suspension = null where entitlements.order_id = v_order.id;
    update public.payments set status = 'refunded',refunded_cents = amount_cents where id = v_payment.id;
    update public.orders set status = 'refunded',refunded_cents = total_cents where id = v_order.id;
    update public.reservations set status = 'refunded' where id = v_order.reservation_id;
    update public.promo_redemptions set status = 'disputed' where promo_redemptions.order_id = v_order.id;
    return query select v_order.id,'refunded',false;
  end if;
end;
$$;

revoke all on function public.skie_reserve_checkout(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,integer,uuid,integer) from public, anon, authenticated;
revoke all on function public.skie_link_stripe_session(uuid,text,timestamptz) from public, anon, authenticated;
revoke all on function public.skie_upsert_ticket_allocation(text,uuid,text,text,integer,integer,timestamptz,uuid,timestamptz) from public, anon, authenticated;
revoke all on function public.skie_mutate_ticket_allocation(text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.skie_record_stripe_webhook(text,text,boolean,timestamptz,text,text,text,text,text,text,text,uuid) from public, anon, authenticated;
revoke all on function public.skie_claim_stripe_webhook(integer) from public, anon, authenticated;
revoke all on function public.skie_record_payment_received(text,text,text,integer,text,timestamptz,text,text) from public, anon, authenticated;
revoke all on function public.skie_mark_paid_unfulfilled(uuid,text) from public, anon, authenticated;
revoke all on function public.skie_record_offline_payment(uuid,text,text) from public, anon, authenticated;
revoke all on function public.skie_fulfil_payment(uuid,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.skie_check_in(uuid,text,text,uuid,text) from public, anon, authenticated;
revoke all on function public.skie_redeem_entitlement(uuid,text,integer,uuid,uuid) from public, anon, authenticated;
revoke all on function public.skie_claim_notification(text,integer) from public, anon, authenticated;
revoke all on function public.skie_claim_promo_usage(uuid,uuid,uuid,uuid,text,integer,integer,integer,integer,timestamptz) from public, anon, authenticated;
revoke all on function public.skie_mark_webhook_result(text,text,text,integer) from public, anon, authenticated;
revoke all on function public.skie_expire_checkout_session(text,text) from public, anon, authenticated;
revoke all on function public.skie_apply_refund(text,text,text,integer,text,timestamptz,jsonb) from public, anon, authenticated;
revoke all on function public.skie_mark_payment_intent_terminal(text,text) from public, anon, authenticated;
revoke all on function public.skie_mark_recovery_resolved(uuid) from public, anon, authenticated;
revoke all on function public.skie_apply_dispute(text,text,text,integer,text,timestamptz) from public, anon, authenticated;

grant execute on function public.skie_reserve_checkout(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,integer,uuid,integer) to service_role;
grant execute on function public.skie_link_stripe_session(uuid,text,timestamptz) to service_role;
grant execute on function public.skie_upsert_ticket_allocation(text,uuid,text,text,integer,integer,timestamptz,uuid,timestamptz) to service_role;
grant execute on function public.skie_mutate_ticket_allocation(text,text,timestamptz) to service_role;
grant execute on function public.skie_record_stripe_webhook(text,text,boolean,timestamptz,text,text,text,text,text,text,text,uuid) to service_role;
grant execute on function public.skie_claim_stripe_webhook(integer) to service_role;
grant execute on function public.skie_record_payment_received(text,text,text,integer,text,timestamptz,text,text) to service_role;
grant execute on function public.skie_mark_paid_unfulfilled(uuid,text) to service_role;
grant execute on function public.skie_record_offline_payment(uuid,text,text) to service_role;
grant execute on function public.skie_fulfil_payment(uuid,jsonb,jsonb) to service_role;
grant execute on function public.skie_check_in(uuid,text,text,uuid,text) to service_role;
grant execute on function public.skie_redeem_entitlement(uuid,text,integer,uuid,uuid) to service_role;
grant execute on function public.skie_claim_notification(text,integer) to service_role;
grant execute on function public.skie_claim_promo_usage(uuid,uuid,uuid,uuid,text,integer,integer,integer,integer,timestamptz) to service_role;
grant execute on function public.skie_mark_webhook_result(text,text,text,integer) to service_role;
grant execute on function public.skie_expire_checkout_session(text,text) to service_role;
grant execute on function public.skie_apply_refund(text,text,text,integer,text,timestamptz,jsonb) to service_role;
grant execute on function public.skie_mark_payment_intent_terminal(text,text) to service_role;
grant execute on function public.skie_mark_recovery_resolved(uuid) to service_role;
grant execute on function public.skie_apply_dispute(text,text,text,integer,text,timestamptz) to service_role;

commit;
