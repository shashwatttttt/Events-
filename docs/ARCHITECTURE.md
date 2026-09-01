# Architecture

## Application layer

The app uses Next.js App Router with server components for data-backed pages and route handlers for mutations/integrations. Client components are limited to interactive forms, checkout controls, QR generation/scanning and the admin studio.

## Data-provider abstraction

`src/lib/data/documents.ts` supports two providers:

- `local`: atomic JSON writes for localhost testing
- `supabase`: service-role access to versioned `platform_documents` rows

The Supabase provider uses optimistic version checks to prevent silent lost updates across concurrent Vercel instances. The local provider serialises mutations and writes through a temporary file followed by rename.

This first-launch document model keeps infrastructure and query load low while preserving the full operational workflow. At high volume, migrate operations into normalized Postgres tables without changing public/admin interfaces.

## Security boundary

Browser code never receives the Supabase service-role key, Stripe secret, webhook secret, Resend key, auth secret or ticket secret.

- public Supabase credentials are client-safe
- service-role/database document access is server-only
- Stripe webhook payloads are verified before fulfilment
- customer ownership and staff roles are checked on the server
- public QR verification returns only safe ticket fields
- ticket token hashes are stored, not raw QR tokens

## Authentication

### Local mode

Customer password hashes use bcrypt. Sessions are HMAC-signed HTTP-only cookies. Local admin credentials come from `.env.local` and comparisons use constant-time hashes.

### Supabase mode

Supabase Auth handles customer/admin sessions. `profiles.role` controls customer, scanner, door, admin and super-admin access. The proxy refreshes auth cookies.

## Payment abstraction

`src/lib/payments/index.ts` returns either:

- a test checkout URL
- a Stripe Checkout Session URL

The order is created before checkout. Ticket fulfilment occurs only through the test completion route or verified Stripe webhook, never because the browser reached a success URL.

## Email abstraction

`src/lib/email/index.ts` evaluates effective test mode. Test sends append to `operations.emailLogs`; live sends through Resend and then log success/failure.

## Main domain documents

### Site document

Brand, homepage, events, ticket types, products, sponsors, forms, media, reviews, templates, legal pages and settings.

### Operations document

Profiles, consents, applications, allocations, orders, payments, tickets, entitlements, scans, email logs, audit logs, contacts and newsletter subscriptions.

## Scaling path

The current Supabase JSONB document model is appropriate for an early event business and reduces operational complexity. Before very high traffic or many simultaneous organisers, normalize at least:

- applications
- allocations
- orders/order items
- payments
- tickets
- entitlements
- check-ins
- email logs
- audit logs

Then use database transactions/functions for stock reservation and check-in. The UI and service method contracts can remain substantially unchanged.
