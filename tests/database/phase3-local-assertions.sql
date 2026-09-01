begin;

create or replace function pg_temp.skie_phase3_assert(condition boolean, label text)
returns void language plpgsql as $$
begin
  if not coalesce(condition,false) then raise exception 'ASSERTION_FAILED:%',label; end if;
end;
$$;

do $$
declare
  item text;
  expected_tables text[] := array['event_staff_assignment_audit','event_sale_controls','event_state_audit','rate_limit_buckets'];
  expected_indexes text[] := array['staff_assignment_current_idx','staff_assignment_audit_event_idx','event_state_audit_event_idx','rate_limit_expiry_idx'];
  expected_functions text[] := array['skie_replace_site_document','skie_manage_event_staff_assignment','skie_consume_rate_limit','skie_cleanup_rate_limits','skie_reserve_checkout_v2'];
begin
  foreach item in array expected_tables loop
    perform pg_temp.skie_phase3_assert(to_regclass('public.' || item) is not null,'table:' || item);
    perform pg_temp.skie_phase3_assert((select relrowsecurity from pg_class where oid=('public.' || item)::regclass),'RLS:' || item);
    perform pg_temp.skie_phase3_assert(not has_table_privilege('anon','public.' || item,'SELECT,INSERT,UPDATE,DELETE'),'anon grants:' || item);
    perform pg_temp.skie_phase3_assert(not has_table_privilege('authenticated','public.' || item,'SELECT,INSERT,UPDATE,DELETE'),'authenticated grants:' || item);
    perform pg_temp.skie_phase3_assert(has_table_privilege('service_role','public.' || item,'SELECT,INSERT,UPDATE,DELETE'),'service grants:' || item);
  end loop;
  foreach item in array expected_indexes loop
    perform pg_temp.skie_phase3_assert(exists(select 1 from pg_indexes where schemaname='public' and indexname=item),'index:' || item);
  end loop;
  foreach item in array expected_functions loop
    perform pg_temp.skie_phase3_assert(exists(
      select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=item and p.prosecdef
        and coalesce(p.proconfig @> array['search_path=public'],false)
        and has_function_privilege('service_role',p.oid,'EXECUTE')
        and not has_function_privilege('anon',p.oid,'EXECUTE')
        and not has_function_privilege('authenticated',p.oid,'EXECUTE')
    ),'function security:' || item);
  end loop;
  perform pg_temp.skie_phase3_assert(exists(
    select 1 from information_schema.columns where table_schema='public' and table_name='event_staff_assignments' and column_name='starts_at' and is_nullable='NO'
  ),'staff start window');
  perform pg_temp.skie_phase3_assert(exists(
    select 1 from pg_constraint where conname='event_staff_assignments_window_check' and convalidated
  ),'staff window constraint');
  perform pg_temp.skie_phase3_assert(position('pg_advisory_xact_lock' in pg_get_functiondef('public.skie_replace_site_document(bigint,jsonb,uuid,uuid)'::regprocedure)) > 0,'CMS event lock');
end;
$$;

insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at) values
  ('f3000000-0000-0000-0000-000000000001','phase3-customer@local.invalid','{"first_name":"Customer"}',now(),now()),
  ('f3000000-0000-0000-0000-000000000002','phase3-door@local.invalid','{"first_name":"Door"}',now(),now()),
  ('f3000000-0000-0000-0000-000000000003','phase3-admin@local.invalid','{"first_name":"Admin"}',now(),now());
update public.profiles set role=case id
  when 'f3000000-0000-0000-0000-000000000002' then 'door_staff'::public.user_role
  when 'f3000000-0000-0000-0000-000000000003' then 'admin'::public.user_role
  else 'customer'::public.user_role end
where id::text like 'f3000000-%';

do $$
declare
  assigned public.event_staff_assignments;
  revoked public.event_staff_assignments;
begin
  assigned := public.skie_manage_event_staff_assignment(
    'assign',null,'f3000000-0000-0000-0000-000000000002','phase3-event','door_staff',
    now() - interval '1 minute',now() + interval '2 hours','f3000000-0000-0000-0000-000000000003'
  );
  perform pg_temp.skie_phase3_assert(assigned.active and assigned.starts_at <= now() and assigned.ends_at > now(),'active staff assignment');
  perform pg_temp.skie_phase3_assert((select count(*)=1 from public.event_staff_assignment_audit where assignment_id=assigned.id and action='assigned'),'assignment audit');
  revoked := public.skie_manage_event_staff_assignment(
    'revoke',assigned.id,null,null,null,null,null,'f3000000-0000-0000-0000-000000000003'
  );
  perform pg_temp.skie_phase3_assert(not revoked.active and revoked.revoked_at is not null and revoked.revoked_by is not null,'staff revocation');
  perform pg_temp.skie_phase3_assert((select count(*)=2 from public.event_staff_assignment_audit where assignment_id=assigned.id),'revocation audit');
end;
$$;

do $$
declare
  v_version bigint;
  v_payload jsonb;
  saved record;
  closed record;
  v_event_id text;
begin
  select version,payload into v_version,v_payload from public.platform_documents where key='site';
  select * into saved from public.skie_replace_site_document(v_version,v_payload,'f3000000-0000-0000-0000-000000000003',gen_random_uuid());
  perform pg_temp.skie_phase3_assert(saved.saved_version=v_version+1,'CMS version increment');
  v_event_id := v_payload #>> '{events,0,id}';
  perform pg_temp.skie_phase3_assert((select control.document_version=saved.saved_version from public.event_sale_controls control where control.event_id=v_event_id),'event control version');

  v_payload := jsonb_set(jsonb_set(v_payload,'{events,0,visibility}','"hidden"'),'{events,0,ticketMode}','"closed"');
  select * into closed from public.skie_replace_site_document(saved.saved_version,v_payload,'f3000000-0000-0000-0000-000000000003',gen_random_uuid());
  perform pg_temp.skie_phase3_assert(closed.closed_event_ids ? v_event_id,'emergency close transition');
  perform pg_temp.skie_phase3_assert((select not control.sales_enabled from public.event_sale_controls control where control.event_id=v_event_id),'event sales closed');
  begin
    perform public.skie_reserve_checkout_v2(
      'f3000000-0000-0000-0000-000000000001','phase3-customer@local.invalid','Local Customer',v_event_id,'Local Event',5,'AUD',now()+interval '30 minutes',
      '[{"ticket_type_id":"phase3-ticket","name":"Ticket","quantity":1,"unit_price_cents":1000,"capacity":5,"customer_limit":2}]','[]',null,0,gen_random_uuid(),1
    );
    raise exception 'expected event closure rejection';
  exception when raise_exception then
    perform pg_temp.skie_phase3_assert(sqlerrm='EVENT_SALES_CLOSED','closed event reservation code');
  end;
  begin
    perform public.skie_replace_site_document(saved.saved_version,v_payload,'f3000000-0000-0000-0000-000000000003',gen_random_uuid());
    raise exception 'expected stale CMS rejection';
  exception when serialization_failure then
    perform pg_temp.skie_phase3_assert(sqlerrm='CMS_STALE_VERSION','stale CMS code');
  end;
end;
$$;

do $$
declare
  first_result record;
  second_result record;
begin
  select * into first_result from public.skie_consume_rate_limit('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,60);
  select * into second_result from public.skie_consume_rate_limit('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,60);
  perform pg_temp.skie_phase3_assert(first_result.allowed and not second_result.allowed,'shared rate limit sequence');
  update public.rate_limit_buckets set expires_at=now()-interval '1 second' where key_hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  perform pg_temp.skie_phase3_assert(public.skie_cleanup_rate_limits(10)=1,'rate limit cleanup');
end;
$$;

select 'PASS|phase3-catalog-security-state-staff-rate-limit';
rollback;
