# SKIE EVENTS — Production Foundation v2

A full-stack event operations platform for **SKIE EVENTS**. It includes a premium responsive public website, customer accounts, invite applications, approval-based ticket unlocking, direct checkout, event extras such as drink passes, QR tickets, event-night scanning, an admin control studio, consent-safe exports, email automation adapters, and production deployment foundations.

## What is already implemented

### Public website

- Premium black / white / `#5170FF` visual system
- Homepage hero, upcoming events, previous events and sponsor sections
- Event detail pages with lineup, rules, FAQs, ticket state and event extras
- Media, reviews, about, contact and newsletter pages
- Terms, privacy, refund, entry, media-release and age-policy pages
- Phone, tablet, laptop and large-screen layouts

### Customer system

- Sign up, login and protected account area
- Invite-only applications generated from admin-editable forms
- Application states: pending, approved, hold, waitlist and rejected
- Approved ticket allocations displayed as **unlocked tickets**
- Per-event and per-customer ticket quantity limits, defaulting to 2
- Lightweight checkout with tickets and event extras in one order
- Test checkout and Stripe Checkout adapter
- Orders, tickets, QR codes and event-extra entitlements in the account

### Ticketing and event extras

- Invite-only, direct-purchase, free-RSVP, coming-soon and closed modes
- Ticket allocation expiry and inventory reservation
- Drink passes, upgrades, queue entry, merch and future add-ons
- Per-product stock, max-per-order and max-per-customer controls
- Verified fulfilment only after test payment or signed Stripe webhook
- Unique QR token for every issued ticket
- Duplicate-scan and wrong-event detection
- Manual attendee search and manual door check-in
- Redeemable drink-pass/event-extra balances

### Admin control studio

Open `/skie-control/login`. The route is intentionally absent from public navigation.

Admin sections include:

- Overview
- Events and publishing controls
- Applications and ticket unlocking
- Customers, tags and private notes
- Ticketing, allocations, orders and issued tickets
- Event products / drink passes
- Sponsors
- Application forms
- Media
- Reviews
- Email templates and test outbox
- Consent-safe sponsor exports
- Door check-in
- Website content and legal pages
- Settings and test/live mode
- Audit logs

### Integrations

- **Supabase**: authentication, profiles, durable CMS/operations documents and media storage
- **Stripe**: Checkout Sessions and signed webhook fulfilment
- **Resend**: domain-based email delivery with editable templates and email logs
- **Vercel**: Next.js hosting and server routes
- **Namecheap**: DNS for `skieevents.com`

## Architecture modes

### Local test mode

```env
APP_MODE=test
DATA_PROVIDER=local
```

Local mode uses the JSON files in `data/` and a fake email outbox/payment flow. It is intended for safe localhost testing only.

### Production mode

```env
APP_MODE=live
DATA_PROVIDER=supabase
```

Production uses Supabase persistence, Supabase Auth, Stripe and Resend. Local filesystem writes are not used on Vercel.

## Fast Windows setup

1. Extract the folder.
2. Open PowerShell in the extracted folder.
3. Run:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
.\SETUP.ps1
.\START-LOCAL.ps1
```

4. Open:

- Public website: `http://localhost:3000`
- Admin login: `http://localhost:3000/skie-control/login`

The setup script installs dependencies and creates `.env.local` with random session/ticket secrets. It asks for the local administrator email and password.

## Manual setup

Requirements:

- Node.js `>=20.9.0` (Node 22 is recommended)
- npm

Run:

```bash
npm install
cp .env.example .env.local
npm run dev
```

Edit `.env.local` before logging into the admin route.

## Verification

```bash
npm run verify
```

This runs ESLint, TypeScript checking and an optimized production build.

Optional dependency audit:

```bash
npm audit --omit=dev
```

## Test-mode business flow

1. Create a customer account.
2. Open the published invite-only event.
3. Submit the application and required consents.
4. Log into `/skie-control` as admin.
5. Approve the application and choose ticket quantity/expiry.
6. Log back into the customer account.
7. Open the unlocked allocation and select tickets plus event extras.
8. Complete the fake test checkout.
9. Open the generated QR ticket.
10. Scan it from `/skie-control/check-in`.
11. Scan it again to confirm the duplicate warning.
12. Redeem a drink-pass unit from the scan result.

## Production setup order

1. Create the Supabase project and run `supabase/schema.sql`.
2. Import `supabase/seed.sql`.
3. Configure Supabase Auth URLs and create/promote the first admin.
4. Create Stripe account keys and the webhook endpoint.
5. Verify `skieevents.com` in Resend and add DNS records in Namecheap.
6. Create a GitHub repository and connect it to Vercel.
7. Add all production environment variables in Vercel.
8. Deploy, connect the custom domain and run the launch checklist.

Detailed instructions are in `docs/`.

## Important production boundaries

- No system can be guaranteed impossible to hack. This build uses server-side authentication/roles, same-origin checks, input validation, secure cookies, Supabase RLS, signed Stripe webhooks, hashed QR tokens, audit logs and consent-filtered exports, but it still requires correct production configuration and ongoing updates.
- Test mode is not for real attendee data or real payments.
- `APP_MODE=live` and `DATA_PROVIDER=supabase` must be used on Vercel.
- Real keys belong in `.env.local` and Vercel environment variables, never in Git.
- Alcohol-related drink passes must match the venue's liquor licence and operating rules.
- Legal text in the seed data is a working template, not legal advice. Have Australian legal/privacy/refund wording reviewed before launch.

## Project structure

```text
src/app                 Next.js pages and API routes
src/components          Public, customer, ticket and admin UI
src/lib                 Config, security, data, payment, email and ticket services
src/types/site.ts       Shared domain types
data/                    Local test-mode documents
supabase/                Production schema and seed
public/                  Brand and public assets
docs/                    Deployment, integration, security and testing guides
```

## Working rule for future changes

Do not regenerate the whole project for a small change. Identify the exact affected files, explain the change, and update only those files while preserving database, types, routes and integrations.
