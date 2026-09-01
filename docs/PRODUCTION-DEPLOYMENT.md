# Vercel and Namecheap Deployment

## 1. Prepare Git

Confirm these are not committed:

```text
.env
.env.local
node_modules
.next
```

Run:

```bash
npm run verify
git init
git add .
git commit -m "Skie Events production foundation"
```

Push to a private GitHub repository.

## 2. Create Vercel project

- import the GitHub repository
- framework preset: Next.js
- install command: `npm install`
- build command: `npm run build`
- output settings: default

## 3. Add production environment variables

Use `.env.example` as the inventory. Production must include:

```env
APP_MODE=live
DATA_PROVIDER=supabase
NEXT_PUBLIC_SITE_URL=https://skieevents.com
```

Generate strong, independent values for `AUTH_SECRET` and `TICKET_TOKEN_SECRET`.

## 4. Connect domain

Add `skieevents.com` and optionally `www.skieevents.com` in Vercel. Apply the DNS records Vercel supplies in Namecheap Advanced DNS. Choose one canonical domain and redirect the other.

Vercel provisions HTTPS after DNS verification. Do not buy separate Namecheap hosting or SSL for this stack.

## 5. Add Resend DNS records

Keep the Vercel web records and Resend mail/domain-verification records together in Namecheap. Do not delete MX/TXT/CNAME records without understanding which service uses them.

## 6. Configure external callbacks

- Supabase Site URL and redirect URLs
- Stripe webhook endpoint
- any future analytics domain settings

## 7. Smoke test

- homepage and event pages
- customer signup/confirmation/login
- invite application
- admin approval
- unlocked allocation
- Stripe test payment in production preview
- verified webhook fulfilment
- ticket email
- QR scan and duplicate warning
- sponsor consent export
- mobile layout

## Rollback

Vercel preserves deployments. If a production release fails, promote the previous known-good deployment while investigating. Database/document changes may need separate restoration from Supabase backup.
