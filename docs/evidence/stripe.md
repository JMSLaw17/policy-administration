# Stripe evidence (test mode)

Collected 2026-11-12 11:51:06 UTC from Stripe's API with a test-mode key. Nothing here involves real money.

## Webhook endpoint

| Address | Status | Events subscribed |
|---|---|---|
| https://policy-administration.vercel.app/api/stripe/webhook | enabled | payment_intent.succeeded, payment_intent.payment_failed, payment_intent.processing, payment_intent.canceled, refund.created, refund.updated, refund.failed |

## Events Stripe sent to the webhook

Newest first. "Waiting" is how many webhook deliveries Stripe still has outstanding for that event; 0 means the app acknowledged it.
One Stripe test account serves the deployed app, local development, and the automated tests. This list shows the 6 events for policies on the deployed app, out of the 149 most recent; the rest came from local and automated testing.

| Time (UTC) | Event | Object | Amount | Status | Policy | Waiting |
|---|---|---|---|---|---|---|
| 2026-11-12 11:20:39 | `refund.updated` | `re_3Uaw3QGiG…` | $14.00 | succeeded | SBP-2026-0001 | 0 |
| 2026-11-12 11:20:38 | `refund.created` | `re_3Uaw3QGiG…` | $14.00 | succeeded | SBP-2026-0001 | 0 |
| 2026-11-12 11:20:35 | `payment_intent.succeeded` | `pi_3Uaw3QGiG…` | $728.00 | succeeded | SBP-2026-0001 | 0 |
| 2026-11-11 20:07:25 | `payment_intent.succeeded` | `pi_3UahnYGiG…` | $1095.00 | succeeded | SBP-2026-0001 | 0 |
| 2026-11-11 20:07:11 | `payment_intent.canceled` | `pi_3UahmlGiG…` | $1095.00 | canceled | SBP-2026-0001 | 0 |
| 2026-11-11 20:06:52 | `payment_intent.payment_failed` | `pi_3UahmlGiG…` | $1095.00 | requires_payment_method | SBP-2026-0001 | 0 |

## Refunds

| Time (UTC) | Refund | Amount | Status | Policy | Against payment |
|---|---|---|---|---|---|
| 2026-11-12 11:20:38 | `re_3Uaw3QGiG…` | $14.00 | succeeded | SBP-2026-0001 | `pi_3Uaw3QGiG…` |
