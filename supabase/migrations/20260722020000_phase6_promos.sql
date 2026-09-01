-- SKIE EVENTS Phase 6 server-authoritative promo checkout and administration.
-- Discounts remain local order snapshots; no Stripe coupon object is created.

begin;

create table if not exists public.promo_admin_audit (
  id uuid primary key default gen_random_uuid(),
  promo_code_id uuid not null references public.promo_codes(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (action in ('created','updated','disabled')),
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists promo_admin_audit_promo_idx on public.promo_admin_audit(promo_code_id, created_at desc);
alter table public.promo_admin_audit enable row level security;
revoke all on table public.promo_admin_audit from public, anon, authenticated;
grant select, insert, update, delete on table public.promo_admin_audit to service_role;

-- A promo ID is attached exactly once by the atomic wrapper after its redemption
-- row exists. All financial and identity fields remain immutable.
create or replace function public.skie_reservation_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if row(
    new.reservation_key,new.version,new.customer_id,new.event_id,new.allocation_id,
    new.currency,new.expected_subtotal_cents,new.expected_discount_cents,
    new.expected_total_cents,new.expires_at,new.customer_email,new.customer_name,new.event_title,
    new.correlation_id,new.created_at
  ) is distinct from row(
    old.reservation_key,old.version,old.customer_id,old.event_id,old.allocation_id,
    old.currency,old.expected_subtotal_cents,old.expected_discount_cents,
    old.expected_total_cents,old.expires_at,old.customer_email,old.customer_name,old.event_title,
    old.correlation_id,old.created_at
  ) then
    raise exception using errcode = '23514', message = 'RESERVATION_SNAPSHOT_IMMUTABLE';
  end if;
  if new.promo_code_id is distinct from old.promo_code_id and not (
    old.promo_code_id is null and new.promo_code_id is not null and old.status = 'reserved'
    and exists(select 1 from public.promo_redemptions redemption
      where redemption.reservation_id = old.id and redemption.promo_code_id = new.promo_code_id and redemption.status = 'reserved')
  ) then
    raise exception using errcode = '23514', message = 'RESERVATION_SNAPSHOT_IMMUTABLE';
  end if;
  new.updated_at = now();
  return new;
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
set search_path = public
as $$
declare
  v_promo public.promo_codes;
  v_reserved record;
  v_subtotal integer;
  v_eligible integer;
  v_discount integer;
  v_ticket_units integer;
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
  else
    select coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer),0)
      into v_eligible from jsonb_array_elements(p_ticket_lines) ticket(line)
      where line ->> 'ticket_type_id' = any(v_promo.ticket_type_ids);
    select v_eligible + coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unit_price_cents')::integer),0)
      into v_eligible from jsonb_array_elements(p_product_lines) product(line)
      where line ->> 'product_id' = any(v_promo.product_ids);
  end if;
  if v_eligible <= 0 then raise exception using errcode = 'P0001', message = 'PROMO_ITEMS_NOT_ELIGIBLE'; end if;
  v_discount := least(v_eligible, case when v_promo.discount_type = 'percentage'
    then round(v_eligible * v_promo.percent_off / 100.0)::integer else v_promo.amount_off_cents end);
  if v_discount <= 0 or v_discount > v_subtotal then raise exception using errcode = '22023', message = 'PROMO_INVALID_DISCOUNT'; end if;

  select coalesce(sum((line ->> 'quantity')::integer),0) into v_ticket_units
    from jsonb_array_elements(p_ticket_lines) ticket(line)
    where cardinality(v_promo.ticket_type_ids) = 0 or line ->> 'ticket_type_id' = any(v_promo.ticket_type_ids);
  if v_ticket_units = 0 then
    select coalesce(sum((line ->> 'quantity')::integer),0) into v_ticket_units from jsonb_array_elements(p_ticket_lines) ticket(line);
  end if;

  select * into v_reserved from public.skie_reserve_checkout_v2(
    p_customer_id,p_customer_email,p_customer_name,p_event_id,p_event_title,p_event_public_capacity,
    p_currency,p_expires_at,p_ticket_lines,p_product_lines,p_allocation_id,v_discount,p_reservation_key,p_version
  );
  perform public.skie_claim_promo_usage(
    v_promo.id,v_reserved.reservation_id,v_reserved.order_id,p_customer_id,p_event_id,v_ticket_units,
    v_subtotal,v_discount,v_subtotal-v_discount,p_expires_at
  );
  update public.reservations set promo_code_id = v_promo.id where id = v_reserved.reservation_id;
  return query select v_reserved.reservation_id,v_reserved.order_id,v_reserved.checkout_attempt_id,
    v_reserved.idempotency_key,v_discount,v_promo.id;
end;
$$;

create or replace function public.skie_finalize_promo_on_order()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'fulfilled' and old.status is distinct from 'fulfilled' then
    update public.promo_redemptions set status = 'finalized', finalized_at = coalesce(finalized_at,now())
      where order_id = new.id and status = 'reserved';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_finalize_promo on public.orders;
create trigger orders_finalize_promo after update of status on public.orders
for each row execute function public.skie_finalize_promo_on_order();

create or replace function public.skie_fail_checkout_creation(p_checkout_attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.checkout_attempts;
  v_reservation public.reservations;
begin
  select * into v_attempt from public.checkout_attempts where id = p_checkout_attempt_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'CHECKOUT_ATTEMPT_NOT_FOUND'; end if;
  select * into v_reservation from public.reservations where id = v_attempt.reservation_id for update;
  if v_attempt.status <> 'creating_session' or v_reservation.status <> 'reserved' then return; end if;
  update public.checkout_attempts set status = 'session_failed', failure_code = 'SESSION_CREATION_FAILED' where id = v_attempt.id;
  update public.reservations set status = 'failed', failure_code = 'SESSION_CREATION_FAILED' where id = v_reservation.id;
  update public.orders set status = 'failed' where reservation_id = v_reservation.id and status = 'reserved';
  update public.promo_redemptions set status = 'released', released_at = now()
    where reservation_id = v_reservation.id and status = 'reserved';
  if v_reservation.allocation_id is not null then
    update public.ticket_allocations set status = case when expires_at <= now() then 'expired' else 'unlocked' end
      where id = v_reservation.allocation_id and status = 'checkout_started';
  end if;
end;
$$;

revoke all on function public.skie_reserve_checkout_with_promo(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,text,uuid,integer) from public, anon, authenticated;
grant execute on function public.skie_reserve_checkout_with_promo(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,text,uuid,integer) to service_role;
revoke all on function public.skie_fail_checkout_creation(uuid) from public, anon, authenticated;
grant execute on function public.skie_fail_checkout_creation(uuid) to service_role;
revoke all on function public.skie_finalize_promo_on_order() from public, anon, authenticated;

commit;
