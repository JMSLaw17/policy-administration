# Stripe evidence (test mode)

Collected 2026-11-12 14:26:36 UTC from Stripe's API with a test-mode key. Nothing here involves real money.

## Webhook endpoint

| Address | Status | Events subscribed |
|---|---|---|
| https://policy-administration.vercel.app/api/stripe/webhook | enabled | payment_intent.succeeded, payment_intent.payment_failed, payment_intent.processing, payment_intent.canceled, refund.created, refund.updated, refund.failed |

## Events Stripe sent to the webhook

Newest first. "Waiting" is how many webhook deliveries Stripe still has outstanding for that event; 0 means the app acknowledged it.
One Stripe test account serves the deployed app, local development, and the automated tests. This list shows the 24 events for policies on the deployed app, out of the 209 most recent; the rest came from local and automated testing.

| Time (UTC) | Event | Object | Amount | Status | Policy | Waiting |
|---|---|---|---|---|---|---|
| 2026-11-12 14:25:30 | `payment_intent.succeeded` | `pi_3UaywNGiG…` | $1825.00 | succeeded | SBP-2027-0008 | 0 |
| 2026-11-12 14:25:21 | `payment_intent.succeeded` | `pi_3UaywGGiG…` | $674.00 | succeeded | SBP-2026-0007 | 0 |
| 2026-11-12 14:25:20 | `payment_intent.succeeded` | `pi_3UaywFGiG…` | $1095.00 | succeeded | SBP-2026-0007 | 0 |
| 2026-11-12 14:25:13 | `refund.updated` | `re_3Uayw0GiG…` | $941.00 | succeeded | SBP-2026-0006 | 0 |
| 2026-11-12 14:25:13 | `refund.created` | `re_3Uayw0GiG…` | $941.00 | succeeded | SBP-2026-0006 | 0 |
| 2026-11-12 14:25:13 | `refund.updated` | `re_3Uayw1GiG…` | $674.00 | succeeded | SBP-2026-0006 | 0 |
| 2026-11-12 14:25:12 | `refund.created` | `re_3Uayw1GiG…` | $674.00 | succeeded | SBP-2026-0006 | 0 |
| 2026-11-12 14:25:06 | `payment_intent.succeeded` | `pi_3Uayw1GiG…` | $674.00 | succeeded | SBP-2026-0006 | 0 |
| 2026-11-12 14:25:04 | `payment_intent.succeeded` | `pi_3Uayw0GiG…` | $1095.00 | succeeded | SBP-2026-0006 | 0 |
| 2026-11-12 12:42:52 | `refund.updated` | `re_3UaxL0GiG…` | $14.00 | succeeded | SBP-2026-0002 | 0 |
| 2026-11-12 12:42:52 | `refund.created` | `re_3UaxL0GiG…` | $14.00 | succeeded | SBP-2026-0002 | 0 |
| 2026-11-12 12:42:49 | `payment_intent.succeeded` | `pi_3UaxL0GiG…` | $730.00 | succeeded | SBP-2026-0002 | 0 |
| 2026-11-12 12:42:42 | `payment_intent.succeeded` | `pi_3UaxKuGiG…` | $1095.00 | succeeded | SBP-2026-0002 | 0 |
| 2026-11-12 12:42:40 | `payment_intent.canceled` | `pi_3UaxKoGiG…` | $1095.00 | canceled | SBP-2026-0002 | 0 |
| 2026-11-12 12:42:39 | `payment_intent.payment_failed` | `pi_3UaxKoGiG…` | $1095.00 | requires_payment_method | SBP-2026-0002 | 0 |
| 2026-11-12 12:09:41 | `payment_intent.succeeded` | `pi_3UawowGiG…` | $1825.00 | succeeded | SBP-2027-0005 | 0 |
| 2026-11-12 12:09:30 | `payment_intent.succeeded` | `pi_3UawonGiG…` | $674.00 | succeeded | SBP-2026-0004 | 0 |
| 2026-11-12 12:09:29 | `payment_intent.succeeded` | `pi_3UawomGiG…` | $1095.00 | succeeded | SBP-2026-0004 | 0 |
| 2026-11-12 12:09:23 | `refund.updated` | `re_3UawoXGiG…` | $941.00 | succeeded | SBP-2026-0003 | 0 |
| 2026-11-12 12:09:23 | `refund.created` | `re_3UawoXGiG…` | $941.00 | succeeded | SBP-2026-0003 | 0 |
| 2026-11-12 12:09:23 | `refund.updated` | `re_3UawoZGiG…` | $674.00 | succeeded | SBP-2026-0003 | 0 |
| 2026-11-12 12:09:22 | `refund.created` | `re_3UawoZGiG…` | $674.00 | succeeded | SBP-2026-0003 | 0 |
| 2026-11-12 12:09:15 | `payment_intent.succeeded` | `pi_3UawoZGiG…` | $674.00 | succeeded | SBP-2026-0003 | 0 |
| 2026-11-12 12:09:14 | `payment_intent.succeeded` | `pi_3UawoXGiG…` | $1095.00 | succeeded | SBP-2026-0003 | 0 |

## Refunds

| Time (UTC) | Refund | Amount | Status | Policy | Against payment |
|---|---|---|---|---|---|
| 2026-11-12 14:25:13 | `re_3Uayw0GiG…` | $941.00 | succeeded | SBP-2026-0006 | `pi_3Uayw0GiG…` |
| 2026-11-12 14:25:12 | `re_3Uayw1GiG…` | $674.00 | succeeded | SBP-2026-0006 | `pi_3Uayw1GiG…` |
| 2026-11-12 12:42:51 | `re_3UaxL0GiG…` | $14.00 | succeeded | SBP-2026-0002 | `pi_3UaxL0GiG…` |
| 2026-11-12 12:09:22 | `re_3UawoXGiG…` | $941.00 | succeeded | SBP-2026-0003 | `pi_3UawoXGiG…` |
| 2026-11-12 12:09:22 | `re_3UawoZGiG…` | $674.00 | succeeded | SBP-2026-0003 | `pi_3UawoZGiG…` |
