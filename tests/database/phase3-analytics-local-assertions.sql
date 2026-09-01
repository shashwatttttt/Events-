\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
begin;
create function pg_temp.skie_analytics_assert(condition boolean,label text)returns void language plpgsql as $$begin if not coalesce(condition,false)then raise exception 'ASSERTION_FAILED:%',label;end if;end$$;
insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)values('fa000000-0000-0000-0000-000000000001','analytics-admin@local.invalid','{"first_name":"Admin"}',now(),now()),('fa000000-0000-0000-0000-000000000002','analytics-customer@local.invalid','{"first_name":"Customer"}',now(),now());
update public.profiles set role='admin' where id='fa000000-0000-0000-0000-000000000001';
do $$
declare v_result jsonb;v_report jsonb;v_count integer;
begin
  perform pg_temp.skie_analytics_assert(to_regclass('public.analytics_events')is not null,'events table');
  perform pg_temp.skie_analytics_assert(to_regclass('public.analytics_retention_settings')is not null,'retention table');
  perform pg_temp.skie_analytics_assert((select bool_and(relrowsecurity)from pg_class where oid in('public.analytics_events'::regclass,'public.analytics_retention_settings'::regclass)),'RLS enabled');
  perform pg_temp.skie_analytics_assert(not has_table_privilege('anon','public.analytics_events','SELECT,INSERT,UPDATE,DELETE')and not has_table_privilege('authenticated','public.analytics_events','SELECT,INSERT,UPDATE,DELETE'),'sensitive grants revoked');
  perform pg_temp.skie_analytics_assert((select bool_and(p.prosecdef and coalesce(p.proconfig@>array['search_path=public'],false)and has_function_privilege('service_role',p.oid,'EXECUTE')and not has_function_privilege('anon',p.oid,'EXECUTE')and not has_function_privilege('authenticated',p.oid,'EXECUTE'))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname in('skie_capture_analytics_event','skie_analytics_report','skie_prune_analytics_events')),'RPC security');
  v_result:=public.skie_capture_analytics_event('page_view','client','analytics-page-dedupe','2026-07-22 14:30:00+00',null,null,null,null,'instagram','social','winter-launch','social','mobile','safari',repeat('a',64),null,null,1,'{"path":"/events"}');
  perform pg_temp.skie_analytics_assert((v_result->>'inserted')::boolean,'first insert');
  v_result:=public.skie_capture_analytics_event('page_view','client','analytics-page-dedupe','2026-07-22 14:30:00+00',null,null,null,null,null,null,null,null,null,null,repeat('a',64),null,null,1,'{}');
  perform pg_temp.skie_analytics_assert(not(v_result->>'inserted')::boolean and(select count(*)=1 from public.analytics_events where deduplication_key='analytics-page-dedupe'),'deduplication');
  begin perform public.skie_capture_analytics_event('payment_completed','client','invalid-authority-key','2026-07-22 14:30:00+00','event-a',null,null,null,null,null,null,null,null,null,repeat('b',64),null,1000,1,'{}');raise exception 'expected client authority rejection';exception when insufficient_privilege then null;end;
  begin perform public.skie_capture_analytics_event('page_view','client','unsafe-metadata-key','2026-07-22 14:30:00+00',null,null,null,null,null,null,null,null,null,null,repeat('c',64),null,null,null,'{"email":"private@example.test"}');raise exception 'expected unsafe metadata rejection';exception when invalid_parameter_value then null;end;
  perform public.skie_capture_analytics_event('checkout_started','server','checkout:test-order','2026-07-22 14:31:00+00','event-a','ticket-a',null,null,null,null,'winter-launch',null,null,null,null,'fa000000-0000-0000-0000-000000000002',null,2,'{}');
  perform public.skie_capture_analytics_event('payment_completed','server','payment:test-order','2026-07-22 14:32:00+00','event-a','ticket-a',null,null,null,null,'winter-launch',null,null,null,null,'fa000000-0000-0000-0000-000000000002',4500,2,'{}');
  perform public.skie_capture_analytics_event('ticket_issued','server','ticket:test-a','2026-07-22 14:33:00+00','event-a','ticket-a',null,null,null,null,'winter-launch',null,null,null,null,'fa000000-0000-0000-0000-000000000002',null,2,'{}');
  v_report:=public.skie_analytics_report('2026-07-23','2026-07-23','event-a','winter-launch',null);
  perform pg_temp.skie_analytics_assert((v_report#>>'{totals,revenueCents}')::integer=4500 and(v_report#>>'{totals,ticketQuantity}')::integer=2,'integer cents and ticket totals');
  perform pg_temp.skie_analytics_assert((select melbourne_date='2026-07-23' from public.analytics_events where deduplication_key='analytics-page-dedupe'),'Melbourne reporting date');
  perform pg_temp.skie_analytics_assert((select count(*)=8 from pg_trigger where not tgisinternal and tgname like 'analytics_%'),'operational triggers');
  update public.analytics_events set retention_until='2020-01-01' where deduplication_key='analytics-page-dedupe';v_count:=public.skie_prune_analytics_events('2026-07-23');
  perform pg_temp.skie_analytics_assert(v_count=1 and not exists(select 1 from public.analytics_events where deduplication_key='analytics-page-dedupe'),'retention pruning');
end$$;
select 'PASS|phase3-analytics-security-reporting';
rollback;
