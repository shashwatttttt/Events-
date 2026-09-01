\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

begin;

create function pg_temp.skie_phase2_mux_assert(condition boolean, label text) returns void language plpgsql as $$
begin if not coalesce(condition,false) then raise exception 'ASSERTION_FAILED:%',label; end if; end;
$$;

insert into auth.users(id,email,raw_user_meta_data,created_at,updated_at)
  values ('f9000000-0000-0000-0000-000000000001','phase2-mux-admin@local.invalid','{"first_name":"Mux Admin"}',now(),now());
update public.profiles set role='admin' where id='f9000000-0000-0000-0000-000000000001';

do $$
declare
  v_admin uuid;
  v_asset public.media_video_assets;
  v_failed public.media_video_assets;
  v_result jsonb;
begin
  v_admin := 'f9000000-0000-0000-0000-000000000001';
  perform pg_temp.skie_phase2_mux_assert(v_admin is not null, 'admin fixture');
  perform pg_temp.skie_phase2_mux_assert(to_regclass('public.media_video_assets') is not null, 'video assets table');
  perform pg_temp.skie_phase2_mux_assert(to_regclass('public.media_provider_events') is not null, 'provider events table');
  perform pg_temp.skie_phase2_mux_assert(to_regclass('public.media_video_audit') is not null, 'video audit table');
  perform pg_temp.skie_phase2_mux_assert((select bool_and(relrowsecurity) from pg_class where oid in ('public.media_video_assets'::regclass,'public.media_provider_events'::regclass,'public.media_video_audit'::regclass)), 'RLS enabled');
  perform pg_temp.skie_phase2_mux_assert(not has_table_privilege('anon','public.media_video_assets','SELECT,INSERT,UPDATE,DELETE'), 'anon asset grants revoked');
  perform pg_temp.skie_phase2_mux_assert(not has_table_privilege('authenticated','public.media_provider_events','SELECT,INSERT,UPDATE,DELETE'), 'authenticated event grants revoked');
  perform pg_temp.skie_phase2_mux_assert(not exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid='public.media_video_audit'::regclass and a.grantee=0), 'PUBLIC audit grants revoked');
  perform pg_temp.skie_phase2_mux_assert((select bool_and(p.prosecdef and coalesce(p.proconfig @> array['search_path=public'],false)
    and has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
    and not has_function_privilege('authenticated',p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('skie_create_media_video_asset','skie_record_mux_media_event','skie_manage_media_video_asset')), 'RPC security');

  v_asset := public.skie_create_media_video_asset(v_admin,'phase2-media-a',null,'uploadphase2a','public',2.5,'/fallback.jpg');
  perform pg_temp.skie_phase2_mux_assert(v_asset.status='pending_upload', 'pending upload state');
  v_result := public.skie_record_mux_media_event('mux-event-uploaded','video.upload.asset_created','phase2-media-a','uploadphase2a','assetphase2a',null,null,null,null,null,null,null,null,'{"status":"asset_created"}',now());
  perform pg_temp.skie_phase2_mux_assert(v_result @> '{"matched":true,"duplicate":false,"status":"uploaded"}', 'uploaded transition');
  v_result := public.skie_record_mux_media_event('mux-event-processing','video.asset.preparing','phase2-media-a','uploadphase2a','assetphase2a',null,null,null,null,null,null,null,null,'{"status":"preparing"}',now());
  perform pg_temp.skie_phase2_mux_assert(v_result->>'status'='processing', 'processing transition');
  v_result := public.skie_record_mux_media_event('mux-event-ready','video.asset.ready','phase2-media-a','uploadphase2a','assetphase2a','playbackphase2a','public',61.25,1.777777,'1080p',null,null,null,'{"status":"ready","hasPlayback":true}',now());
  perform pg_temp.skie_phase2_mux_assert(v_result->>'status'='ready', 'ready transition');
  v_result := public.skie_record_mux_media_event('mux-event-ready','video.asset.ready','phase2-media-a','uploadphase2a','assetphase2a','playbackphase2a','public',61.25,1.777777,'1080p',null,null,null,'{"status":"ready"}',now());
  perform pg_temp.skie_phase2_mux_assert((v_result->>'duplicate')::boolean and (select count(*)=1 from public.media_provider_events where provider_event_id='mux-event-ready'), 'duplicate idempotency');
  perform pg_temp.skie_phase2_mux_assert((select status='ready' and generated_poster_url='https://image.mux.com/playbackphase2a/thumbnail.webp?time=2.5&fit_mode=preserve' from public.media_video_assets where id=v_asset.id), 'generated poster');
  v_asset := public.skie_manage_media_video_asset(v_admin,v_asset.id,'poster',null,'/manual.jpg',4.25,'https://image.mux.com/playbackphase2a/thumbnail.webp?time=4.25&fit_mode=preserve',null);
  perform pg_temp.skie_phase2_mux_assert(v_asset.manual_poster_url='/manual.jpg' and v_asset.poster_time_seconds=4.25, 'manual poster override');
  v_asset := public.skie_manage_media_video_asset(v_admin,v_asset.id,'captions',null,null,null,null,'[{"id":"en","kind":"captions","label":"English","language":"en-AU","src":"/captions/a.vtt","default":true}]');
  perform pg_temp.skie_phase2_mux_assert(jsonb_array_length(v_asset.captions)=1, 'caption metadata');
  v_asset := public.skie_manage_media_video_asset(v_admin,v_asset.id,'delete');
  perform pg_temp.skie_phase2_mux_assert(v_asset.status='deleted' and v_asset.deleted_at is not null, 'deleted transition');
  v_result := public.skie_record_mux_media_event('mux-event-late-ready','video.asset.ready','phase2-media-a','uploadphase2a','assetphase2a','playbackphase2a','public',61.25,1.777777,'1080p',null,null,null,'{"status":"ready"}',now());
  perform pg_temp.skie_phase2_mux_assert(v_result->>'status'='deleted' and (v_result->>'ignored')::boolean, 'deleted state terminal');

  v_failed := public.skie_create_media_video_asset(v_admin,'phase2-media-b',null,'uploadphase2b','public',1,null);
  v_result := public.skie_record_mux_media_event('mux-event-error','video.asset.errored','phase2-media-b','uploadphase2b','assetphase2b',null,null,null,null,null,'INVALID_INPUT','Mux reported a video processing failure.',null,'{"status":"errored"}',now());
  perform pg_temp.skie_phase2_mux_assert(v_result->>'status'='failed' and (select processing_error_code='INVALID_INPUT' from public.media_video_assets where id=v_failed.id), 'errored transition');
  v_failed := public.skie_manage_media_video_asset(v_admin,v_failed.id,'retry','uploadphase2retry');
  perform pg_temp.skie_phase2_mux_assert(v_failed.status='pending_upload' and v_failed.processing_error_code is null, 'retry transition');
  perform pg_temp.skie_phase2_mux_assert((select count(*)=6 from public.media_video_audit where media_video_asset_id in (v_asset.id,v_failed.id)), 'sensitive action audits');
end;
$$;

select 'PASS|phase2-mux-video-security-lifecycle';
rollback;
