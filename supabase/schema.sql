-- SKIE EVENTS / SUPABASE FOUNDATION
-- Run this once in a new Supabase project SQL editor.

create extension if not exists pgcrypto;

create type public.user_role as enum ('customer','scanner_only','door_staff','admin','super_admin');

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
create unique index if not exists profiles_email_lower_idx on public.profiles (lower(email));

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, first_name, last_name, email, phone, instagram)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'first_name',''),
    coalesce(new.raw_user_meta_data ->> 'last_name',''),
    coalesce(new.email,''),
    coalesce(new.raw_user_meta_data ->> 'phone',''),
    coalesce(new.raw_user_meta_data ->> 'instagram','')
  ) on conflict (id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert or update of email on auth.users
for each row execute procedure public.handle_new_user();

-- The application uses two durable, server-only JSONB documents for the first launch:
-- site = CMS configuration; operations = customers/applications/orders/tickets/logs.
-- Versioned optimistic updates prevent lost writes across Vercel serverless instances.
create table if not exists public.platform_documents (
  key text primary key check (key in ('site','operations')),
  payload jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
create index if not exists platform_documents_updated_idx on public.platform_documents(updated_at desc);

alter table public.profiles enable row level security;
alter table public.platform_documents enable row level security;

create policy "profiles_select_own" on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles_update_own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
revoke update on table public.profiles from anon, authenticated;
grant update (first_name, last_name, phone, instagram) on public.profiles to authenticated;
-- platform_documents intentionally has no anon/authenticated policies. Only server-side service-role code can access it.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media','media',true,52428800,array['image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm'])
on conflict (id) do update set public=true, file_size_limit=52428800, allowed_mime_types=excluded.allowed_mime_types;

create policy "public_media_read" on storage.objects for select to public using (bucket_id='media');
-- Uploads are performed by the server with the service role. No direct browser upload policy is granted.

-- After creating the first administrator in Supabase Auth, promote them manually:
-- update public.profiles set role='super_admin' where lower(email)=lower('admin@skieevents.com');
