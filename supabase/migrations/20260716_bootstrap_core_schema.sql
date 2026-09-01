-- SKIE EVENTS core schema bootstrap.
-- Schema only: seed/demo documents remain in supabase/seed.sql.
-- This migration must sort before every 20260717 and 20260721 migration.

begin;

create extension if not exists pgcrypto;

do $bootstrap_user_role$
declare
  existing_labels text[];
begin
  if to_regtype('public.user_role') is null then
    create type public.user_role as enum (
      'customer',
      'scanner_only',
      'door_staff',
      'admin',
      'super_admin'
    );
  else
    if not exists (
      select 1
      from pg_type
      join pg_namespace on pg_namespace.oid = pg_type.typnamespace
      where pg_namespace.nspname = 'public'
        and pg_type.typname = 'user_role'
        and pg_type.typtype = 'e'
    ) then
      raise exception using
        errcode = '42804',
        message = 'public.user_role exists but is not an enum';
    end if;

    select array_agg(pg_enum.enumlabel::text order by pg_enum.enumsortorder)
      into existing_labels
    from pg_enum
    join pg_type on pg_type.oid = pg_enum.enumtypid
    join pg_namespace on pg_namespace.oid = pg_type.typnamespace
    where pg_namespace.nspname = 'public'
      and pg_type.typname = 'user_role';

    if existing_labels is distinct from array[
      'customer',
      'scanner_only',
      'door_staff',
      'admin',
      'super_admin'
    ]::text[] then
      raise exception using
        errcode = '42804',
        message = 'existing public.user_role labels do not match the SKIE EVENTS role contract';
    end if;
  end if;
end;
$bootstrap_user_role$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  email text not null,
  phone text not null default '',
  instagram text not null default '',
  role public.user_role not null default 'customer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_email_lower_idx
  on public.profiles (lower(email));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles (id, first_name, last_name, email, phone, instagram)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'first_name', ''),
    coalesce(new.raw_user_meta_data ->> 'last_name', ''),
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    coalesce(new.raw_user_meta_data ->> 'instagram', '')
  )
  on conflict (id) do update
  set email = excluded.email,
      updated_at = now();

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert or update of email on auth.users
for each row execute function public.handle_new_user();

-- Durable server-only JSONB documents. The two rows are created by seed.sql,
-- after every migration has completed.
create table if not exists public.platform_documents (
  key text primary key check (key in ('site', 'operations')),
  payload jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

create index if not exists platform_documents_updated_idx
  on public.platform_documents (updated_at desc);

alter table public.profiles enable row level security;
alter table public.platform_documents enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
on public.profiles
for select
to authenticated
using (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

revoke all on table public.profiles from public, anon, authenticated;
revoke update (id, email, role, created_at, updated_at)
  on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (first_name, last_name, phone, instagram)
  on table public.profiles to authenticated;
grant select, insert, update, delete on table public.profiles to service_role;

-- No anon/authenticated policy or privilege is granted for platform_documents.
revoke all on table public.platform_documents from public, anon, authenticated;
grant select, insert, update, delete
  on table public.platform_documents to service_role;

-- The matching bucket configuration is seed data in supabase/seed.sql. Keeping
-- the row there makes this bootstrap migration schema-only.
drop policy if exists public_media_read on storage.objects;
create policy public_media_read
on storage.objects
for select
to public
using (bucket_id = 'media');

-- Uploads remain server/service-role only: no insert, update, or delete policy is
-- created for anon or authenticated users on storage.objects.

commit;
