-- SKIE EVENTS launch Phase 2: Mux-ready video lifecycle and poster metadata.
-- Forward-only migration. No provider calls and no seed data.

begin;

create table if not exists public.media_video_assets (
  id uuid primary key default gen_random_uuid(),
  media_item_id text not null unique check (media_item_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  event_id text check (event_id is null or event_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  provider text not null default 'mux' check (provider = 'mux'),
  status text not null default 'pending_upload' check (status in ('pending_upload','uploaded','processing','ready','failed','deleted')),
  provider_upload_id text not null unique check (provider_upload_id ~ '^[A-Za-z0-9_-]{6,200}$'),
  provider_asset_id text unique check (provider_asset_id is null or provider_asset_id ~ '^[A-Za-z0-9_-]{6,200}$'),
  playback_id text unique check (playback_id is null or playback_id ~ '^[A-Za-z0-9]{6,200}$'),
  playback_policy text not null check (playback_policy in ('public','signed')),
  duration_seconds numeric check (duration_seconds is null or duration_seconds between 0 and 86400),
  aspect_ratio numeric check (aspect_ratio is null or aspect_ratio between 0.1 and 10),
  max_resolution text check (max_resolution is null or max_resolution ~ '^[0-9]{3,4}p$'),
  processing_error_code text check (processing_error_code is null or length(processing_error_code) between 1 and 100),
  processing_error_message text check (processing_error_message is null or length(processing_error_message) between 1 and 500),
  sanitized_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(sanitized_metadata) = 'object' and pg_column_size(sanitized_metadata) <= 8192),
  generated_poster_url text check (generated_poster_url is null or length(generated_poster_url) between 1 and 2000),
  poster_time_seconds numeric not null default 1 check (poster_time_seconds between 0 and 86400),
  manual_poster_url text check (manual_poster_url is null or length(manual_poster_url) between 1 and 2000),
  fallback_poster_url text check (fallback_poster_url is null or length(fallback_poster_url) between 1 and 2000),
  captions jsonb not null default '[]'::jsonb check (jsonb_typeof(captions) = 'array' and jsonb_array_length(captions) <= 10 and pg_column_size(captions) <= 16384),
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid not null references public.profiles(id) on delete restrict,
  deleted_by uuid references public.profiles(id) on delete restrict,
  uploaded_at timestamptz,
  ready_at timestamptz,
  failed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'ready' or (provider_asset_id is not null and playback_id is not null)),
  check ((status = 'deleted') = (deleted_at is not null))
);

create index if not exists media_video_assets_status_idx on public.media_video_assets(status, updated_at desc);
create index if not exists media_video_assets_event_idx on public.media_video_assets(event_id, status, updated_at desc);

create table if not exists public.media_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider = 'mux'),
  provider_event_id text not null check (length(provider_event_id) between 1 and 200),
  event_type text not null check (length(event_type) between 1 and 100),
  media_video_asset_id uuid references public.media_video_assets(id) on delete restrict,
  provider_created_at timestamptz,
  sanitized_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(sanitized_payload) = 'object' and pg_column_size(sanitized_payload) <= 8192),
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create index if not exists media_provider_events_asset_idx on public.media_provider_events(media_video_asset_id, received_at desc);

create table if not exists public.media_video_audit (
  id uuid primary key default gen_random_uuid(),
  media_video_asset_id uuid not null references public.media_video_assets(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (action in ('upload_intent_created','retry_created','poster_updated','captions_updated','deleted')),
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata) = 'object' and pg_column_size(safe_metadata) <= 4096),
  created_at timestamptz not null default now()
);

create index if not exists media_video_audit_asset_idx on public.media_video_audit(media_video_asset_id, created_at desc);

do $$
declare table_name text;
begin
  foreach table_name in array array['media_video_assets','media_provider_events','media_video_audit'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public,anon,authenticated', table_name);
    execute format('grant select,insert,update,delete on table public.%I to service_role', table_name);
  end loop;
end;
$$;

create or replace function public.skie_create_media_video_asset(
  p_actor_id uuid, p_media_item_id text, p_event_id text, p_provider_upload_id text,
  p_playback_policy text, p_poster_time_seconds numeric, p_fallback_poster_url text
)
returns public.media_video_assets
language plpgsql security definer set search_path = public
as $$
declare v_role public.user_role; v_item public.media_video_assets;
begin
  select role into v_role from public.profiles where id = p_actor_id;
  if v_role not in ('admin','super_admin') then raise exception using errcode='42501',message='FORBIDDEN'; end if;
  if p_media_item_id !~ '^[A-Za-z0-9_-]{1,100}$'
    or (p_event_id is not null and p_event_id !~ '^[A-Za-z0-9_-]{1,100}$')
    or p_provider_upload_id !~ '^[A-Za-z0-9_-]{6,200}$'
    or p_playback_policy not in ('public','signed')
    or p_poster_time_seconds not between 0 and 86400
    or (p_fallback_poster_url is not null and length(p_fallback_poster_url) not between 1 and 2000) then
    raise exception using errcode='22023',message='INVALID_MEDIA_VIDEO_ASSET';
  end if;
  insert into public.media_video_assets(media_item_id,event_id,provider_upload_id,playback_policy,poster_time_seconds,fallback_poster_url,created_by,updated_by)
    values (p_media_item_id,p_event_id,p_provider_upload_id,p_playback_policy,p_poster_time_seconds,p_fallback_poster_url,p_actor_id,p_actor_id)
    returning * into v_item;
  insert into public.media_video_audit(media_video_asset_id,actor_id,action,safe_metadata)
    values (v_item.id,p_actor_id,'upload_intent_created',jsonb_build_object('eventId',p_event_id,'playbackPolicy',p_playback_policy));
  return v_item;
end;
$$;

create or replace function public.skie_record_mux_media_event(
  p_provider_event_id text, p_event_type text, p_media_item_id text, p_provider_upload_id text,
  p_provider_asset_id text, p_playback_id text, p_playback_policy text,
  p_duration_seconds numeric, p_aspect_ratio numeric, p_max_resolution text,
  p_error_code text, p_error_message text, p_generated_poster_url text,
  p_sanitized_payload jsonb, p_provider_created_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_item public.media_video_assets; v_event_id uuid; v_duplicate boolean := false; v_status text;
begin
  if length(trim(p_provider_event_id)) not between 1 and 200
    or p_event_type not in ('video.upload.created','video.upload.asset_created','video.upload.cancelled','video.upload.errored',
      'video.asset.created','video.asset.preparing','video.asset.ready','video.asset.errored','video.asset.deleted')
    or jsonb_typeof(coalesce(p_sanitized_payload,'{}'::jsonb)) <> 'object'
    or pg_column_size(coalesce(p_sanitized_payload,'{}'::jsonb)) > 8192 then
    raise exception using errcode='22023',message='INVALID_MUX_EVENT';
  end if;
  select * into v_item from public.media_video_assets where
    (p_provider_upload_id is not null and provider_upload_id=p_provider_upload_id)
    or (p_provider_asset_id is not null and provider_asset_id=p_provider_asset_id)
    or (p_media_item_id is not null and media_item_id=p_media_item_id)
    order by created_at desc limit 1 for update;
  insert into public.media_provider_events(provider,provider_event_id,event_type,media_video_asset_id,provider_created_at,sanitized_payload)
    values ('mux',trim(p_provider_event_id),p_event_type,v_item.id,p_provider_created_at,coalesce(p_sanitized_payload,'{}'::jsonb))
    on conflict (provider,provider_event_id) do nothing returning id into v_event_id;
  if v_event_id is null then v_duplicate := true; end if;
  if v_duplicate or v_item.id is null then
    return jsonb_build_object('matched',v_item.id is not null,'duplicate',v_duplicate,'status',v_item.status);
  end if;
  if v_item.status='deleted' and p_event_type<>'video.asset.deleted' then
    return jsonb_build_object('matched',true,'duplicate',false,'assetId',v_item.id,'status',v_item.status,'ignored',true);
  end if;
  v_status := case
    when p_event_type = 'video.upload.asset_created' then 'uploaded'
    when p_event_type in ('video.asset.created','video.asset.preparing') then 'processing'
    when p_event_type = 'video.asset.ready' then 'ready'
    when p_event_type in ('video.upload.cancelled','video.upload.errored','video.asset.errored') then 'failed'
    when p_event_type = 'video.asset.deleted' then 'deleted'
    else v_item.status end;
  update public.media_video_assets set
    status=v_status,
    provider_asset_id=coalesce(p_provider_asset_id,provider_asset_id),
    playback_id=case when p_event_type='video.asset.ready' then coalesce(p_playback_id,playback_id) else playback_id end,
    playback_policy=case when p_event_type='video.asset.ready' then coalesce(p_playback_policy,playback_policy) else playback_policy end,
    duration_seconds=case when p_event_type='video.asset.ready' then p_duration_seconds else duration_seconds end,
    aspect_ratio=case when p_event_type='video.asset.ready' then p_aspect_ratio else aspect_ratio end,
    max_resolution=case when p_event_type='video.asset.ready' then p_max_resolution else max_resolution end,
    generated_poster_url=case when p_event_type='video.asset.ready' and p_playback_id is not null
      then 'https://image.mux.com/' || p_playback_id || '/thumbnail.webp?time=' || poster_time_seconds::text || '&fit_mode=preserve'
      when p_event_type='video.asset.ready' then p_generated_poster_url else generated_poster_url end,
    processing_error_code=case when v_status='failed' then left(coalesce(p_error_code,'MUX_PROCESSING_FAILED'),100) when v_status='ready' then null else processing_error_code end,
    processing_error_message=case when v_status='failed' then left(coalesce(p_error_message,'Video processing failed.'),500) when v_status='ready' then null else processing_error_message end,
    sanitized_metadata=coalesce(p_sanitized_payload,'{}'::jsonb),
    uploaded_at=case when p_event_type='video.upload.asset_created' then now() else uploaded_at end,
    ready_at=case when v_status='ready' then now() else ready_at end,
    failed_at=case when v_status='failed' then now() else failed_at end,
    deleted_at=case when v_status='deleted' then now() else null end,
    updated_at=now()
  where id=v_item.id returning * into v_item;
  return jsonb_build_object('matched',true,'duplicate',false,'assetId',v_item.id,'status',v_item.status);
end;
$$;

create or replace function public.skie_manage_media_video_asset(
  p_actor_id uuid, p_media_video_asset_id uuid, p_action text, p_provider_upload_id text default null,
  p_manual_poster_url text default null, p_poster_time_seconds numeric default null,
  p_generated_poster_url text default null, p_captions jsonb default null
)
returns public.media_video_assets
language plpgsql security definer set search_path = public
as $$
declare v_role public.user_role; v_item public.media_video_assets; v_audit_action text;
begin
  select role into v_role from public.profiles where id=p_actor_id;
  if v_role not in ('admin','super_admin') then raise exception using errcode='42501',message='FORBIDDEN'; end if;
  select * into v_item from public.media_video_assets where id=p_media_video_asset_id for update;
  if not found then raise exception using errcode='P0002',message='MEDIA_VIDEO_ASSET_NOT_FOUND'; end if;
  if p_action='retry' then
    if v_item.status <> 'failed' or p_provider_upload_id !~ '^[A-Za-z0-9_-]{6,200}$' then raise exception using errcode='P0001',message='MEDIA_VIDEO_NOT_RETRYABLE'; end if;
    update public.media_video_assets set status='pending_upload',provider_upload_id=p_provider_upload_id,provider_asset_id=null,playback_id=null,
      generated_poster_url=null,processing_error_code=null,processing_error_message=null,uploaded_at=null,ready_at=null,failed_at=null,deleted_at=null,
      updated_by=p_actor_id,updated_at=now() where id=v_item.id returning * into v_item;
    v_audit_action := 'retry_created';
  elsif p_action='poster' then
    if (p_manual_poster_url is not null and length(p_manual_poster_url) not between 1 and 2000)
      or p_poster_time_seconds is null or p_poster_time_seconds not between 0 and 86400 then raise exception using errcode='22023',message='INVALID_MEDIA_POSTER'; end if;
    update public.media_video_assets set manual_poster_url=nullif(trim(p_manual_poster_url),''),poster_time_seconds=p_poster_time_seconds,
      generated_poster_url=nullif(trim(p_generated_poster_url),''),updated_by=p_actor_id,updated_at=now()
      where id=v_item.id returning * into v_item;
    v_audit_action := 'poster_updated';
  elsif p_action='captions' then
    if jsonb_typeof(p_captions)<>'array' or jsonb_array_length(p_captions)>10 or pg_column_size(p_captions)>16384 then raise exception using errcode='22023',message='INVALID_MEDIA_CAPTIONS'; end if;
    update public.media_video_assets set captions=p_captions,updated_by=p_actor_id,updated_at=now() where id=v_item.id returning * into v_item;
    v_audit_action := 'captions_updated';
  elsif p_action='delete' then
    update public.media_video_assets set status='deleted',deleted_by=p_actor_id,deleted_at=now(),updated_by=p_actor_id,updated_at=now()
      where id=v_item.id returning * into v_item;
    v_audit_action := 'deleted';
  else raise exception using errcode='22023',message='INVALID_MEDIA_VIDEO_ACTION';
  end if;
  insert into public.media_video_audit(media_video_asset_id,actor_id,action,safe_metadata)
    values (v_item.id,p_actor_id,v_audit_action,jsonb_build_object('status',v_item.status));
  return v_item;
end;
$$;

do $$
declare signature text;
begin
  foreach signature in array array[
    'public.skie_create_media_video_asset(uuid,text,text,text,text,numeric,text)',
    'public.skie_record_mux_media_event(text,text,text,text,text,text,text,numeric,numeric,text,text,text,text,jsonb,timestamp with time zone)',
    'public.skie_manage_media_video_asset(uuid,uuid,text,text,text,numeric,text,jsonb)'
  ] loop
    execute format('revoke all on function %s from public,anon,authenticated',signature);
    execute format('grant execute on function %s to service_role',signature);
  end loop;
end;
$$;

commit;
