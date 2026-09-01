# Security Model and Operations

## Implemented controls

- HTTP-only, same-site signed local sessions
- Supabase Auth session refresh for production
- server-side ownership and role checks
- customer/admin/door/scanner role separation
- same-origin checks on browser state mutations
- Zod validation for authentication, applications, checkout and public forms
- bcrypt local password hashing
- constant-time local admin credential comparison
- Supabase RLS for profiles
- column-level Supabase grants preventing customers from changing staff roles
- service-role-only platform documents and media uploads
- Stripe raw-body signature verification
- payment fulfilment idempotency
- QR HMAC tokens with stored SHA-256 hashes
- duplicate and wrong-event scan protection
- ticket/product reservation checks
- consent-filtered sponsor export
- audit and email logs
- security headers and restrictive camera permission
- no secrets in client variables or source package

## Required production actions

- replace all placeholder secrets
- apply `supabase/migrations/20260717_restrict_profile_role_updates.sql` to existing Supabase projects
- use Supabase in production
- make GitHub repository private
- enable MFA for Vercel, Supabase, Stripe, Resend, Namecheap and GitHub
- create individual staff accounts; never share admin passwords
- give scanner staff the lowest role needed
- monitor dependency/security advisories
- review logs before and after events
- test backups and recovery
- arrange an external security review before handling large volumes or high-value events

## Rate limiting

The included limiter is in-memory and useful for local/single-instance protection. Vercel instances do not share memory. Before a high-profile public launch, connect a distributed rate limiter such as a managed Redis/KV service and retain the same `rateLimit` service interface.

## Content security policy

The app includes baseline security headers. A strict Content Security Policy is not hardcoded because Stripe, Supabase, Resend-hosted assets and analytics domains depend on the final setup. Add and test a CSP after final domains/integrations are known.

## Privacy

Collect only data needed for applications, tickets and event operations. Keep private notes out of exports. Sponsor export is consent-filtered and logged. Review retention/deletion rules and Australian privacy obligations before launch.

## Incident response

If credentials or customer data may be exposed:

1. disable affected keys/accounts
2. rotate Supabase service role, Stripe, Resend, auth and ticket secrets
3. preserve logs
4. assess affected data and legal notification duties
5. deploy corrected code
6. invalidate/reissue tickets if ticket secret exposure is suspected
