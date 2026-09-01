# Project Status

This folder is the v2 production foundation built from the earlier localhost prototype.

Implemented in this delivery:

- public premium website
- customer authentication/account foundation
- invite application and approval workflow
- unlocked ticket allocation/cart flow
- direct/free ticket modes
- event products and drink passes
- test and Stripe payment adapters
- email outbox and Resend adapter
- unique QR ticket generation
- door scanning, manual lookup and redemption
- admin control studio
- Supabase schema/seed/storage/auth foundation
- consent-safe export and audit trail
- deployment/security/testing documentation

Still requires external configuration before public launch:

- real Supabase project and first admin
- Stripe account/webhook
- Resend domain verification
- Vercel/GitHub deployment
- Namecheap DNS
- final content/assets/legal review
- live integration and load/security testing

Recommended post-launch work:

- normalize high-volume operational tables
- distributed rate limiting
- automated payment reminders and scheduled event reminders
- Stripe refund/chargeback automation
- Apple/Google Wallet
- multi-organiser tenancy
- advanced analytics/referrals/loyalty
