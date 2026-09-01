-- Persist the exact eligible-line discount allocation used to construct Stripe
-- Checkout. This prevents a product-only promo from appearing against a ticket
-- merely because the ticket was the first cart line.

begin;

alter table public.orders
  add column if not exists discount_allocation jsonb not null default '[]'::jsonb;

create or replace function public.skie_build_promo_discount_allocation(
  p_promo_code_id uuid,
  p_ticket_lines jsonb,
  p_product_lines jsonb,
  p_discount_cents integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_promo public.promo_codes%rowtype;
  v_restricted boolean := false;
  v_eligible_total integer := 0;
  v_remaining_eligible integer := 0;
  v_remaining_discount integer := coalesce(p_discount_cents,0);
  v_line record;
  v_line_discount integer;
  v_allocation jsonb := '[]'::jsonb;
begin
  if p_discount_cents is null or p_discount_cents < 0 then
    raise exception 'ORDER_DISCOUNT_ALLOCATION_INVALID';
  end if;
  if p_discount_cents = 0 then return v_allocation; end if;

  if p_promo_code_id is not null then
    select * into v_promo
    from public.promo_codes
    where id = p_promo_code_id;
    if not found then raise exception 'PROMO_NOT_FOUND'; end if;
    v_restricted := cardinality(v_promo.ticket_type_ids) > 0
      or cardinality(v_promo.product_ids) > 0;
  end if;

  with lines as (
    select
      'ticket'::text as kind,
      line ->> 'ticket_type_id' as reference_id,
      (line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer as line_cents,
      0 as line_group,
      ordinality::integer as line_order
    from jsonb_array_elements(coalesce(p_ticket_lines,'[]'::jsonb)) with ordinality as ticket(line,ordinality)
    union all
    select
      'product'::text,
      line ->> 'product_id',
      (line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer,
      1,
      ordinality::integer
    from jsonb_array_elements(coalesce(p_product_lines,'[]'::jsonb)) with ordinality as product(line,ordinality)
  )
  select coalesce(sum(line_cents),0)::integer into v_eligible_total
  from lines
  where line_cents > 0
    and (
      not v_restricted
      or (kind = 'ticket' and reference_id = any(v_promo.ticket_type_ids))
      or (kind = 'product' and reference_id = any(v_promo.product_ids))
    );

  if v_eligible_total <= 0 or p_discount_cents > v_eligible_total then
    raise exception 'ORDER_DISCOUNT_ALLOCATION_INVALID';
  end if;
  v_remaining_eligible := v_eligible_total;

  for v_line in
    with lines as (
      select
        'ticket'::text as kind,
        line ->> 'ticket_type_id' as reference_id,
        (line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer as line_cents,
        0 as line_group,
        ordinality::integer as line_order
      from jsonb_array_elements(coalesce(p_ticket_lines,'[]'::jsonb)) with ordinality as ticket(line,ordinality)
      union all
      select
        'product'::text,
        line ->> 'product_id',
        (line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer,
        1,
        ordinality::integer
      from jsonb_array_elements(coalesce(p_product_lines,'[]'::jsonb)) with ordinality as product(line,ordinality)
    )
    select kind,reference_id,line_cents
    from lines
    where line_cents > 0
      and (
        not v_restricted
        or (kind = 'ticket' and reference_id = any(v_promo.ticket_type_ids))
        or (kind = 'product' and reference_id = any(v_promo.product_ids))
      )
    order by line_group,line_order
  loop
    if v_remaining_eligible = v_line.line_cents then
      v_line_discount := v_remaining_discount;
    else
      v_line_discount := least(
        v_line.line_cents,
        floor(v_remaining_discount::numeric * v_line.line_cents::numeric / v_remaining_eligible::numeric)::integer
      );
    end if;
    if v_line_discount > 0 then
      v_allocation := v_allocation || jsonb_build_array(jsonb_build_object(
        'kind',v_line.kind,
        'reference_id',v_line.reference_id,
        'discount_cents',v_line_discount
      ));
    end if;
    v_remaining_discount := v_remaining_discount - v_line_discount;
    v_remaining_eligible := v_remaining_eligible - v_line.line_cents;
  end loop;

  if v_remaining_discount <> 0 then raise exception 'ORDER_DISCOUNT_ALLOCATION_INVALID'; end if;
  return v_allocation;
end;
$$;

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
returns table(reservation_id uuid, order_id uuid, checkout_attempt_id uuid, idempotency_key uuid, discount_cents integer, promo_code_id uuid)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_promo public.promo_codes;
  v_reserved record;
  v_subtotal integer;
  v_eligible integer;
  v_eligible_items integer;
  v_discount integer;
  v_ticket_units integer;
  v_allocation jsonb;
begin
  if p_promo_code is null or p_promo_code !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$' then
    raise exception using errcode = '22023', message = 'PROMO_INVALID';
  end if;
  select * into v_promo from public.promo_codes where lower(code) = lower(trim(p_promo_code)) for update;
  if not found then raise exception using errcode = 'P0002', message = 'PROMO_NOT_FOUND'; end if;
  if not v_promo.active or v_promo.status <> 'active' then raise exception using errcode = 'P0001', message = 'PROMO_NOT_AVAILABLE'; end if;
  if v_promo.valid_from is not null and v_promo.valid_from > now() then raise exception using errcode = 'P0001', message = 'PROMO_NOT_STARTED'; end if;
  if v_promo.expires_at is not null and v_promo.expires_at <= now() then raise exception using errcode = 'P0001', message = 'PROMO_EXPIRED'; end if;
  if cardinality(v_promo.event_ids) > 0 and not (p_event_id = any(v_promo.event_ids)) then
    raise exception using errcode = 'P0001', message = 'PROMO_EVENT_RESTRICTED';
  end if;

  select coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer),0)
    + (select coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer),0)
       from jsonb_array_elements(p_product_lines) product(line))
  into v_subtotal from jsonb_array_elements(p_ticket_lines) ticket(line);
  if v_subtotal < v_promo.minimum_order_cents then raise exception using errcode = 'P0001', message = 'PROMO_MINIMUM_NOT_MET'; end if;
  if v_promo.first_purchase_only and exists(
    select 1 from public.orders where customer_id = p_customer_id and status in (
      'payment_received','fulfilment_pending','paid_unfulfilled','fulfilled','partially_refunded','refunded','disputed','suspended'
    )
  ) then raise exception using errcode = 'P0001', message = 'PROMO_FIRST_PURCHASE_ONLY'; end if;

  if cardinality(v_promo.ticket_type_ids) = 0 and cardinality(v_promo.product_ids) = 0 then
    v_eligible := v_subtotal;
    v_eligible_items := jsonb_array_length(p_ticket_lines) + jsonb_array_length(p_product_lines);
  else
    select coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer),0), count(*)::integer
      into v_eligible, v_eligible_items
      from jsonb_array_elements(p_ticket_lines) ticket(line)
      where line ->> 'ticket_type_id' = any(v_promo.ticket_type_ids);
    select v_eligible + coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer),0),
      v_eligible_items + count(*)::integer
      into v_eligible, v_eligible_items
      from jsonb_array_elements(p_product_lines) product(line)
      where line ->> 'product_id' = any(v_promo.product_ids);
  end if;
  if v_eligible_items <= 0 or (v_promo.discount_type <> 'tracking' and v_eligible <= 0) then
    raise exception using errcode = 'P0001', message = 'PROMO_ITEMS_NOT_ELIGIBLE';
  end if;

  if v_promo.discount_type = 'tracking' then
    v_discount := 0;
  elsif v_promo.discount_type = 'percentage' then
    v_discount := least(v_eligible, round(v_eligible * v_promo.percent_off / 100.0)::integer);
  else
    v_discount := least(v_eligible, v_promo.amount_off_cents);
  end if;
  if (v_promo.discount_type <> 'tracking' and v_discount <= 0) or v_discount > v_subtotal then
    raise exception using errcode = '22023', message = 'PROMO_INVALID_DISCOUNT';
  end if;

  select coalesce(sum((line ->> 'quantity')::integer),0) into v_ticket_units
    from jsonb_array_elements(p_ticket_lines) ticket(line)
    where cardinality(v_promo.ticket_type_ids) = 0 or line ->> 'ticket_type_id' = any(v_promo.ticket_type_ids);
  if v_ticket_units = 0 then
    select coalesce(sum((line ->> 'quantity')::integer),0) into v_ticket_units
    from jsonb_array_elements(p_ticket_lines) ticket(line);
  end if;

  select * into v_reserved from public.skie_reserve_checkout_v2(
    p_customer_id,p_customer_email,p_customer_name,p_event_id,p_event_title,p_event_public_capacity,
    p_currency,p_expires_at,p_ticket_lines,p_product_lines,p_allocation_id,v_discount,p_reservation_key,p_version
  );
  perform public.skie_claim_promo_usage(
    v_promo.id,v_reserved.reservation_id,v_reserved.order_id,p_customer_id,p_event_id,v_ticket_units,
    v_subtotal,v_discount,v_subtotal-v_discount,p_expires_at
  );
  v_allocation := public.skie_build_promo_discount_allocation(
    v_promo.id,p_ticket_lines,p_product_lines,v_discount
  );
  update public.orders
  set discount_allocation = v_allocation
  where id = v_reserved.order_id;
  update public.reservations set promo_code_id = v_promo.id where id = v_reserved.reservation_id;
  return query select v_reserved.reservation_id,v_reserved.order_id,v_reserved.checkout_attempt_id,
    v_reserved.idempotency_key,v_discount,v_promo.id;
end;
$$;

-- Backfill existing discounted orders from their immutable order-line snapshots.
do $$
declare
  v_order record;
  v_ticket_lines jsonb;
  v_product_lines jsonb;
begin
  for v_order in
    select orders.id,orders.discount_cents,reservation.promo_code_id
    from public.orders as orders
    left join public.reservations as reservation on reservation.id = orders.reservation_id
    where coalesce(orders.discount_cents,0) > 0
      and orders.discount_allocation = '[]'::jsonb
  loop
    select coalesce(jsonb_agg(jsonb_build_object(
      'ticket_type_id',line.reference_id,
      'quantity',line.quantity,
      'unit_price_cents',line.unit_price_cents
    ) order by line.id),'[]'::jsonb)
    into v_ticket_lines
    from public.order_lines as line
    where line.order_id = v_order.id and line.kind = 'ticket';

    select coalesce(jsonb_agg(jsonb_build_object(
      'product_id',line.reference_id,
      'quantity',line.quantity,
      'unit_price_cents',line.unit_price_cents
    ) order by line.id),'[]'::jsonb)
    into v_product_lines
    from public.order_lines as line
    where line.order_id = v_order.id and line.kind = 'product';

    update public.orders
    set discount_allocation = public.skie_build_promo_discount_allocation(
      v_order.promo_code_id,v_ticket_lines,v_product_lines,v_order.discount_cents
    )
    where id = v_order.id;
  end loop;
end;
$$;

create or replace function public.skie_order_discount_allocation_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_sum integer;
  v_entry jsonb;
  v_kind text;
  v_reference_id text;
  v_discount integer;
begin
  if jsonb_typeof(new.discount_allocation) <> 'array' then
    raise exception 'ORDER_DISCOUNT_ALLOCATION_INVALID';
  end if;
  if old.discount_allocation <> '[]'::jsonb
    and new.discount_allocation is distinct from old.discount_allocation then
    raise exception 'ORDER_DISCOUNT_ALLOCATION_IMMUTABLE';
  end if;

  select coalesce(sum((entry ->> 'discount_cents')::integer),0)::integer
  into v_sum
  from jsonb_array_elements(new.discount_allocation) as allocation(entry);
  if v_sum <> coalesce(new.discount_cents,0)
    or (coalesce(new.discount_cents,0) = 0 and jsonb_array_length(new.discount_allocation) <> 0) then
    raise exception 'ORDER_DISCOUNT_ALLOCATION_INVALID';
  end if;

  if exists (
    select 1
    from (
      select entry ->> 'kind' as kind,entry ->> 'reference_id' as reference_id,count(*)
      from jsonb_array_elements(new.discount_allocation) as allocation(entry)
      group by entry ->> 'kind',entry ->> 'reference_id'
      having count(*) > 1
    ) duplicates
  ) then raise exception 'ORDER_DISCOUNT_ALLOCATION_INVALID'; end if;

  for v_entry in select entry from jsonb_array_elements(new.discount_allocation) as allocation(entry)
  loop
    v_kind := v_entry ->> 'kind';
    v_reference_id := v_entry ->> 'reference_id';
    v_discount := (v_entry ->> 'discount_cents')::integer;
    if v_kind not in ('ticket','product')
      or coalesce(v_reference_id,'') = ''
      or v_discount <= 0
      or not exists (
        select 1
        from public.order_lines as line
        where line.order_id = new.id
          and line.kind = v_kind
          and line.reference_id = v_reference_id
          and v_discount <= line.quantity * line.unit_price_cents
      ) then
      raise exception 'ORDER_DISCOUNT_ALLOCATION_INVALID';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists orders_discount_allocation_guard on public.orders;
create trigger orders_discount_allocation_guard
before update of discount_allocation,discount_cents on public.orders
for each row execute function public.skie_order_discount_allocation_guard();

revoke all on function public.skie_build_promo_discount_allocation(uuid,jsonb,jsonb,integer)
from public, anon, authenticated;
revoke all on function public.skie_reserve_checkout_with_promo(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,text,uuid,integer)
from public, anon, authenticated;
revoke all on function public.skie_order_discount_allocation_guard()
from public, anon, authenticated;

grant execute on function public.skie_build_promo_discount_allocation(uuid,jsonb,jsonb,integer)
to service_role;
grant execute on function public.skie_reserve_checkout_with_promo(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,text,uuid,integer)
to service_role;
grant execute on function public.skie_order_discount_allocation_guard()
to service_role;

notify pgrst, 'reload schema';

commit;
