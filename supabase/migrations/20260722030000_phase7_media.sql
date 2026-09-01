-- SKIE EVENTS Phase 7 media object registry and hardened bucket configuration.
-- Existing objects remain readable; browser writes remain prohibited.

begin;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('media','media',true,52428800,array['image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm'])
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.media_objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null check (bucket_id = 'media'),
  object_key text not null unique check (
    object_key ~ '^(images|videos)/[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}\.(jpg|png|webp|avif|mp4|webm)$'
    and object_key !~ '(\.\.|\\)'
  ),
  public_url text not null unique check (length(public_url) between 1 and 2000),
  kind text not null check (kind in ('image','video')),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  status text not null default 'orphan' check (status in ('orphan','referenced','deleted')),
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  deleted_by uuid references public.profiles(id) on delete restrict,
  referenced_at timestamptz,
  orphaned_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'deleted') = (deleted_at is not null))
);

create index if not exists media_objects_cleanup_idx on public.media_objects(status, orphaned_at)
where status = 'orphan';

drop trigger if exists media_objects_touch_updated_at on public.media_objects;
create trigger media_objects_touch_updated_at before update on public.media_objects
for each row execute function public.skie_touch_updated_at();

alter table public.media_objects enable row level security;
revoke all on table public.media_objects from public, anon, authenticated;
grant select, insert, update, delete on table public.media_objects to service_role;

-- Keep public reads for published assets. There is deliberately no browser
-- INSERT/UPDATE/DELETE policy on storage.objects.
drop policy if exists public_media_read on storage.objects;
create policy public_media_read on storage.objects for select to public using (bucket_id = 'media');

commit;
