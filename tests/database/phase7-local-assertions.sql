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
begin
  select id into v_admin from public.profiles where role in ('admin','super_admin') order by id limit 1;
  perform pg_temp.skie_assert(to_regclass('public.media_objects') is not null, 'media registry table');
  perform pg_temp.skie_assert((select relrowsecurity from pg_class where oid='public.media_objects'::regclass), 'media registry RLS');
  perform pg_temp.skie_assert(not has_table_privilege('anon','public.media_objects','SELECT,INSERT,UPDATE,DELETE'), 'media registry anon grants');
  perform pg_temp.skie_assert(not has_table_privilege('authenticated','public.media_objects','SELECT,INSERT,UPDATE,DELETE'), 'media registry authenticated grants');
  perform pg_temp.skie_assert((select file_size_limit=52428800 from storage.buckets where id='media'), 'media bucket size');
  perform pg_temp.skie_assert((select allowed_mime_types @> array['image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm']
    and not allowed_mime_types && array['image/svg+xml','image/gif'] from storage.buckets where id='media'), 'media bucket MIME allowlist');
  perform pg_temp.skie_assert(exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='public_media_read' and cmd='SELECT'), 'public media read');
  perform pg_temp.skie_assert(not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and cmd in ('INSERT','UPDATE','DELETE') and ('anon'=any(roles) or 'authenticated'=any(roles))), 'no public media writes');

  insert into public.media_objects(bucket_id,object_key,public_url,kind,mime_type,size_bytes,uploaded_by)
    values ('media','images/2026/07/00000000-0000-0000-0000-000000000007.jpg','/uploads/images/2026/07/00000000-0000-0000-0000-000000000007.jpg','image','image/jpeg',128,v_admin);
  perform pg_temp.skie_assert((select status='orphan' and orphaned_at is not null from public.media_objects where object_key like '%000000000007.jpg'), 'media orphan default');
  begin
    insert into public.media_objects(bucket_id,object_key,public_url,kind,mime_type,size_bytes,uploaded_by)
      values ('media','../unsafe.svg','/unsafe.svg','image','image/svg+xml',10,v_admin);
    raise exception 'expected unsafe object rejection';
  exception when check_violation then null;
  end;
end;
$$;

select 'PASS|phase7-media-catalog-storage-security';
rollback;
