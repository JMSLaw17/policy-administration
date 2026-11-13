# Stripe evidence (test mode)

Collected 2026-11-13 13:33:02 UTC from Stripe's API with a test-mode key. Nothing here involves real money.

## Webhook endpoint

| Address | Status | Events subscribed |
|---|---|---|
| https://policy-administration.vercel.app/api/stripe/webhook | enabled | payment_intent.succeeded, payment_intent.payment_failed, payment_intent.processing, payment_intent.canceled, refund.created, refund.updated, refund.failed, charge.dispute.created, charge.dispute.closed, charge.dispute.funds_withdrawn |

## Events Stripe sent to the webhook

Newest first. "Waiting" is how many webhook deliveries Stripe still has outstanding for that event; 0 means the app acknowledged it.
One Stripe test account serves the deployed app, local development, and the automated tests. This list shows the 41 events for policies on the deployed app, out of the 2194 most recent; the rest came from local and automated testing.

| Time (UTC) | Event | Object | Amount | Status | Policy | Waiting |
|---|---|---|---|---|---|---|
| 2026-11-13 13:08:54 | `refund.updated` | `re_3UbKBwGiG…` | $14.00 | succeeded | SBP-2026-0027 | 0 |
| 2026-11-13 13:08:53 | `refund.created` | `re_3UbKBwGiG…` | $14.00 | succeeded | SBP-2026-0027 | 0 |
| 2026-11-13 13:08:53 | `refund.updated` | `re_3UbKDLGiG…` | $14.00 | succeeded | SBP-2026-0027 | 0 |
| 2026-11-13 13:08:52 | `refund.created` | `re_3UbKDLGiG…` | $14.00 | succeeded | SBP-2026-0027 | 0 |
| 2026-11-13 13:08:26 | `payment_intent.succeeded` | `pi_3UbKDLGiG…` | $14.00 | succeeded | SBP-2026-0027 | 0 |
| 2026-11-13 13:06:57 | `payment_intent.succeeded` | `pi_3UbKBwGiG…` | $674.00 | succeeded | SBP-2026-0027 | 0 |
| 2026-11-13 13:06:55 | `payment_intent.succeeded` | `pi_3UbKBuGiG…` | $1095.00 | succeeded | SBP-2026-0027 | 0 |
| 2026-11-13 12:41:53 | `refund.updated` | `re_3UbJllGiG…` | $14.00 | succeeded | SBP-2026-0026 | 0 |
| 2026-11-13 12:41:52 | `refund.created` | `re_3UbJllGiG…` | $14.00 | succeeded | SBP-2026-0026 | 0 |
| 2026-11-13 12:41:52 | `refund.updated` | `re_3UbJnBGiG…` | $14.00 | succeeded | SBP-2026-0026 | 0 |
| 2026-11-13 12:41:51 | `refund.created` | `re_3UbJnBGiG…` | $14.00 | succeeded | SBP-2026-0026 | 0 |
| 2026-11-13 12:41:24 | `payment_intent.succeeded` | `pi_3UbJnBGiG…` | $14.00 | succeeded | SBP-2026-0026 | 0 |
| 2026-11-13 12:39:54 | `payment_intent.succeeded` | `pi_3UbJllGiG…` | $674.00 | succeeded | SBP-2026-0026 | 0 |
| 2026-11-13 12:39:52 | `payment_intent.succeeded` | `pi_3UbJlkGiG…` | $1095.00 | succeeded | SBP-2026-0026 | 0 |
| 2026-11-13 12:38:23 | `refund.updated` | `re_3UbJk3GiG…` | $14.00 | succeeded | SBP-2026-0025 | 0 |
| 2026-11-13 12:38:23 | `refund.created` | `re_3UbJk3GiG…` | $14.00 | succeeded | SBP-2026-0025 | 0 |
| 2026-11-13 12:38:22 | `refund.updated` | `re_3UbJkCGiG…` | $14.00 | succeeded | SBP-2026-0025 | 0 |
| 2026-11-13 12:38:22 | `refund.created` | `re_3UbJkCGiG…` | $14.00 | succeeded | SBP-2026-0025 | 0 |
| 2026-11-13 12:38:19 | `payment_intent.succeeded` | `pi_3UbJkCGiG…` | $14.00 | succeeded | SBP-2026-0025 | 0 |
| 2026-11-13 12:38:07 | `payment_intent.succeeded` | `pi_3UbJk3GiG…` | $674.00 | succeeded | SBP-2026-0025 | 0 |
| 2026-11-13 12:38:06 | `payment_intent.succeeded` | `pi_3UbJk1GiG…` | $1095.00 | succeeded | SBP-2026-0025 | 0 |
| 2026-11-13 09:20:41 | `refund.updated` | `re_3UaxL0GiG…` | $14.00 | succeeded | SBP-2026-0002 | 0 |
| 2026-11-13 09:20:40 | `refund.created` | `re_3UaxL0GiG…` | $14.00 | succeeded | SBP-2026-0002 | 0 |
| 2026-11-12 22:23:19 | `charge.dispute.closed` | `du_1Ub6OkGiG…` | $14.00 | lost | SBP-2026-0012 | 0 |
| 2026-11-12 22:23:14 | `payment_intent.succeeded` | `pi_3Ub6OgGiG…` | $14.00 | succeeded | SBP-2026-0012 | 0 |
| 2026-11-12 22:23:14 | `charge.dispute.funds_withdrawn` | `du_1Ub6OkGiG…` | $14.00 | needs_response | SBP-2026-0012 | 0 |
| 2026-11-12 22:23:14 | `charge.dispute.created` | `du_1Ub6OkGiG…` | $14.00 | needs_response | SBP-2026-0012 | 0 |
| 2026-11-12 22:23:04 | `payment_intent.succeeded` | `pi_3Ub6OaGiG…` | $674.00 | succeeded | SBP-2026-0012 | 0 |
| 2026-11-12 22:23:03 | `payment_intent.succeeded` | `pi_3Ub6OZGiG…` | $1095.00 | succeeded | SBP-2026-0012 | 0 |
| 2026-11-12 12:42:52 | `refund.updated` | `re_3UaxL0GiG…` | $14.00 | succeeded | SBP-2026-0002 | 0 |
| 2026-11-12 12:42:52 | `refund.created` | `re_3UaxL0GiG…` | $14.00 | succeeded | SBP-2026-0002 | 0 |
| 2026-11-12 12:42:49 | `payment_intent.succeeded` | `pi_3UaxL0GiG…` | $730.00 | succeeded | SBP-2026-0002 | 0 |
| 2026-11-12 12:42:42 | `payment_intent.succeeded` | `pi_3UaxKuGiG…` | $1095.00 | succeeded | SBP-2026-0002 | 0 |
| 2026-11-12 12:42:40 | `payment_intent.canceled` | `pi_3UaxKoGiG…` | $1095.00 | canceled | SBP-2026-0002 | 0 |
| 2026-11-12 12:42:39 | `payment_intent.payment_failed` | `pi_3UaxKoGiG…` | $1095.00 | requires_payment_method | SBP-2026-0002 | 0 |
| 2026-11-12 12:09:23 | `refund.updated` | `re_3UawoXGiG…` | $941.00 | succeeded | SBP-2026-0003 | 0 |
| 2026-11-12 12:09:23 | `refund.created` | `re_3UawoXGiG…` | $941.00 | succeeded | SBP-2026-0003 | 0 |
| 2026-11-12 12:09:23 | `refund.updated` | `re_3UawoZGiG…` | $674.00 | succeeded | SBP-2026-0003 | 0 |
| 2026-11-12 12:09:22 | `refund.created` | `re_3UawoZGiG…` | $674.00 | succeeded | SBP-2026-0003 | 0 |
| 2026-11-12 12:09:15 | `payment_intent.succeeded` | `pi_3UawoZGiG…` | $674.00 | succeeded | SBP-2026-0003 | 0 |
| 2026-11-12 12:09:14 | `payment_intent.succeeded` | `pi_3UawoXGiG…` | $1095.00 | succeeded | SBP-2026-0003 | 0 |

## Refunds

| Time (UTC) | Refund | Amount | Status | Policy | Against payment |
|---|---|---|---|---|---|
| 2026-11-13 13:08:53 | `re_3UbKBwGiG…` | $14.00 | succeeded | SBP-2026-0027 | `pi_3UbKBwGiG…` |
| 2026-11-13 13:08:52 | `re_3UbKDLGiG…` | $14.00 | succeeded | SBP-2026-0027 | `pi_3UbKDLGiG…` |
| 2026-11-13 12:41:52 | `re_3UbJllGiG…` | $14.00 | succeeded | SBP-2026-0026 | `pi_3UbJllGiG…` |
| 2026-11-13 12:41:51 | `re_3UbJnBGiG…` | $14.00 | succeeded | SBP-2026-0026 | `pi_3UbJnBGiG…` |
| 2026-11-13 12:38:22 | `re_3UbJk3GiG…` | $14.00 | succeeded | SBP-2026-0025 | `pi_3UbJk3GiG…` |
| 2026-11-13 12:38:21 | `re_3UbJkCGiG…` | $14.00 | succeeded | SBP-2026-0025 | `pi_3UbJkCGiG…` |
| 2026-11-13 09:20:40 | `re_3UaxL0GiG…` | $14.00 | succeeded | SBP-2026-0002 | `pi_3UaxL0GiG…` |
| 2026-11-12 12:42:51 | `re_3UaxL0GiG…` | $14.00 | succeeded | SBP-2026-0002 | `pi_3UaxL0GiG…` |
| 2026-11-12 12:09:22 | `re_3UawoXGiG…` | $941.00 | succeeded | SBP-2026-0003 | `pi_3UawoXGiG…` |
| 2026-11-12 12:09:22 | `re_3UawoZGiG…` | $674.00 | succeeded | SBP-2026-0003 | `pi_3UawoZGiG…` |
