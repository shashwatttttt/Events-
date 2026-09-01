# SKIE Events Meta ads integration

## Dataset

- Meta Dataset / Pixel ID: `1738508524058416`
- Browser tracking: Meta Pixel, loaded only after current-version advertising consent
- Server tracking: direct Meta Conversions API
- Admin dashboard: `SKIE Control -> Analytics`

## Production environment settings

Add these in Vercel. The access token is a secret and must never be committed, pasted into issues, logs, screenshots or support messages.

```text
NEXT_PUBLIC_META_PIXEL_ID=1738508524058416
META_GRAPH_API_VERSION=<version shown by Meta's direct integration setup>
META_CONVERSIONS_API_TOKEN=<secret token generated in Meta Events Manager>
META_CONVERSIONS_API_ENABLED=true
META_ADS_CONSENT_VERSION=2026-07-30
```

For controlled verification only:

```text
META_TEST_EVENT_CODE=<temporary code from Events Manager -> Test events>
```

Remove `META_TEST_EVENT_CODE` and redeploy after controlled verification succeeds.

## Event definitions

| SKIE lifecycle action | Meta event | Source |
| --- | --- | --- |
| Public page view | `PageView` | Browser, after consent |
| Public event detail view | `ViewContent` | Browser, after consent |
| Customer account created | `CompleteRegistration` | Server, after consent |
| Invite application submitted | `Lead` | Server, after consent |
| Post-checkout form submitted | `Lead` | Server, after consent |
| Paid checkout created | `InitiateCheckout` | Server, after consent |
| Verified paid order fulfilled and tickets issued | `Purchase` | Server, after consent |

`Purchase` must never be emitted on checkout creation, card authorisation, application submission, approval alone, or payment receipt without successful fulfilment.

## Privacy boundaries

The durable Meta delivery ledger may store operational event references, order value/currency, safe Meta browser identifiers (`_fbp`, `_fbc`) and delivery state. It must not store:

- application answers or drafts
- passwords or access tokens
- payment-card data
- raw email addresses or phone numbers
- IP addresses or user agents
- admin notes
- raw Meta response payloads

Email, phone and internal customer ID are normalized and SHA-256 hashed only when an authorised server delivery is prepared. Hashing does not make matched data anonymous, so the integration remains consent-bound.

## Controlled launch verification

1. Keep PR/release in test mode.
2. Add the temporary Meta Test Event Code in Vercel and redeploy.
3. Open Events Manager -> Test events for the SKIE dataset.
4. In the preview deployment, reject optional tracking and verify that no Pixel script, `_fbp` cookie or browser event is created.
5. Accept advertising and verify `PageView`.
6. Open an event detail page and verify one `ViewContent`, not duplicates.
7. In SKIE Control -> Analytics, confirm Pixel/CAPI health.
8. Use `Send test event` and verify the server event appears in Meta Test events.
9. Complete controlled registration, application and checkout lifecycle tests using approved test procedures.
10. Verify `Purchase` appears only after successful capture/payment and ticket fulfilment.
11. Verify the dashboard shows sent, queued/retry, failed and skipped outcomes without customer PII.
12. Remove `META_TEST_EVENT_CODE`, redeploy and confirm Test Events mode is off.

## Monitoring

The production operations worker retries queued and transiently failed deliveries. Stale `sending` records become reclaimable after ten minutes, and records reaching the retry limit are marked with the safe code `META_RETRY_LIMIT_REACHED`.

Use SKIE Control -> Analytics to review:

- configuration readiness
- server delivery rate
- queued/retry events
- failures and privacy/match-data skips
- fulfilled gross purchase value sent to Meta
- privacy-safe recent delivery results

Meta purchase value is an advertising measurement value and does not subtract later refunds. Use SKIE's first-party revenue and payment records for accounting.

## Emergency disable / rollback

To stop all server delivery immediately:

```text
META_CONVERSIONS_API_ENABLED=false
```

Redeploy after changing the setting. Queued records remain durable but are not sent while disabled.

To stop browser tracking without removing code, clear or change `NEXT_PUBLIC_META_PIXEL_ID` and redeploy. A code rollback can also remove the tracking component. Existing customers can always reject optional advertising through the `Privacy choices` control.

Rotate the Meta access token immediately if it may have been exposed. Never reuse a compromised token.
