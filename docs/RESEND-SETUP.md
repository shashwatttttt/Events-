# Resend and Domain Email Setup

## Intended addresses

- Ticket sender: `tickets@skieevents.com`
- Reply/support: `hello@skieevents.com`
- Operational/admin: `admin@skieevents.com`

## Setup

1. Add `skieevents.com` in Resend.
2. Copy the DNS records Resend provides.
3. Add those records in Namecheap Advanced DNS exactly as shown.
4. Wait for verification.
5. Create an API key scoped appropriately for production.
6. Add environment values:

```env
RESEND_API_KEY=re_...
EMAIL_FROM=SKIE EVENTS <tickets@skieevents.com>
EMAIL_REPLY_TO=hello@skieevents.com
```

## Modes

### Test mode

No email leaves the system. Rendered subject/body and status are stored in the admin email outbox.

### Live mode

Templates are rendered and sent through Resend. Success/failure is logged with an idempotency key.

## Deliverability checklist

- domain verified
- sender address matches verified domain
- reply-to monitored
- legal business/contact details included where required
- test Gmail, Outlook and Apple Mail rendering
- avoid large image-only emails
- do not send marketing mail without recorded consent and unsubscribe handling

## Templates

Seed templates are editable in Admin → Emails. Preserve template keys used by code:

- `application_received`
- `ticket_unlocked`
- `waitlist`
- `not_selected`
- `ticket_issued`
