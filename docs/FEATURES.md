# Feature and Workflow Map

## Event lifecycle

Events support:

- `draft`
- `preview`
- `published`
- `archived`
- `cancelled`

Visibility supports public, hidden, private-link, password-protected, coming-soon and archived experiences. Public listing logic hides drafts/cancelled/hidden events while direct pages enforce lifecycle and visibility rules.

## Ticket modes

### Invite only

`application → review → approval → allocation unlocked → customer checkout → verified payment → ticket issued`

Approval creates a `TicketAllocation` with:

- customer
- event
- selected ticket type
- maximum quantity
- purchased quantity
- price snapshot
- expiry
- approving administrator

### Direct purchase

A logged-in customer selects an active ticket type and optional event products. Per-customer, ticket-type and event-capacity rules are checked server-side.

### Free RSVP

Uses the same order/ticket machinery with a zero-price ticket type. The test/live checkout provider can be extended to bypass Stripe for zero-dollar orders.

### Coming soon / closed

Checkout routes reject unavailable event states server-side even if a user manipulates the frontend.

## Cart and inventory

The cart is intentionally lightweight:

- no persistent cart is created for anonymous browsing
- an order is created only when a logged-in customer begins checkout
- pending orders reserve stock for one hour
- expired pending orders release their reservation
- allocation, customer, ticket-type, public-capacity and product limits are checked in the serialized/optimistic document mutation
- Stripe fulfilment is idempotent

## Event products

Admin can create event-specific:

- drink passes
- add-ons
- VIP upgrades
- merchandise
- table deposits

Each product stores price in cents, stock, per-order limit, per-customer limit, sale window, approval requirement, ticket requirement, redeemable state and public visibility.

Paid redeemable products create entitlements. `unitsPerPurchase` controls how many redemption units each purchase grants, so a “3 Drink Pass” grants three units without hardcoded product naming.

## QR ticket security

Every issued ticket has:

- random ticket ID
- human-readable ticket code
- event/customer/order references
- deterministic HMAC token
- only a SHA-256 hash of the token stored in data
- one-time check-in status

The QR carries a verification URL. Door check-in validates the token against the stored hash and checks event/status before changing the ticket.

## Door mode

`/skie-control/check-in` supports:

- phone camera scanning
- pasted QR verification
- name/email/ticket-code search
- manual check-in
- wrong-event result
- duplicate result
- cancelled/refunded/expired result
- event-extra balances
- one-unit entitlement redemption
- scan and redemption audit logs

## Email system

Templates are stored in the site document and can be edited in admin. Test mode writes to the fake outbox. Live mode sends through Resend. Every send uses an idempotency key and produces an email log.

Included workflow templates cover application receipt, ticket unlock, waitlist, not selected and ticket issued. Additional templates can be added through the admin data model.

## Sponsor and consent system

Applications record accepted consent wording, policy version, timestamp, event and a hashed IP where available. Sponsor export only includes profiles with accepted sponsor consent for the selected event. The export action is recorded in the audit log.

## Admin safety

- protected routes and APIs
- role checks on every sensitive server action
- same-origin checks for state-changing browser requests
- confirmation patterns should be retained for destructive actions
- audit logs for approvals, customer edits, orders, payments, scans, redemption and exports
