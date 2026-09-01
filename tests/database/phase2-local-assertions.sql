\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

begin;

create function pg_temp.skie_assert(condition boolean, label text)
returns void
language plpgsql
as $$
begin
  if not coalesce(condition, false) then
    raise exception using errcode = 'P0001', message = 'ASSERTION_FAILED:' || label;
  end if;
end;
$$;

create temporary table phase2_refs (
  label text primary key,
  reservation_id uuid not null,
  order_id uuid not null,
  checkout_attempt_id uuid not null,
  idempotency_key uuid not null
) on commit drop;

-- Catalog, constraints, triggers, indexes, RLS and grants.
do $$
declare
  expected_tables text[] := array[
    'profiles','platform_documents','ticket_allocations','reservations',
    'reservation_ticket_lines','reservation_product_lines','checkout_attempts',
    'orders','order_lines','payments','payment_adjustments','stripe_webhook_events',
    'tickets','entitlements','check_ins','entitlement_redemptions',
    'event_staff_assignments','notification_outbox','notification_attempts',
    'promo_codes','promo_redemptions','payment_recovery_actions'
  ];
  transaction_tables text[] := array[
    'ticket_allocations','reservations','reservation_ticket_lines',
    'reservation_product_lines','checkout_attempts','orders','order_lines',
    'payments','payment_adjustments','stripe_webhook_events','tickets','entitlements',
    'check_ins','entitlement_redemptions','event_staff_assignments',
    'notification_outbox','notification_attempts','promo_codes','promo_redemptions',
    'payment_recovery_actions'
  ];
  expected_triggers text[] := array[
    'auth.users.on_auth_user_created',
    'public.checkout_attempts.checkout_attempts_touch_updated_at',
    'public.entitlements.entitlements_touch_updated_at',
    'public.event_staff_assignments.event_staff_assignments_touch_updated_at',
    'public.notification_outbox.notification_outbox_touch_updated_at',
    'public.order_lines.order_lines_immutable',
    'public.orders.orders_touch_updated_at',
    'public.payment_adjustments.payment_adjustments_touch_updated_at',
    'public.payments.payments_touch_updated_at',
    'public.promo_codes.promo_codes_touch_updated_at',
    'public.promo_redemptions.promo_redemptions_touch_updated_at',
    'public.reservation_product_lines.reservation_product_lines_immutable',
    'public.reservation_ticket_lines.reservation_ticket_lines_immutable',
    'public.reservations.reservations_immutable_trigger',
    'public.stripe_webhook_events.stripe_webhook_events_touch_updated_at',
    'public.ticket_allocations.ticket_allocations_touch_updated_at',
    'public.tickets.tickets_touch_updated_at'
  ];
  required_indexes text[] := array[
    'checkout_attempts_order_unique','checkout_attempts_status_idx',
    'reservations_event_status_expiry_idx','reservations_customer_event_idx',
    'reservations_active_allocation_unique','ticket_allocations_customer_event_idx',
    'orders_recovery_idx','payments_order_idx','payments_stripe_session_unique',
    'payments_stripe_pi_unique','payments_provider_reference_unique',
    'payment_adjustments_order_idx','stripe_webhook_retry_idx',
    'tickets_event_code_idx','tickets_customer_idx','entitlements_event_customer_idx',
    'check_ins_event_time_idx','staff_event_idx','notification_due_idx',
    'promo_codes_code_lower_unique','promo_redemptions_usage_idx'
  ];
  privileged_functions text[] := array[
    'skie_reserve_checkout','skie_link_stripe_session','skie_upsert_ticket_allocation',
    'skie_mutate_ticket_allocation','skie_record_stripe_webhook',
    'skie_claim_stripe_webhook','skie_record_payment_received',
    'skie_mark_paid_unfulfilled','skie_record_offline_payment','skie_fulfil_payment',
    'skie_check_in','skie_redeem_entitlement','skie_claim_notification',
    'skie_claim_promo_usage','skie_mark_webhook_result',
    'skie_expire_checkout_session','skie_apply_refund',
    'skie_mark_payment_intent_terminal','skie_mark_recovery_resolved',
    'skie_apply_dispute'
  ];
  item text;
  role_name text;
  privilege_name text;
begin
  perform pg_temp.skie_assert(
    (select count(*) = cardinality(expected_tables)
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = any(expected_tables)),
    'expected tables'
  );
  perform pg_temp.skie_assert(
    (select count(*) = 22 from pg_constraint c
      where c.connamespace = 'public'::regnamespace and c.contype = 'p'
        and c.conrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace and relname = any(expected_tables))),
    'primary keys'
  );
  perform pg_temp.skie_assert(
    (select count(*) >= 44 from pg_constraint c
      where c.connamespace = 'public'::regnamespace and c.contype = 'f'
        and c.conrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace and relname = any(expected_tables))),
    'foreign keys'
  );
  perform pg_temp.skie_assert(
    (select count(*) >= 103 from pg_constraint c
      where c.connamespace = 'public'::regnamespace and c.contype = 'c'
        and c.conrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace and relname = any(expected_tables))),
    'check constraints'
  );
  perform pg_temp.skie_assert(
    not exists(select 1 from pg_constraint c where c.connamespace = 'public'::regnamespace
      and c.conrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace and relname = any(expected_tables))
      and not c.convalidated),
    'validated constraints'
  );

  foreach item in array expected_triggers loop
    perform pg_temp.skie_assert(exists(
      select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where not t.tgisinternal and n.nspname || '.' || c.relname || '.' || t.tgname = item
    ), 'trigger:' || item);
  end loop;
  foreach item in array required_indexes loop
    perform pg_temp.skie_assert(exists(select 1 from pg_indexes where schemaname = 'public' and indexname = item), 'index:' || item);
  end loop;

  perform pg_temp.skie_assert((select indisunique from pg_index where indexrelid = 'public.checkout_attempts_stripe_checkout_session_id_key'::regclass), 'checkout session unique');
  perform pg_temp.skie_assert((select indisunique from pg_index where indexrelid = 'public.checkout_attempts_stripe_payment_intent_id_key'::regclass), 'checkout PI unique');
  perform pg_temp.skie_assert((select indisunique from pg_index where indexrelid = 'public.payments_stripe_session_unique'::regclass), 'payment session unique');
  perform pg_temp.skie_assert((select indisunique from pg_index where indexrelid = 'public.payments_stripe_pi_unique'::regclass), 'payment PI unique');
  perform pg_temp.skie_assert((select indisunique from pg_index where indexrelid = 'public.stripe_webhook_events_pkey'::regclass), 'stripe event unique');
  perform pg_temp.skie_assert((select indisunique from pg_index where indexrelid = 'public.tickets_ticket_code_key'::regclass), 'ticket code unique');
  perform pg_temp.skie_assert((select indisunique from pg_index where indexrelid = 'public.tickets_token_hash_key'::regclass), 'ticket token unique');
  perform pg_temp.skie_assert((select indisunique from pg_index where indexrelid = 'public.notification_outbox_idempotency_key_key'::regclass), 'notification idempotency unique');
  perform pg_temp.skie_assert((select indisunique from pg_index where indexrelid = 'public.notification_attempts_outbox_id_attempt_number_key'::regclass), 'notification attempt unique');
  perform pg_temp.skie_assert((select indisunique from pg_index where indexrelid = 'public.promo_redemptions_reservation_id_key'::regclass), 'promo reservation unique');
  perform pg_temp.skie_assert((select indisunique from pg_index where indexrelid = 'public.reservations_active_allocation_unique'::regclass), 'active allocation unique');

  foreach item in array expected_tables loop
    perform pg_temp.skie_assert((select relrowsecurity from pg_class where oid = ('public.' || item)::regclass), 'RLS:' || item);
  end loop;
  perform pg_temp.skie_assert(
    not exists(select 1 from pg_policies where schemaname = 'public' and tablename = any(transaction_tables)),
    'no broad transaction policies'
  );
  foreach role_name in array array['anon','authenticated'] loop
    foreach item in array transaction_tables loop
      foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
        perform pg_temp.skie_assert(not has_table_privilege(role_name, 'public.' || item, privilege_name), role_name || ':' || item || ':' || privilege_name);
      end loop;
    end loop;
    perform pg_temp.skie_assert(not has_schema_privilege(role_name, 'public', 'CREATE'), role_name || ':public schema create');
  end loop;
  foreach item in array transaction_tables loop
    perform pg_temp.skie_assert(has_table_privilege('service_role', 'public.' || item, 'SELECT,INSERT,UPDATE,DELETE'), 'service table grants:' || item);
  end loop;

  perform pg_temp.skie_assert((select count(*) = cardinality(privileged_functions)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(privileged_functions)), 'privileged function inventory');
  foreach item in array privileged_functions loop
    perform pg_temp.skie_assert(not exists(
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where n.nspname = 'public' and p.proname = item and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ), 'PUBLIC execute:' || item);
    perform pg_temp.skie_assert(not exists(
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = item
        and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ), 'client execute:' || item);
    perform pg_temp.skie_assert(not exists(
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = item
        and (not p.prosecdef or not coalesce(p.proconfig @> array['search_path=public'], false)
          or not has_function_privilege('service_role', p.oid, 'EXECUTE'))
    ), 'definer/search_path/service:' || item);
  end loop;
  perform pg_temp.skie_assert(not exists(
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
      lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where n.nspname = 'public' and p.proname like 'skie_%'
      and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ), 'no PUBLIC skie functions');
  perform pg_temp.skie_assert(not exists(
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not exists(select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg ~ '^search_path=(pg_catalog, )?public$')
  ), 'all security definers fixed search_path');
end;
$$;

-- Synthetic local users: customer A/B, door, scanner, admin and super_admin.
insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at) values
  ('f2000000-0000-0000-0000-000000000001','phase2-a@local.invalid','{"first_name":"Customer","last_name":"A"}',now(),now()),
  ('f2000000-0000-0000-0000-000000000002','phase2-b@local.invalid','{"first_name":"Customer","last_name":"B"}',now(),now()),
  ('f2000000-0000-0000-0000-000000000003','phase2-door@local.invalid','{"first_name":"Door"}',now(),now()),
  ('f2000000-0000-0000-0000-000000000004','phase2-scanner@local.invalid','{"first_name":"Scanner"}',now(),now()),
  ('f2000000-0000-0000-0000-000000000005','phase2-admin@local.invalid','{"first_name":"Admin"}',now(),now()),
  ('f2000000-0000-0000-0000-000000000006','phase2-super@local.invalid','{"first_name":"Super"}',now(),now());

update public.profiles set role = case id
  when 'f2000000-0000-0000-0000-000000000003' then 'door_staff'::public.user_role
  when 'f2000000-0000-0000-0000-000000000004' then 'scanner_only'::public.user_role
  when 'f2000000-0000-0000-0000-000000000005' then 'admin'::public.user_role
  when 'f2000000-0000-0000-0000-000000000006' then 'super_admin'::public.user_role
  else 'customer'::public.user_role end
where id::text like 'f2000000-%';

insert into public.event_staff_assignments(user_id,event_id,role,assigned_by) values
  ('f2000000-0000-0000-0000-000000000003','phase2-main','door_staff','f2000000-0000-0000-0000-000000000005'),
  ('f2000000-0000-0000-0000-000000000003','phase2-wrong','door_staff','f2000000-0000-0000-0000-000000000005'),
  ('f2000000-0000-0000-0000-000000000004','phase2-main','scanner_only','f2000000-0000-0000-0000-000000000005');

-- Allocation RPCs.
do $$
declare
  allocation public.ticket_allocations;
begin
  allocation := public.skie_upsert_ticket_allocation(
    'phase2-allocation','f2000000-0000-0000-0000-000000000001','phase2-allocation-event',
    'phase2-ticket',1,1000,now() + interval '2 hours','f2000000-0000-0000-0000-000000000005',now()
  );
  perform pg_temp.skie_assert(allocation.status = 'unlocked', 'allocation upsert result');
  allocation := public.skie_mutate_ticket_allocation('phase2-allocation','cancel',null);
  perform pg_temp.skie_assert(allocation.status = 'cancelled', 'allocation mutation result');
end;
$$;

-- Reservation, product, checkout-attempt and Session-link execution.
insert into phase2_refs
select 'main', result.* from public.skie_reserve_checkout(
  'f2000000-0000-0000-0000-000000000001','phase2-a@local.invalid','Customer A',
  'phase2-main','Phase 2 Main',10,'AUD',now() + interval '30 minutes',
  '[{"ticket_type_id":"phase2-ticket","name":"Phase 2 Ticket","quantity":1,"unit_price_cents":1000,"capacity":10,"customer_limit":5}]',
  '[{"product_id":"phase2-product","name":"Phase 2 Product","quantity":1,"unit_price_cents":500,"stock_quantity":10,"max_per_customer":5,"units_per_purchase":2,"redeemable":true}]',
  null,0,'f2000000-0000-0000-0001-000000000001',1
) result;

do $$
declare
  ref phase2_refs;
  linked public.checkout_attempts;
begin
  select * into ref from phase2_refs where label = 'main';
  perform pg_temp.skie_assert(ref.reservation_id is not null and ref.order_id is not null and ref.checkout_attempt_id is not null and ref.idempotency_key is not null, 'reservation result structure');
  linked := public.skie_link_stripe_session(ref.checkout_attempt_id,'cs_phase2_main',now() + interval '30 minutes');
  perform pg_temp.skie_assert(linked.status = 'session_active' and linked.stripe_checkout_session_id = 'cs_phase2_main', 'session link result');
  linked := public.skie_link_stripe_session(ref.checkout_attempt_id,'cs_phase2_main',now() + interval '30 minutes');
  perform pg_temp.skie_assert(linked.stripe_checkout_session_id = 'cs_phase2_main', 'identical session replay');
  begin
    perform public.skie_link_stripe_session(ref.checkout_attempt_id,'cs_phase2_conflict',now() + interval '30 minutes');
    raise exception 'expected conflicting session rejection';
  exception when unique_violation then
    perform pg_temp.skie_assert(sqlerrm = 'CHECKOUT_SESSION_ALREADY_LINKED', 'conflicting session code');
  end;
end;
$$;

-- Durable webhook, payment evidence, failure preservation and recovery.
do $$
declare
  recorded record;
  claimed public.stripe_webhook_events;
  paid record;
  fulfilled record;
  ref phase2_refs;
begin
  select * into ref from phase2_refs where label = 'main';
  select * into recorded from public.skie_record_stripe_webhook(
    'evt_phase2_main','checkout.session.completed',false,now(),null,'cs_phase2_main','cs_phase2_main','pi_phase2_main',null,null,null,'f2000000-0000-0000-0002-000000000001'
  );
  perform pg_temp.skie_assert(recorded.inserted and recorded.status = 'received' and recorded.correlation_id is not null, 'webhook insert result');
  select * into recorded from public.skie_record_stripe_webhook(
    'evt_phase2_main','checkout.session.completed',false,now(),null,'cs_phase2_main','cs_phase2_main','pi_phase2_main',null,null,null,'f2000000-0000-0000-0002-000000000002'
  );
  perform pg_temp.skie_assert(not recorded.inserted and recorded.correlation_id = 'f2000000-0000-0000-0002-000000000001', 'webhook replay result');
  select * into claimed from public.skie_claim_stripe_webhook(30);
  perform pg_temp.skie_assert(claimed.stripe_event_id = 'evt_phase2_main' and claimed.status = 'processing', 'webhook claim result');
  perform public.skie_mark_webhook_result('evt_phase2_main','temporary_failure','LOCAL_RETRY',10);

  select * into paid from public.skie_record_payment_received(
    'evt_phase2_main','cs_phase2_main','pi_phase2_main',1500,'AUD',now(),ref.order_id::text,ref.order_id::text
  );
  perform pg_temp.skie_assert(paid.reservation_id = ref.reservation_id and paid.order_id = ref.order_id and not paid.duplicate and paid.failure_code is null, 'payment result structure');
  select * into paid from public.skie_record_payment_received(
    'evt_phase2_main','cs_phase2_main','pi_phase2_main',1500,'AUD',now(),ref.order_id::text,ref.order_id::text
  );
  perform pg_temp.skie_assert(paid.duplicate and paid.failure_code is null, 'payment replay result');
  perform public.skie_mark_webhook_result('evt_phase2_main','processed',null,60);

  begin
    perform public.skie_fulfil_payment(ref.reservation_id,'[]'::jsonb,'[]'::jsonb);
    raise exception 'expected forced fulfilment failure';
  exception when invalid_parameter_value then
    perform pg_temp.skie_assert(sqlerrm = 'TICKET_COUNT_MISMATCH', 'forced fulfilment code');
  end;
  perform pg_temp.skie_assert((select count(*) = 1 from public.payments where order_id = ref.order_id and stripe_payment_intent_id = 'pi_phase2_main'), 'payment evidence survives fulfilment failure');
  perform public.skie_mark_paid_unfulfilled(ref.reservation_id,'FORCED_LOCAL_FAILURE');
  perform pg_temp.skie_assert((select status = 'paid_unfulfilled' from public.orders where id = ref.order_id), 'paid unfulfilled state');

  select * into fulfilled from public.skie_fulfil_payment(
    ref.reservation_id,
    '[{"id":"f2000000-0000-0000-0010-000000000001","ticket_type_id":"phase2-ticket","ticket_code":"PHASE2-MAIN-1","token_hash":"phase2-main-token-hash-0000000000000001","token_preview":"phase2","holder_name":"Customer A"}]',
    '[{"id":"f2000000-0000-0000-0011-000000000001","product_id":"phase2-product","name":"Phase 2 Product","quantity_total":2}]'
  );
  perform pg_temp.skie_assert(fulfilled.order_id = ref.order_id and fulfilled.ticket_count = 1 and fulfilled.entitlement_count = 1 and not fulfilled.duplicate, 'fulfilment result');
  select * into fulfilled from public.skie_fulfil_payment(
    ref.reservation_id,
    '[{"id":"f2000000-0000-0000-0010-000000000001","ticket_type_id":"phase2-ticket","ticket_code":"PHASE2-MAIN-1","token_hash":"phase2-main-token-hash-0000000000000001","token_preview":"phase2","holder_name":"Customer A"}]',
    '[{"id":"f2000000-0000-0000-0011-000000000001","product_id":"phase2-product","name":"Phase 2 Product","quantity_total":2}]'
  );
  perform pg_temp.skie_assert(fulfilled.ticket_count = 1 and fulfilled.entitlement_count = 1 and fulfilled.duplicate, 'fulfilment replay exact quantities');
  perform pg_temp.skie_assert((select quantity_total = 2 and quantity_remaining = 2 from public.entitlements where id = 'f2000000-0000-0000-0011-000000000001'), 'entitlement exact quantity');
  perform public.skie_mark_recovery_resolved(ref.reservation_id);
end;
$$;

-- Immutable snapshot and immutable line triggers.
do $$
declare
  ref phase2_refs;
begin
  select * into ref from phase2_refs where label = 'main';
  begin
    update public.reservations set customer_email = 'changed@local.invalid' where id = ref.reservation_id;
    raise exception 'expected reservation immutability rejection';
  exception when check_violation then
    perform pg_temp.skie_assert(sqlerrm = 'RESERVATION_SNAPSHOT_IMMUTABLE', 'reservation immutable code');
  end;
  begin
    update public.order_lines set quantity = quantity + 1 where order_id = ref.order_id;
    raise exception 'expected line immutability rejection';
  exception when check_violation then
    perform pg_temp.skie_assert(sqlerrm = 'IMMUTABLE_TRANSACTION_ROW', 'line immutable code');
  end;
end;
$$;

-- Event scope, rejected-scan privacy, check-in and entitlement redemption.
do $$
declare
  scan_result record;
  entitlement public.entitlements;
begin
  begin
    perform public.skie_check_in('f2000000-0000-0000-0010-000000000001','phase2-main-token-hash-0000000000000001','phase2-unassigned','f2000000-0000-0000-0000-000000000003','');
    raise exception 'expected unassigned event rejection';
  exception when insufficient_privilege then
    perform pg_temp.skie_assert(sqlerrm = 'EVENT_ASSIGNMENT_REQUIRED', 'door unassigned event');
  end;
  select * into scan_result from public.skie_check_in('f2000000-0000-0000-0010-000000000001','phase2-main-token-hash-0000000000000001','phase2-wrong','f2000000-0000-0000-0000-000000000003','');
  perform pg_temp.skie_assert(scan_result.result = 'wrong_event' and scan_result.ticket_status = 'valid' and scan_result.checked_in_at is null, 'wrong event scan safe result');
  select * into scan_result from public.skie_check_in('f2000000-0000-0000-0010-000000000001','phase2-main-token-hash-0000000000000001','phase2-main','f2000000-0000-0000-0000-000000000004','');
  perform pg_temp.skie_assert(scan_result.result = 'valid' and scan_result.ticket_status = 'checked_in' and scan_result.checked_in_at is not null, 'valid scan result');
  select * into scan_result from public.skie_check_in('f2000000-0000-0000-0010-000000000001','phase2-main-token-hash-0000000000000001','phase2-main','f2000000-0000-0000-0000-000000000004','');
  perform pg_temp.skie_assert(scan_result.result = 'already_checked_in', 'duplicate scan result');

  begin
    perform public.skie_redeem_entitlement('f2000000-0000-0000-0011-000000000001','phase2-main',1,'f2000000-0000-0000-0000-000000000004','f2000000-0000-0000-0012-000000000001');
    raise exception 'expected scanner redemption rejection';
  exception when insufficient_privilege then
    perform pg_temp.skie_assert(sqlerrm = 'EVENT_ASSIGNMENT_REQUIRED', 'scanner cannot redeem');
  end;
  begin
    perform public.skie_redeem_entitlement('f2000000-0000-0000-0011-000000000001','phase2-wrong',1,'f2000000-0000-0000-0000-000000000003','f2000000-0000-0000-0012-000000000002');
    raise exception 'expected wrong event entitlement rejection';
  exception when no_data_found then
    perform pg_temp.skie_assert(sqlerrm = 'ENTITLEMENT_NOT_FOUND', 'entitlement event scope');
  end;
  entitlement := public.skie_redeem_entitlement('f2000000-0000-0000-0011-000000000001','phase2-main',1,'f2000000-0000-0000-0000-000000000003','f2000000-0000-0000-0012-000000000003');
  perform pg_temp.skie_assert(entitlement.quantity_remaining = 1 and entitlement.status = 'active', 'entitlement redemption result');
  entitlement := public.skie_redeem_entitlement('f2000000-0000-0000-0011-000000000001','phase2-main',1,'f2000000-0000-0000-0000-000000000003','f2000000-0000-0000-0012-000000000003');
  perform pg_temp.skie_assert(entitlement.quantity_remaining = 1, 'entitlement idempotent replay');
end;
$$;

-- Notification and promo claim RPCs.
insert into public.notification_outbox(channel,template_key,recipient_user_id,recipient_address,event_id,payload,idempotency_key)
values ('email','phase2-local','f2000000-0000-0000-0000-000000000001','phase2-a@local.invalid','phase2-main','{}','phase2-notification');

do $$
declare
  notification public.notification_outbox;
  promo public.promo_codes;
  redemption public.promo_redemptions;
  ref phase2_refs;
begin
  select * into notification from public.skie_claim_notification('email',30);
  perform pg_temp.skie_assert(notification.idempotency_key = 'phase2-notification' and notification.status = 'claimed' and notification.attempt_count = 1, 'notification claim result');
  insert into public.notification_attempts(outbox_id,attempt_number,status) values (notification.id,1,'claimed');
  insert into public.promo_codes(code,internal_name,discount_type,percent_off,max_redemptions,max_discounted_ticket_units,max_uses_per_customer,status,created_by)
    values ('PHASE2','Phase 2','percentage',10,1,1,1,'active','f2000000-0000-0000-0000-000000000005') returning * into promo;
  select * into ref from phase2_refs where label = 'main';
  redemption := public.skie_claim_promo_usage(promo.id,ref.reservation_id,ref.order_id,'f2000000-0000-0000-0000-000000000001','phase2-main',1,1500,150,1350,now() + interval '30 minutes');
  perform pg_temp.skie_assert(redemption.status = 'reserved' and redemption.discounted_ticket_units = 1 and redemption.final_total_cents = 1350, 'promo claim result');
end;
$$;

-- Reusable paid orders for refund, dispute, expiry, offline payment and terminal PI RPCs.
insert into phase2_refs
select 'partial', result.* from public.skie_reserve_checkout(
  'f2000000-0000-0000-0000-000000000001','phase2-a@local.invalid','Customer A','phase2-partial','Partial',5,'AUD',now() + interval '30 minutes',
  '[{"ticket_type_id":"partial-ticket","name":"Partial Ticket","quantity":1,"unit_price_cents":1000,"capacity":5,"customer_limit":5}]','[]',null,0,'f2000000-0000-0000-0020-000000000001',1
) result;
insert into phase2_refs
select 'dispute', result.* from public.skie_reserve_checkout(
  'f2000000-0000-0000-0000-000000000001','phase2-a@local.invalid','Customer A','phase2-dispute','Dispute',5,'AUD',now() + interval '30 minutes',
  '[{"ticket_type_id":"dispute-ticket","name":"Dispute Ticket","quantity":1,"unit_price_cents":1000,"capacity":5,"customer_limit":5}]','[]',null,0,'f2000000-0000-0000-0020-000000000002',1
) result;
insert into phase2_refs
select 'expiry', result.* from public.skie_reserve_checkout(
  'f2000000-0000-0000-0000-000000000001','phase2-a@local.invalid','Customer A','phase2-expiry','Expiry',5,'AUD',now() + interval '30 minutes',
  '[{"ticket_type_id":"expiry-ticket","name":"Expiry Ticket","quantity":1,"unit_price_cents":1000,"capacity":5,"customer_limit":5}]','[]',null,0,'f2000000-0000-0000-0020-000000000003',1
) result;
insert into phase2_refs
select 'offline', result.* from public.skie_reserve_checkout(
  'f2000000-0000-0000-0000-000000000002','phase2-b@local.invalid','Customer B','phase2-offline','Offline',5,'AUD',now() + interval '30 minutes',
  '[{"ticket_type_id":"offline-ticket","name":"Offline Ticket","quantity":1,"unit_price_cents":1000,"capacity":5,"customer_limit":5}]','[]',null,0,'f2000000-0000-0000-0020-000000000004',1
) result;
insert into phase2_refs
select 'terminal', result.* from public.skie_reserve_checkout(
  'f2000000-0000-0000-0000-000000000002','phase2-b@local.invalid','Customer B','phase2-terminal','Terminal',5,'AUD',now() + interval '30 minutes',
  '[{"ticket_type_id":"terminal-ticket","name":"Terminal Ticket","quantity":1,"unit_price_cents":1000,"capacity":5,"customer_limit":5}]','[]',null,0,'f2000000-0000-0000-0020-000000000005',1
) result;

do $$
declare
  ref phase2_refs;
  paid record;
  adjusted record;
  disputed record;
  offline record;
  terminal record;
begin
  select * into ref from phase2_refs where label = 'partial';
  perform public.skie_link_stripe_session(ref.checkout_attempt_id,'cs_phase2_partial',now() + interval '30 minutes');
  select * into paid from public.skie_record_payment_received('evt_phase2_partial','cs_phase2_partial','pi_phase2_partial',1000,'AUD',now(),ref.order_id::text,ref.order_id::text);
  perform public.skie_fulfil_payment(ref.reservation_id,'[{"id":"f2000000-0000-0000-0021-000000000001","ticket_type_id":"partial-ticket","ticket_code":"PHASE2-PARTIAL","token_hash":"phase2-partial-token-hash-00000000000001","token_preview":"partial","holder_name":"Customer A"}]','[]');
  select * into adjusted from public.skie_apply_refund('pi_phase2_partial','re_phase2_partial','succeeded',100,'AUD',now(),null);
  perform pg_temp.skie_assert(adjusted.resulting_status = 'manual_review' and not adjusted.duplicate, 'partial refund manual review');

  select * into ref from phase2_refs where label = 'dispute';
  perform public.skie_link_stripe_session(ref.checkout_attempt_id,'cs_phase2_dispute',now() + interval '30 minutes');
  select * into paid from public.skie_record_payment_received('evt_phase2_dispute','cs_phase2_dispute','pi_phase2_dispute',1000,'AUD',now(),ref.order_id::text,ref.order_id::text);
  perform public.skie_fulfil_payment(ref.reservation_id,'[{"id":"f2000000-0000-0000-0021-000000000002","ticket_type_id":"dispute-ticket","ticket_code":"PHASE2-DISPUTE","token_hash":"phase2-dispute-token-hash-00000000000001","token_preview":"dispute","holder_name":"Customer A"}]','[]');
  select * into disputed from public.skie_apply_dispute('pi_phase2_dispute','dp_phase2','needs_response',1000,'AUD',now());
  perform pg_temp.skie_assert(disputed.resulting_status = 'disputed' and (select status = 'suspended' from public.tickets where id = 'f2000000-0000-0000-0021-000000000002'), 'dispute suspension');
  select * into disputed from public.skie_apply_dispute('pi_phase2_dispute','dp_phase2','won',1000,'AUD',now());
  perform pg_temp.skie_assert(disputed.resulting_status = 'fulfilled' and (select status = 'valid' from public.tickets where id = 'f2000000-0000-0000-0021-000000000002'), 'dispute resolution');

  select * into ref from phase2_refs where label = 'expiry';
  perform public.skie_link_stripe_session(ref.checkout_attempt_id,'cs_phase2_expiry',now() + interval '30 minutes');
  perform public.skie_expire_checkout_session('cs_phase2_expiry','expired');
  perform pg_temp.skie_assert((select status = 'expired' from public.orders where id = ref.order_id), 'reservation expiry');

  select * into ref from phase2_refs where label = 'offline';
  select * into offline from public.skie_record_offline_payment(ref.order_id,'test','phase2-offline-payment');
  perform pg_temp.skie_assert(offline.order_id = ref.order_id and not offline.duplicate, 'offline payment result');
  perform public.skie_fulfil_payment(ref.reservation_id,'[{"id":"f2000000-0000-0000-0021-000000000003","ticket_type_id":"offline-ticket","ticket_code":"PHASE2-OFFLINE","token_hash":"phase2-offline-token-hash-00000000000001","token_preview":"offline","holder_name":"Customer B"}]','[]');

  select * into ref from phase2_refs where label = 'terminal';
  perform public.skie_link_stripe_session(ref.checkout_attempt_id,'cs_phase2_terminal',now() + interval '30 minutes');
  update public.checkout_attempts set stripe_payment_intent_id = 'pi_phase2_terminal' where id = ref.checkout_attempt_id;
  select * into terminal from public.skie_mark_payment_intent_terminal('pi_phase2_terminal','cancelled');
  perform pg_temp.skie_assert(terminal.order_id = ref.order_id and terminal.resulting_status = 'cancelled', 'terminal payment intent result');
end;
$$;

-- Full refund is last because it revokes the main ticket/entitlement state.
do $$
declare
  adjusted record;
begin
  select * into adjusted from public.skie_apply_refund('pi_phase2_main','re_phase2_full','succeeded',1500,'AUD',now(),null);
  perform pg_temp.skie_assert(adjusted.resulting_status = 'refunded' and not adjusted.duplicate, 'full refund result');
  perform pg_temp.skie_assert((select status = 'refunded' from public.tickets where id = 'f2000000-0000-0000-0010-000000000001'), 'full refund ticket state');
  perform pg_temp.skie_assert((select status = 'refunded' from public.entitlements where id = 'f2000000-0000-0000-0011-000000000001'), 'full refund entitlement state');
end;
$$;

-- No browser role has order/ticket/recovery access; server route authorization is
-- separately covered by the Vitest security suite.
select pg_temp.skie_assert(not has_table_privilege('authenticated','public.orders','SELECT'), 'customer cross-order access denied');
select pg_temp.skie_assert(not has_table_privilege('authenticated','public.tickets','SELECT'), 'customer cross-ticket access denied');
select pg_temp.skie_assert(not has_table_privilege('authenticated','public.payment_recovery_actions','SELECT,INSERT,UPDATE,DELETE'), 'door/scanner recovery direct access denied');

select 'PASS|catalog-security-rpc-role-scope';
rollback;
