# Supabase Setup

## 1. Create a project

Create a Supabase project in the region appropriate for the business. Save:

- Project URL
- anon/public key
- service-role key

Never put the service-role key in any `NEXT_PUBLIC_` variable.

## 2. Run schema and seed

Open the Supabase SQL editor and run:

1. `supabase/schema.sql`
2. `supabase/seed.sql`

The schema creates:

- `profiles`
- user-role enum
- auth profile trigger
- RLS policies for profile ownership
- server-only `platform_documents`
- public media storage bucket

The seed inserts the initial site and empty operations documents.

## 3. Configure Auth

Set the Site URL to the production origin:

```text
https://skieevents.com
```

Add redirect URLs for production and local development:

```text
https://skieevents.com/auth/callback
https://*.vercel.app/auth/callback
http://localhost:3000/auth/callback
```

Email confirmation can remain enabled. The app exchanges the confirmation code at `/auth/callback`.

## 4. Create first administrator

1. Sign up the intended administrator through Supabase Auth or the website.
2. Run:

```sql
update public.profiles
set role = 'super_admin'
where lower(email) = lower('admin@skieevents.com');
```

Do not expose a public “make admin” endpoint.

## 5. Environment values

```env
DATA_PROVIDER=supabase
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

## 6. Storage

Admin uploads go through a protected server route and are uploaded to the `media` bucket. Browser users receive only public asset URLs.

## 7. Backup and recovery

Before major admin changes or launch:

- export both `platform_documents` rows
- enable Supabase backups appropriate to the business plan
- keep source control for schema and seed files
- never treat the seed file as a backup of live attendee data
