\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

begin;

create function pg_temp.skie_assert(condition boolean, label text) returns void language plpgsql as $$
begin if not coalesce(condition,false) then raise exception 'ASSERTION_FAILED:%',label; end if; end;
$$;

do $$
declare
  function_name text;
  enqueued record;
  replay record;
  claimed public.notification_outbox;
  finished public.notification_outbox;
begin
  perform pg_temp.skie_assert(to_regclass('public.notification_admin_audit') is not null, 'notification admin audit table');
  perform pg_temp.skie_assert((select relrowsecurity from pg_class where oid='public.notification_admin_audit'::regclass), 'notification audit RLS');
  perform pg_temp.skie_assert(not has_table_privilege('anon','public.notification_outbox','SELECT,INSERT,UPDATE,DELETE'), 'notification anon grants');
  perform pg_temp.skie_assert(not has_table_privilege('authenticated','public.notification_outbox','SELECT,INSERT,UPDATE,DELETE'), 'notification authenticated grants');
  perform pg_temp.skie_assert(exists(select 1 from information_schema.columns where table_schema='public' and table_name='notification_outbox' and column_name='recipient_hash' and is_nullable='NO'), 'recipient hash');
  perform pg_temp.skie_assert(exists(select 1 from information_schema.columns where table_schema='public' and table_name='notification_outbox' and column_name='lease_owner'), 'lease owner');

  foreach function_name in array array['skie_enqueue_notification','skie_claim_notification_batch','skie_finish_notification','skie_manage_notification'] loop
    perform pg_temp.skie_assert(exists(
      select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=function_name and p.prosecdef
        and coalesce(p.proconfig @> array['search_path=public'],false)
        and has_function_privilege('service_role',p.oid,'EXECUTE')
        and not has_function_privilege('anon',p.oid,'EXECUTE')
        and not has_function_privilege('authenticated',p.oid,'EXECUTE')
    ), 'function:' || function_name);
  end loop;

  select * into enqueued from public.skie_enqueue_notification(
    'email','application_received',null,'phase4@local.invalid',repeat('a',64),null,null,
    '{"variables":{"event_title":"Local"}}','phase4-idempotency',3
  );
  select * into replay from public.skie_enqueue_notification(
    'email','application_received',null,'phase4@local.invalid',repeat('a',64),null,null,
    '{"variables":{"event_title":"Local"}}','phase4-idempotency',3
  );
  perform pg_temp.skie_assert(enqueued.inserted and not replay.inserted, 'idempotent enqueue');
  select * into claimed from public.skie_claim_notification_batch('email','phase4-worker',1,30);
  perform pg_temp.skie_assert(claimed.status in ('claimed','processing') and claimed.attempt_count=1 and claimed.lease_owner='phase4-worker', 'claim');
  finished := public.skie_finish_notification(claimed.id,'phase4-worker','dry_run','local-phase4',null,30);
  perform pg_temp.skie_assert(finished.status='dry_run' and finished.sent_at is not null, 'dry run result');
  perform pg_temp.skie_assert((select status='dry_run' and finished_at is not null from public.notification_attempts where outbox_id=claimed.id), 'attempt result');
end;
$$;

select 'PASS|phase4-notification-catalog-security-behavior';
rollback;
