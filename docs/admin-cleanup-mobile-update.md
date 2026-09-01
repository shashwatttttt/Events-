# Admin cleanup and mobile control-panel update

Status: isolated draft branch only. Do not merge or deploy to production.

## Included

- audited super-admin removal of disposable test customers and tickets
- hard blocks for Stripe payments, refunds, disputes, check-ins, redemptions, staff access and unresolved recovery
- removal of approved test records from control-panel projections and analytics without erasing immutable financial history
- mandatory first name, last name, phone, Instagram, email and password at signup
- optional transactional SMS consent remains optional
- off-canvas mobile control-panel navigation with touch-friendly actions and phone layouts
- short customer post-checkout completion target with a longer real form-availability window
- Stripe capture_before remains the absolute approval and payment limit

## Release rule

This branch must remain unmerged until migration review, lint, TypeScript, the complete test suite, production build and a controlled staging review all pass. No production migration or deployment is authorised by this document.
