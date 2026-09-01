\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
begin;
create function pg_temp.skie_phase4_assert(condition boolean,label text)returns void language plpgsql as $$begin if not coalesce(condition,false)then raise exception 'ASSERTION_FAILED:%',label;end if;end$$;
insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at) values
('fb000000-0000-0000-0000-000000000001','phase4-admin@local.invalid','{"first_name":"Admin"}',now(),now()),
('fb000000-0000-0000-0000-000000000002','phase4-customer@local.invalid','{"first_name":"Customer"}',now(),now());
update public.profiles set role='admin' where id='fb000000-0000-0000-0000-000000000001';
do $$
declare v_reserved record;v_ticket public.tickets;v_entitlement public.entitlements;v_redemption uuid;
begin
  perform pg_temp.skie_phase4_assert((select bool_and(relrowsecurity) from pg_class where oid in('public.admin_operation_audit'::regclass,'public.admin_saved_filters'::regclass,'public.event_launch_readiness'::regclass)),'RLS enabled');
  perform pg_temp.skie_phase4_assert(not has_table_privilege('anon','public.admin_operation_audit','SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated','public.admin_saved_filters','SELECT,INSERT,UPDATE,DELETE'),'sensitive grants revoked');
  perform pg_temp.skie_phase4_assert((select count(*)=7 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('skie_admin_assert_actor','skie_admin_record_operation','skie_admin_save_filter','skie_admin_save_launch_readiness','skie_admin_reissue_ticket','skie_admin_reverse_check_in','skie_admin_reverse_entitlement_redemption') and p.prosecdef and coalesce(p.proconfig@>array['search_path=public'],false) and has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')),'RPC security');
  perform public.skie_admin_save_filter('fb000000-0000-0000-0000-000000000001','ticketing','Door queue','{"status":"valid"}');
  perform public.skie_admin_save_launch_readiness('fb000000-0000-0000-0000-000000000001','phase4-event','{"door_workflow_rehearsed":true}',5,90,'readiness-phase4-0001');
  perform pg_temp.skie_phase4_assert((select count(*)=1 from public.event_launch_readiness where event_id='phase4-event') and (select count(*)=1 from public.admin_operation_audit where idempotency_key='readiness-phase4-0001'),'readiness saved and audited');
  select * into v_reserved from public.skie_reserve_checkout(
    'fb000000-0000-0000-0000-000000000002','phase4-customer@local.invalid','Phase Four','phase4-event','Phase Four Event',10,'AUD',now()+interval '30 minutes',
    '[{"ticket_type_id":"phase4-ticket","name":"General","quantity":1,"unit_price_cents":1000,"capacity":10,"customer_limit":2}]',
    '[{"product_id":"phase4-addon","name":"Drink token","quantity":1,"unit_price_cents":500,"stock_quantity":10,"max_per_customer":2,"units_per_purchase":1,"redeemable":true}]',null,0,'fb000000-0000-0000-0000-000000000010',1);
  perform public.skie_record_offline_payment(v_reserved.order_id,'test','phase4-payment');
  perform public.skie_fulfil_payment(v_reserved.reservation_id,
    '[{"id":"fb000000-0000-0000-0000-000000000020","ticket_type_id":"phase4-ticket","ticket_code":"SKIE-PHASE4-TEST","token_hash":"phase4-token-hash-value-which-is-long-enough","token_preview":"phase4","holder_name":"Phase Four"}]',
    '[{"id":"fb000000-0000-0000-0000-000000000030","product_id":"phase4-addon","name":"Drink token","quantity_total":1}]');
  perform public.skie_check_in('fb000000-0000-0000-0000-000000000020','phase4-token-hash-value-which-is-long-enough','phase4-event','fb000000-0000-0000-0000-000000000001','accepted');
  v_ticket:=public.skie_admin_reverse_check_in('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-000000000020','Operator scanned wrong guest','reverse-checkin-phase4');
  perform pg_temp.skie_phase4_assert(v_ticket.status='valid' and (select reversed_at is not null from public.check_ins where ticket_id=v_ticket.id and result='valid'),'check-in reversal');
  v_ticket:=public.skie_admin_reissue_ticket('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-000000000020','Customer lost original','fb000000-0000-0000-0000-000000000021','SKIE-PHASE4-NEW','phase4-replacement-token-hash-long-enough','replace4','reissue-ticket-phase4');
  perform pg_temp.skie_phase4_assert(v_ticket.status='valid' and (select status='transferred' from public.tickets where id='fb000000-0000-0000-0000-000000000020'),'ticket reissue state');
  v_entitlement:=public.skie_redeem_entitlement('fb000000-0000-0000-0000-000000000030','phase4-event',1,'fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-000000000040');
  select id into v_redemption from public.entitlement_redemptions where entitlement_id=v_entitlement.id;
  v_entitlement:=public.skie_admin_reverse_entitlement_redemption('fb000000-0000-0000-0000-000000000001',v_redemption,'Guest did not receive item','reverse-redemption-phase4');
  perform pg_temp.skie_phase4_assert(v_entitlement.status='active' and v_entitlement.quantity_remaining=1 and (select reversed_at is not null from public.entitlement_redemptions where id=v_redemption),'redemption reversal');
  perform pg_temp.skie_phase4_assert((select count(*)=1 from public.analytics_events where deduplication_key='addon_redemption_reversal:'||v_redemption),'reversal analytics');
  begin perform public.skie_admin_record_operation('fb000000-0000-0000-0000-000000000002','test.denied','event','phase4-event','No','denied-operation-phase4','{}');raise exception 'expected admin rejection';exception when others then if sqlerrm='expected admin rejection' then raise;end if;end;
end$$;
select 'PASS|phase4-admin-recovery-security-behavior';
rollback;
