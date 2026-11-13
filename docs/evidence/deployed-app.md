# What the deployed app recorded

Read 2026-11-13 13:41:56 UTC from the deployed app's database (read-only). These are the app's own records of its sandbox activity: the same rows the broker's Integration log page shows.

## Integration log: every sandbox request sent and webhook received

"Sent" is a request the app made to a sandbox. "Received" is a webhook the sandbox delivered to the app.

| Time (UTC) | Service | Direction | Event | Reference | Policy |
|---|---|---|---|---|---|
| 2026-11-12 09:35:54 | docusign | Sent | envelope.create | ea5b23f4-69f |  |
| 2026-11-12 09:36:57 | docusign | Sent | envelope.recipient_view | ea5b23f4-69f |  |
| 2026-11-12 09:37:51 | docusign | Received | envelope-completed | ea5b23f4-69f |  |
| 2026-11-12 12:09:13 | stripe | Sent | payment_intent.create | pi_3UawoXGiG | SBP-2026-0003 |
| 2026-11-12 12:09:15 | stripe | Sent | payment_intent.create | pi_3UawoZGiG | SBP-2026-0003 |
| 2026-11-12 12:09:15 | stripe | Received | payment_intent.succeeded | pi_3UawoXGiG | SBP-2026-0003 |
| 2026-11-12 12:09:16 | stripe | Received | payment_intent.succeeded | pi_3UawoZGiG | SBP-2026-0003 |
| 2026-11-12 12:09:22 | stripe | Sent | refund.create | re_3UawoZGiG | SBP-2026-0003 |
| 2026-11-12 12:09:23 | stripe | Sent | refund.create | re_3UawoXGiG | SBP-2026-0003 |
| 2026-11-12 12:09:24 | stripe | Received | refund.created | re_3UawoZGiG | SBP-2026-0003 |
| 2026-11-12 12:09:24 | stripe | Received | refund.updated | re_3UawoXGiG | SBP-2026-0003 |
| 2026-11-12 12:09:24 | stripe | Received | refund.updated | re_3UawoZGiG | SBP-2026-0003 |
| 2026-11-12 12:09:24 | stripe | Received | refund.created | re_3UawoXGiG | SBP-2026-0003 |
| 2026-11-12 12:42:34 | stripe | Sent | payment_intent.create | pi_3UaxKoGiG | SBP-2026-0002 |
| 2026-11-12 12:42:40 | stripe | Sent | payment_intent.create | pi_3UaxKuGiG | SBP-2026-0002 |
| 2026-11-12 12:42:40 | stripe | Received | payment_intent.payment_failed | pi_3UaxKoGiG | SBP-2026-0002 |
| 2026-11-12 12:42:41 | stripe | Received | payment_intent.canceled | pi_3UaxKoGiG | SBP-2026-0002 |
| 2026-11-12 12:42:43 | stripe | Received | payment_intent.succeeded | pi_3UaxKuGiG | SBP-2026-0002 |
| 2026-11-12 12:42:46 | stripe | Sent | payment_intent.create | pi_3UaxL0GiG | SBP-2026-0002 |
| 2026-11-12 12:42:50 | stripe | Received | payment_intent.succeeded | pi_3UaxL0GiG | SBP-2026-0002 |
| 2026-11-12 12:42:52 | stripe | Sent | refund.create | re_3UaxL0GiG | SBP-2026-0002 |
| 2026-11-12 12:42:52 | stripe | Received | refund.created | re_3UaxL0GiG | SBP-2026-0002 |
| 2026-11-12 12:42:52 | stripe | Received | refund.updated | re_3UaxL0GiG | SBP-2026-0002 |
| 2026-11-12 22:23:03 | stripe | Sent | payment_intent.create | pi_3Ub6OZGiG | SBP-2026-0012 |
| 2026-11-12 22:23:04 | stripe | Received | payment_intent.succeeded | pi_3Ub6OZGiG | SBP-2026-0012 |
| 2026-11-12 22:23:04 | stripe | Sent | payment_intent.create | pi_3Ub6OaGiG | SBP-2026-0012 |
| 2026-11-12 22:23:05 | stripe | Received | payment_intent.succeeded | pi_3Ub6OaGiG | SBP-2026-0012 |
| 2026-11-12 22:23:11 | stripe | Sent | payment_intent.create | pi_3Ub6OgGiG | SBP-2026-0012 |
| 2026-11-12 22:23:15 | stripe | Received | payment_intent.succeeded | pi_3Ub6OgGiG | SBP-2026-0012 |
| 2026-11-12 22:23:15 | stripe | Received | charge.dispute.created | du_1Ub6OkGiG | SBP-2026-0012 |
| 2026-11-12 22:23:15 | stripe | Received | charge.dispute.funds_withdrawn | du_1Ub6OkGiG | SBP-2026-0012 |
| 2026-11-12 22:23:20 | stripe | Received | charge.dispute.closed | du_1Ub6OkGiG | SBP-2026-0012 |
| 2026-11-13 09:20:40 | stripe | Sent | refund.create | re_3UaxL0GiG | SBP-2026-0002 |
| 2026-11-13 09:20:41 | stripe | Received | refund.created | re_3UaxL0GiG | SBP-2026-0002 |
| 2026-11-13 09:20:41 | stripe | Received | refund.updated | re_3UaxL0GiG | SBP-2026-0002 |
| 2026-11-13 12:38:05 | stripe | Sent | payment_intent.create | pi_3UbJk1GiG | SBP-2026-0025 |
| 2026-11-13 12:38:07 | stripe | Sent | payment_intent.create | pi_3UbJk3GiG | SBP-2026-0025 |
| 2026-11-13 12:38:07 | stripe | Received | payment_intent.succeeded | pi_3UbJk1GiG | SBP-2026-0025 |
| 2026-11-13 12:38:08 | stripe | Received | payment_intent.succeeded | pi_3UbJk3GiG | SBP-2026-0025 |
| 2026-11-13 12:38:16 | stripe | Sent | payment_intent.create | pi_3UbJkCGiG | SBP-2026-0025 |
| 2026-11-13 12:38:20 | stripe | Received | payment_intent.succeeded | pi_3UbJkCGiG | SBP-2026-0025 |
| 2026-11-13 12:38:22 | stripe | Sent | refund.create | re_3UbJkCGiG | SBP-2026-0025 |
| 2026-11-13 12:38:22 | stripe | Received | refund.created | re_3UbJkCGiG | SBP-2026-0025 |
| 2026-11-13 12:38:23 | stripe | Received | refund.updated | re_3UbJkCGiG | SBP-2026-0025 |
| 2026-11-13 12:38:23 | stripe | Sent | refund.create | re_3UbJk3GiG | SBP-2026-0025 |
| 2026-11-13 12:38:23 | stripe | Received | refund.created | re_3UbJk3GiG | SBP-2026-0025 |
| 2026-11-13 12:38:23 | stripe | Received | refund.updated | re_3UbJk3GiG | SBP-2026-0025 |
| 2026-11-13 13:06:55 | stripe | Sent | payment_intent.create | pi_3UbKBuGiG | SBP-2026-0027 |
| 2026-11-13 13:06:56 | stripe | Sent | payment_intent.create | pi_3UbKBwGiG | SBP-2026-0027 |
| 2026-11-13 13:06:57 | stripe | Received | payment_intent.succeeded | pi_3UbKBuGiG | SBP-2026-0027 |
| 2026-11-13 13:06:57 | stripe | Received | payment_intent.succeeded | pi_3UbKBwGiG | SBP-2026-0027 |
| 2026-11-13 13:08:23 | stripe | Sent | payment_intent.create | pi_3UbKDLGiG | SBP-2026-0027 |
| 2026-11-13 13:08:27 | stripe | Received | payment_intent.succeeded | pi_3UbKDLGiG | SBP-2026-0027 |
| 2026-11-13 13:08:53 | stripe | Sent | refund.create | re_3UbKDLGiG | SBP-2026-0027 |
| 2026-11-13 13:08:53 | stripe | Received | refund.created | re_3UbKDLGiG | SBP-2026-0027 |
| 2026-11-13 13:08:53 | stripe | Received | refund.updated | re_3UbKDLGiG | SBP-2026-0027 |
| 2026-11-13 13:08:53 | stripe | Sent | refund.create | re_3UbKBwGiG | SBP-2026-0027 |
| 2026-11-13 13:08:54 | stripe | Received | refund.created | re_3UbKBwGiG | SBP-2026-0027 |
| 2026-11-13 13:08:54 | stripe | Received | refund.updated | re_3UbKBwGiG | SBP-2026-0027 |

## Payments and refunds, with their Stripe references

| Time (UTC) | Kind | Status | Amount | Policy | Stripe reference |
|---|---|---|---|---|---|
| 2026-10-01 17:00:00 | Payment | Succeeded | $1,095.00 | SBP-2026-0003 | pi_3UawoXGiG |
| 2026-10-01 17:00:00 | Payment | Succeeded | $1,095.00 | SBP-2026-0012 | pi_3Ub6OZGiG |
| 2026-10-02 17:00:00 | Payment | Succeeded | $1,095.00 | SBP-2026-0025 | pi_3UbJk1GiG |
| 2026-10-02 17:00:00 | Payment | Succeeded | $1,095.00 | SBP-2026-0027 | pi_3UbKBuGiG |
| 2026-10-22 17:00:00 | Payment | Succeeded | $674.00 | SBP-2026-0003 | pi_3UawoZGiG |
| 2026-10-22 17:00:00 | Payment | Succeeded | $674.00 | SBP-2026-0012 | pi_3Ub6OaGiG |
| 2026-10-23 17:00:00 | Payment | Succeeded | $674.00 | SBP-2026-0025 | pi_3UbJk3GiG |
| 2026-10-23 17:00:00 | Payment | Succeeded | $674.00 | SBP-2026-0027 | pi_3UbKBwGiG |
| 2026-11-12 12:09:21 | Refund | Succeeded | $941.00 | SBP-2026-0003 | re_3UawoXGiG |
| 2026-11-12 12:09:21 | Refund | Succeeded | $674.00 | SBP-2026-0003 | re_3UawoZGiG |
| 2026-11-12 12:42:34 | Payment | Failed | $1,095.00 | SBP-2026-0002 | pi_3UaxKoGiG |
| 2026-11-12 12:42:40 | Payment | Succeeded | $1,095.00 | SBP-2026-0002 | pi_3UaxKuGiG |
| 2026-11-12 12:42:46 | Payment | Succeeded | $730.00 | SBP-2026-0002 | pi_3UaxL0GiG |
| 2026-11-12 12:42:51 | Refund | Succeeded | $14.00 | SBP-2026-0002 | re_3UaxL0GiG |
| 2026-11-12 22:23:10 | Payment | Failed | $14.00 | SBP-2026-0012 | pi_3Ub6OgGiG |
| 2026-11-13 09:20:40 | Refund | Succeeded | $14.00 | SBP-2026-0002 | re_3UaxL0GiG |
| 2026-11-13 12:38:16 | Payment | Succeeded | $14.00 | SBP-2026-0025 | pi_3UbJkCGiG |
| 2026-11-13 12:38:21 | Refund | Succeeded | $14.00 | SBP-2026-0025 | re_3UbJkCGiG |
| 2026-11-13 12:38:21 | Refund | Succeeded | $14.00 | SBP-2026-0025 | re_3UbJk3GiG |
| 2026-11-13 13:08:23 | Payment | Succeeded | $14.00 | SBP-2026-0027 | pi_3UbKDLGiG |
| 2026-11-13 13:08:52 | Refund | Succeeded | $14.00 | SBP-2026-0027 | re_3UbKDLGiG |
| 2026-11-13 13:08:52 | Refund | Succeeded | $14.00 | SBP-2026-0027 | re_3UbKBwGiG |

## Signed applications, with their DocuSign envelopes

| Status | Envelope | Signer | Signed (UTC) | Policy issued |
|---|---|---|---|---|
| Issued | ea5b23f4-69f | Olive Owner | 2026-11-12 09:37:29 | SBP-2026-0002 |

## Claims

| Claim | Status | Claimed | Paid out | Policy |
|---|---|---|---|---|
| CLM-2026-0001 | Paid | $4,000.00 | $3,000.00 | SBP-2026-0002 |
| CLM-2026-0002 | Denied | $900.00 |  | SBP-2026-0002 |
| CLM-2026-0003 | Paid | $4,000.00 | $3,000.00 | SBP-2026-0002 |
| CLM-2026-0004 | Denied | $900.00 |  | SBP-2026-0002 |

Claim payments are simulated: they are recorded in the app and no money moves.
