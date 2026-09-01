# Build Report

## Automated checks completed

- ESLint: passed
- TypeScript `tsc --noEmit`: passed
- Next.js optimized production build: passed
- production dependency audit: 0 known vulnerabilities at packaging time

## Functional test-mode flow completed

A temporary local environment and test account were used to verify:

- homepage and event detail response
- customer signup and account session
- invite application submission
- consent records
- admin login and protected snapshot
- application approval
- unlocked allocation with max quantity 2
- one checkout containing 2 tickets and a 3-drink pass
- fake payment fulfilment
- 2 unique QR tickets
- customer ticket page
- public ticket verification
- wrong-event scan result
- successful check-in
- duplicate-scan warning
- attendee search
- drink-pass unit redemption

Temporary user, order, ticket, scan and email data were removed before packaging. `.env.local` was removed.

## Not possible without owner accounts/configuration

- live Supabase Auth/database/storage
- live Stripe Checkout and webhook delivery
- live Resend delivery/domain authentication
- Vercel production deployment
- Namecheap DNS verification
- final legal/liquor/privacy review
- real-world load and external penetration testing

Complete these using the guides in `docs/` before public launch.
