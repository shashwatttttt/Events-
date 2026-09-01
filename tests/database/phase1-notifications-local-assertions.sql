\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

begin;

create function pg_temp.skie_phase1_assert(condition boolean, label text) returns void language plpgsql as $$
begin if not coalesce(condition,false) then raise exception 'ASSERTION_FAILED:%',label; end if; end;
$$;

insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at) values
  ('f8000000-0000-0000-0000-000000000001','phase1-customer@local.invalid','{"first_name":"Customer","phone":"+61412345678"}',now(),now()),
  ('f8000000-0000-0000-0000-000000000002','phase1-admin@local.invalid','{"first_name":"Admin"}',now(),now());
update public.profiles set role='admin' where id='f8000000-0000-0000-0000-000000000002';

insert into public.notification_preferences(user_id,channel,enabled) values
  ('f8000000-0000-0000-0000-000000000001','sms',true),
  ('f8000000-0000-0000-0000-000000000001','in_app',true);
insert into public.notification_consents(user_id,channel,consent_type,accepted,text_shown,policy_version,ip_hash)
  values ('f8000000-0000-0000-0000-000000000001','sms','transactional',true,'Transactional SMS consent fixture','transactional-sms-v1',repeat('a',64));

select public.skie_set_notification_control('f8000000-0000-0000-0000-000000000002','sms',true,'phase1-event');

do $$
declare enqueued record; replay record; claimed public.notification_outbox; finished public.notification_outbox; retry_claim public.notification_outbox; retry_item public.notification_outbox; email_claim public.notification_outbox; email_item public.notification_outbox; callback jsonb; duplicate_callback jsonb;
begin
  perform pg_temp.skie_phase1_assert(to_regclass('public.notification_preferences') is not null, 'preferences table');
  perform pg_temp.skie_phase1_assert(to_regclass('public.notification_consents') is not null, 'consents table');
  perform pg_temp.skie_phase1_assert(to_regclass('public.notification_provider_events') is not null, 'provider events table');
  perform pg_temp.skie_phase1_assert(to_regclass('public.notification_settings_audit') is not null, 'settings audit table');
  perform pg_temp.skie_phase1_assert((select bool_and(relrowsecurity) from pg_class where oid in (
    'public.notification_preferences'::regclass,'public.notification_consents'::regclass,
    'public.notification_channel_controls'::regclass,'public.event_notification_controls'::regclass,
    'public.notification_provider_events'::regclass,'public.notification_settings_audit'::regclass
  )), 'RLS enabled');
  perform pg_temp.skie_phase1_assert(not has_table_privilege('anon','public.notification_preferences','SELECT,INSERT,UPDATE,DELETE'), 'anon preferences grants');
  perform pg_temp.skie_phase1_assert(not has_table_privilege('authenticated','public.notification_consents','SELECT,INSERT,UPDATE,DELETE'), 'authenticated consent grants');
  perform pg_temp.skie_phase1_assert((select bool_and(p.prosecdef and coalesce(p.proconfig @> array['search_path=public'],false)
    and has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
    and not has_function_privilege('authenticated',p.oid,'EXECUTE')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('skie_set_notification_control','skie_record_notification_admin_action','skie_record_notification_callback')), 'new RPC security');
  perform pg_temp.skie_phase1_assert((select enabled from public.event_notification_controls where event_id='phase1-event' and channel='sms'), 'event control');
  perform pg_temp.skie_phase1_assert(exists(select 1 from public.notification_settings_audit where event_id='phase1-event' and channel='sms'), 'control audit');

  select * into enqueued from public.skie_enqueue_notification('sms','application_received','f8000000-0000-0000-0000-000000000001','+61412345678',repeat('b',64),'phase1-event',null,'{}','phase1-sms-idempotency',3);
  select * into replay from public.skie_enqueue_notification('sms','application_received','f8000000-0000-0000-0000-000000000001','+61412345678',repeat('b',64),'phase1-event',null,'{}','phase1-sms-idempotency',3);
  perform pg_temp.skie_phase1_assert(enqueued.inserted and not replay.inserted, 'channel idempotency');
  select * into claimed from public.skie_claim_notification_batch('sms','phase1-worker',1,30);
  perform pg_temp.skie_phase1_assert(claimed.status='processing' and claimed.attempt_count=1, 'processing state');
  finished := public.skie_finish_notification(claimed.id,'phase1-worker','accepted','SM12345678901234567890123456789012',null,30);
  perform pg_temp.skie_phase1_assert(finished.status='sent' and finished.provider_message_id like 'SM%', 'provider acceptance');
  callback := public.skie_record_notification_callback('twilio',repeat('c',64),'SM12345678901234567890123456789012','delivered','delivered');
  duplicate_callback := public.skie_record_notification_callback('twilio',repeat('c',64),'SM12345678901234567890123456789012','delivered','delivered');
  perform pg_temp.skie_phase1_assert((callback->>'matched')::boolean and not (callback->>'duplicate')::boolean, 'callback matched');
  perform pg_temp.skie_phase1_assert((duplicate_callback->>'duplicate')::boolean, 'callback duplicate');
  perform pg_temp.skie_phase1_assert((select status='delivered' and delivered_at is not null from public.notification_outbox where id=claimed.id), 'delivery state');

  perform public.skie_enqueue_notification('in_app','event_update','f8000000-0000-0000-0000-000000000001','f8000000-0000-0000-0000-000000000001',repeat('d',64),'phase1-event',null,'{}','phase1-retry',1);
  select * into retry_claim from public.skie_claim_notification_batch('in_app','phase1-retry-worker',1,30);
  retry_item := public.skie_finish_notification(retry_claim.id,'phase1-retry-worker','temporary_failure',null,'NOTIFICATION_RENDER_FAILED',30);
  perform pg_temp.skie_phase1_assert(retry_item.status='failed' and retry_item.attempt_count=retry_item.max_attempts, 'bounded failure');
  retry_item := public.skie_manage_notification(retry_item.id,'retry','f8000000-0000-0000-0000-000000000002');
  perform pg_temp.skie_phase1_assert(retry_item.status='queued' and retry_item.max_attempts=2, 'explicit admin retry extension');

  perform public.skie_enqueue_notification('email','event_update','f8000000-0000-0000-0000-000000000001','phase1-customer@local.invalid',repeat('e',64),'phase1-event',null,'{}','phase1-resend-callback',3);
  select * into email_claim from public.skie_claim_notification_batch('email','phase1-email-worker',1,30);
  email_item := public.skie_finish_notification(email_claim.id,'phase1-email-worker','accepted','resend-message-id',null,30);
  callback := public.skie_record_notification_callback('resend','resend-event-id','resend-message-id','email.delivered','delivered');
  perform pg_temp.skie_phase1_assert((callback->>'matched')::boolean and (select status='delivered' from public.notification_outbox where id=email_item.id), 'resend delivery callback');
end;
$$;

select 'PASS|phase1-multichannel-notification-security-behavior';
rollback;
