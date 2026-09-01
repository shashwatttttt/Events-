\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

begin;

create function pg_temp.skie_assert(condition boolean, label text) returns void language plpgsql as $$
begin if not coalesce(condition,false) then raise exception 'ASSERTION_FAILED:%',label; end if; end;
$$;

do $$
declare
  v_admin uuid;
  v_customer uuid;
  v_promo public.promo_codes;
  v_result record;
  v_redemption public.promo_redemptions;
begin
  select id into v_admin from public.profiles where role in ('admin','super_admin') order by id limit 1;
  select id into v_customer from public.profiles where role='customer' order by id limit 1;
  perform pg_temp.skie_assert(v_admin is not null and v_customer is not null, 'fixture actors');
  perform pg_temp.skie_assert(to_regclass('public.promo_admin_audit') is not null, 'promo audit table');
  perform pg_temp.skie_assert((select relrowsecurity from pg_class where oid='public.promo_admin_audit'::regclass), 'promo audit RLS');
  perform pg_temp.skie_assert(not has_table_privilege('anon','public.promo_codes','SELECT,INSERT,UPDATE,DELETE'), 'promo anon grants');
  perform pg_temp.skie_assert(not has_table_privilege('authenticated','public.promo_codes','SELECT,INSERT,UPDATE,DELETE'), 'promo authenticated grants');
  perform pg_temp.skie_assert(exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='skie_reserve_checkout_with_promo' and p.prosecdef
      and coalesce(p.proconfig @> array['search_path=public'],false)
      and has_function_privilege('service_role',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not has_function_privilege('authenticated',p.oid,'EXECUTE')), 'promo reserve RPC security');

  insert into public.promo_codes(code,internal_name,active,discount_type,percent_off,minimum_order_cents,
    event_ids,ticket_type_ids,product_ids,status,created_by)
  values ('PHASE6PCT','Phase 6 percentage',true,'percentage',12.50,3000,
    array['phase6-event'],array['phase6-ticket'],array[]::text[],'active',v_admin) returning * into v_promo;
  select * into v_result from public.skie_reserve_checkout_with_promo(
    v_customer,'phase6@local.invalid','Phase Six','phase6-event','Phase Six Event',20,'AUD',now()+interval '30 minutes',
    '[{"ticket_type_id":"phase6-ticket","name":"Ticket","quantity":3,"unit_price_cents":999,"capacity":20,"customer_limit":20}]',
    '[{"product_id":"phase6-product","name":"Extra","quantity":1,"unit_price_cents":500,"stock_quantity":20,"max_per_customer":20,"units_per_purchase":1,"redeemable":false}]',
    null,'phase6pct','f6000000-0000-0000-0000-000000000001',1
  );
  select * into v_redemption from public.promo_redemptions where reservation_id=v_result.reservation_id;
  perform pg_temp.skie_assert(v_result.discount_cents=375, 'percentage integer rounding');
  perform pg_temp.skie_assert((select subtotal_cents=3497 and discount_cents=375 and total_cents=3122 from public.orders where id=v_result.order_id), 'discount order snapshot');
  perform pg_temp.skie_assert((select promo_code_id=v_promo.id and expected_discount_cents=375 from public.reservations where id=v_result.reservation_id), 'discount reservation snapshot');
  perform pg_temp.skie_assert(v_redemption.discounted_ticket_units=3 and v_redemption.status='reserved', 'promo usage snapshot');

  perform public.skie_fail_checkout_creation(v_result.checkout_attempt_id);
  perform pg_temp.skie_assert((select status='released' from public.promo_redemptions where id=v_redemption.id), 'session failure release');
  perform pg_temp.skie_assert((select status='failed' from public.orders where id=v_result.order_id), 'session failure order');

  insert into public.promo_codes(code,internal_name,active,discount_type,amount_off_cents,status,created_by)
  values ('PHASE6CAP','Phase 6 cap',true,'fixed',5000,'active',v_admin) returning * into v_promo;
  select * into v_result from public.skie_reserve_checkout_with_promo(
    v_customer,'phase6@local.invalid','Phase Six','phase6-cap','Phase Six Cap',20,'AUD',now()+interval '30 minutes',
    '[{"ticket_type_id":"phase6-cap-ticket","name":"Ticket","quantity":1,"unit_price_cents":1000,"capacity":20,"customer_limit":20}]',
    '[]',null,'PHASE6CAP','f6000000-0000-0000-0000-000000000002',1
  );
  perform pg_temp.skie_assert(v_result.discount_cents=1000 and (select total_cents=0 from public.orders where id=v_result.order_id), 'fixed discount capped at eligible subtotal');
  update public.reservations set status='payment_received' where id=v_result.reservation_id;
  update public.orders set status='fulfilled' where id=v_result.order_id;
  perform pg_temp.skie_assert((select status='finalized' and finalized_at is not null from public.promo_redemptions where order_id=v_result.order_id), 'paid finalization exactly once');
  update public.orders set status='fulfilled' where id=v_result.order_id;
  perform pg_temp.skie_assert((select count(*)=1 from public.promo_redemptions where order_id=v_result.order_id), 'finalization replay');
end;
$$;

select 'PASS|phase6-promo-catalog-security-lifecycle';
rollback;
