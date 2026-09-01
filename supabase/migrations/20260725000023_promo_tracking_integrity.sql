-- First-class zero-discount promoter tracking and end-to-end promo integrity.
-- Tracking codes claim and finalize the same durable redemption records while preserving the full order total.

begin;

-- Replace only the legacy promo discount checks, regardless of their generated names.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.promo_codes'::regclass
      and contype = 'c'
      and position('discount_type' in lower(pg_get_constraintdef(oid))) > 0
  loop
    execute format('alter table public.promo_codes drop constraint %I', constraint_name);
  end loop;
end;
$$;

alter table public.promo_codes
  add constraint promo_codes_discount_type_check
  check (discount_type in ('percentage','fixed','tracking'));

alter table public.promo_codes
  add constraint promo_codes_discount_value_check
  check (
    (discount_type = 'percentage' and percent_off > 0 and percent_off <= 100 and amount_off_cents is null)
    or (discount_type = 'fixed' and amount_off_cents > 0 and percent_off is null)
    or (discount_type = 'tracking' and percent_off is null and amount_off_cents is null)
  );

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
  v_eligible_items integer;
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
  update public.reservations set promo_code_id = v_promo.id where id = v_reserved.reservation_id;
  return query select v_reserved.reservation_id,v_reserved.order_id,v_reserved.checkout_attempt_id,
    v_reserved.idempotency_key,v_discount,v_promo.id;
end;
$$;

create or replace function public.skie_post_checkout_schema_health()
returns table(schema_version integer, ready boolean, details jsonb)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with required as (
    select
      to_regprocedure('public.skie_record_post_checkout_authorization(uuid,text,text,integer,integer,text,timestamptz)') is not null as authorization_rpc,
      to_regprocedure('public.skie_submit_post_checkout_application(uuid,uuid,jsonb,integer,integer,timestamptz)') is not null as submit_rpc,
      to_regprocedure('public.skie_request_post_checkout_decision(uuid,uuid,text,text,text,text)') is not null as decision_rpc,
      to_regprocedure('public.skie_claim_post_checkout_payment_actions(text,integer,integer)') is not null as worker_rpc,
      to_regprocedure('public.skie_restart_unpaid_post_checkout(uuid,text)') is not null as restart_rpc,
      to_regprocedure('public.skie_record_operations_worker_heartbeat(text,text,text)') is not null as heartbeat_rpc,
      to_regprocedure('public.skie_operations_health(integer,integer)') is not null as operations_health_rpc,
      to_regprocedure('public.skie_reservation_immutable()') is not null as reservation_guard,
      to_regclass('public.operations_worker_heartbeats') is not null as heartbeat_table,
      exists (select 1 from pg_trigger where tgrelid = 'public.reservations'::regclass and tgname = 'reservations_immutable_trigger' and not tgisinternal and tgenabled <> 'D') as reservation_trigger,
      coalesce((select position('RESERVATION_EXPIRY_EXTENSION_INVALID' in pg_get_functiondef(p.oid)) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'skie_reservation_immutable' limit 1), false) as monotonic_expiry_guard,
      coalesce((select position('promo_redemptions' in pg_get_functiondef(p.oid)) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'skie_mark_post_checkout_cancelled' limit 1), false) as promo_release_guard,
      exists (select 1 from pg_constraint where conrelid = 'public.promo_codes'::regclass and conname = 'promo_codes_active_status_check' and convalidated) as promo_activation_guard,
      exists (select 1 from pg_constraint where conrelid = 'public.promo_codes'::regclass and conname = 'promo_codes_discount_type_check' and convalidated) as promo_tracking_type_guard,
      exists (select 1 from pg_constraint where conrelid = 'public.promo_codes'::regclass and conname = 'promo_codes_discount_value_check' and convalidated) as promo_tracking_value_guard,
      coalesce((select position('discount_type = ''tracking''' in lower(pg_get_functiondef(p.oid))) > 0 and position('v_discount := 0' in lower(pg_get_functiondef(p.oid))) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'skie_reserve_checkout_with_promo' limit 1), false) as promo_tracking_rpc_guard,
      coalesce((select position('lease_expires_at is null' in lower(pg_get_functiondef(p.oid))) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'skie_claim_post_checkout_payment_actions' limit 1), false) as payment_null_lease_guard,
      coalesce((select position('lease_expires_at is null' in lower(pg_get_functiondef(p.oid))) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'skie_claim_notification_batch' limit 1), false) as notification_null_lease_guard
  )
  select
    23,
    authorization_rpc and submit_rpc and decision_rpc and worker_rpc and restart_rpc
      and heartbeat_rpc and operations_health_rpc and reservation_guard and heartbeat_table
      and reservation_trigger and monotonic_expiry_guard and promo_release_guard
      and promo_activation_guard and promo_tracking_type_guard and promo_tracking_value_guard
      and promo_tracking_rpc_guard and payment_null_lease_guard and notification_null_lease_guard,
    jsonb_build_object(
      'authorizationRpc',authorization_rpc,'submitRpc',submit_rpc,'decisionRpc',decision_rpc,
      'workerRpc',worker_rpc,'restartRpc',restart_rpc,'heartbeatRpc',heartbeat_rpc,
      'operationsHealthRpc',operations_health_rpc,'heartbeatTable',heartbeat_table,
      'reservationGuard',reservation_guard,'reservationTrigger',reservation_trigger,
      'monotonicExpiryGuard',monotonic_expiry_guard,'promoReleaseGuard',promo_release_guard,
      'promoActivationGuard',promo_activation_guard,'promoTrackingTypeGuard',promo_tracking_type_guard,
      'promoTrackingValueGuard',promo_tracking_value_guard,'promoTrackingRpcGuard',promo_tracking_rpc_guard,
      'paymentNullLeaseGuard',payment_null_lease_guard,'notificationNullLeaseGuard',notification_null_lease_guard
    )
  from required;
$$;

revoke all on function public.skie_reserve_checkout_with_promo(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,text,uuid,integer)
from public, anon, authenticated;
grant execute on function public.skie_reserve_checkout_with_promo(uuid,text,text,text,text,integer,text,timestamptz,jsonb,jsonb,text,text,uuid,integer)
to service_role;
revoke all on function public.skie_post_checkout_schema_health() from public, anon, authenticated;
grant execute on function public.skie_post_checkout_schema_health() to service_role;

notify pgrst, 'reload schema';
commit;
