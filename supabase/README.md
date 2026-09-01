# Supabase setup

1. Create a Supabase project in the region closest to Melbourne.
2. Run `schema.sql` in the SQL Editor.
3. Run `seed.sql` once.
4. Copy the project URL, anon key, and service-role key into `.env.local` and Vercel.
5. Create the first user through `/signup` or the Supabase dashboard.
6. Promote the administrator with:

```sql
update public.profiles
set role = 'super_admin'
where lower(email) = lower('admin@skieevents.com');
```

7. Set `DATA_PROVIDER=supabase`.
8. Keep `APP_MODE=test` while testing. Live actions require both `APP_MODE=live` and the Admin setting set to Live.

`platform_documents` is server-only and versioned. It keeps the first production release compact and inexpensive while preventing common lost-update races. The service-role key must never be exposed to browser code.

For an existing project created before the profile-role restriction was added, also run:

```text
migrations/20260717_restrict_profile_role_updates.sql
migrations/20260717_repair_application_consents.sql
```

These revoke customer access to the `role` column and repair the legacy application consent fields.
