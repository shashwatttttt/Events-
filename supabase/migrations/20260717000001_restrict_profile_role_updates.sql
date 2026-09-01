-- Apply this migration to existing projects created from an earlier schema.
-- Customers may edit profile details, but roles remain service-role/admin managed.
begin;

revoke update on table public.profiles from anon, authenticated;
grant update (first_name, last_name, phone, instagram) on public.profiles to authenticated;

commit;
