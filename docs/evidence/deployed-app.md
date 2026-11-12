# What the deployed app recorded

Read 2026-11-12 14:26:36 UTC from the deployed app's database (read-only). These are the app's own records of its sandbox activity: the same rows the broker's Integration log page shows.

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
| 2026-11-12 12:09:28 | stripe | Sent | payment_intent.create | pi_3UawomGiG | SBP-2026-0004 |
| 2026-11-12 12:09:29 | stripe | Received | payment_intent.succeeded | pi_3UawomGiG | SBP-2026-0004 |
| 2026-11-12 12:09:29 | stripe | Sent | payment_intent.create | pi_3UawonGiG | SBP-2026-0004 |
| 2026-11-12 12:09:30 | stripe | Received | payment_intent.succeeded | pi_3UawonGiG | SBP-2026-0004 |
| 2026-11-12 12:09:38 | stripe | Sent | payment_intent.create | pi_3UawowGiG | SBP-2027-0005 |
| 2026-11-12 12:09:41 | stripe | Received | payment_intent.succeeded | pi_3UawowGiG | SBP-2027-0005 |
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
| 2026-11-12 14:25:04 | stripe | Sent | payment_intent.create | pi_3Uayw0GiG | SBP-2026-0006 |
| 2026-11-12 14:25:05 | stripe | Sent | payment_intent.create | pi_3Uayw1GiG | SBP-2026-0006 |
| 2026-11-12 14:25:06 | stripe | Received | payment_intent.succeeded | pi_3Uayw0GiG | SBP-2026-0006 |
| 2026-11-12 14:25:07 | stripe | Received | payment_intent.succeeded | pi_3Uayw1GiG | SBP-2026-0006 |
| 2026-11-12 14:25:12 | stripe | Sent | refund.create | re_3Uayw1GiG | SBP-2026-0006 |
| 2026-11-12 14:25:13 | stripe | Received | refund.created | re_3Uayw1GiG | SBP-2026-0006 |
| 2026-11-12 14:25:13 | stripe | Received | refund.updated | re_3Uayw1GiG | SBP-2026-0006 |
| 2026-11-12 14:25:13 | stripe | Sent | refund.create | re_3Uayw0GiG | SBP-2026-0006 |
| 2026-11-12 14:25:13 | stripe | Received | refund.created | re_3Uayw0GiG | SBP-2026-0006 |
| 2026-11-12 14:25:14 | stripe | Received | refund.updated | re_3Uayw0GiG | SBP-2026-0006 |
| 2026-11-12 14:25:19 | stripe | Sent | payment_intent.create | pi_3UaywFGiG | SBP-2026-0007 |
| 2026-11-12 14:25:20 | stripe | Sent | payment_intent.create | pi_3UaywGGiG | SBP-2026-0007 |
| 2026-11-12 14:25:21 | stripe | Received | payment_intent.succeeded | pi_3UaywFGiG | SBP-2026-0007 |
| 2026-11-12 14:25:21 | stripe | Received | payment_intent.succeeded | pi_3UaywGGiG | SBP-2026-0007 |
| 2026-11-12 14:25:27 | stripe | Sent | payment_intent.create | pi_3UaywNGiG | SBP-2027-0008 |
| 2026-11-12 14:25:31 | stripe | Received | payment_intent.succeeded | pi_3UaywNGiG | SBP-2027-0008 |

## Payments and refunds, with their Stripe references

| Time (UTC) | Kind | Status | Amount | Policy | Stripe reference |
|---|---|---|---|---|---|
| 2026-10-01 17:00:00 | Payment | Succeeded | $1,095.00 | SBP-2026-0007 | pi_3UaywFGiG |
| 2026-10-01 17:00:00 | Payment | Succeeded | $1,095.00 | SBP-2026-0003 | pi_3UawoXGiG |
| 2026-10-01 17:00:00 | Payment | Succeeded | $1,095.00 | SBP-2026-0006 | pi_3Uayw0GiG |
| 2026-10-01 17:00:00 | Payment | Succeeded | $1,095.00 | SBP-2026-0004 | pi_3UawomGiG |
| 2026-10-22 17:00:00 | Payment | Succeeded | $674.00 | SBP-2026-0006 | pi_3Uayw1GiG |
| 2026-10-22 17:00:00 | Payment | Succeeded | $674.00 | SBP-2026-0003 | pi_3UawoZGiG |
| 2026-10-22 17:00:00 | Payment | Succeeded | $674.00 | SBP-2026-0004 | pi_3UawonGiG |
| 2026-10-22 17:00:00 | Payment | Succeeded | $674.00 | SBP-2026-0007 | pi_3UaywGGiG |
| 2026-11-12 12:09:21 | Refund | Succeeded | $674.00 | SBP-2026-0003 | re_3UawoZGiG |
| 2026-11-12 12:09:21 | Refund | Succeeded | $941.00 | SBP-2026-0003 | re_3UawoXGiG |
| 2026-11-12 12:09:38 | Payment | Succeeded | $1,825.00 | SBP-2027-0005 | pi_3UawowGiG |
| 2026-11-12 12:42:34 | Payment | Failed | $1,095.00 | SBP-2026-0002 | pi_3UaxKoGiG |
| 2026-11-12 12:42:40 | Payment | Succeeded | $1,095.00 | SBP-2026-0002 | pi_3UaxKuGiG |
| 2026-11-12 12:42:46 | Payment | Succeeded | $730.00 | SBP-2026-0002 | pi_3UaxL0GiG |
| 2026-11-12 12:42:51 | Refund | Succeeded | $14.00 | SBP-2026-0002 | re_3UaxL0GiG |
| 2026-11-12 14:25:11 | Refund | Succeeded | $674.00 | SBP-2026-0006 | re_3Uayw1GiG |
| 2026-11-12 14:25:12 | Refund | Succeeded | $941.00 | SBP-2026-0006 | re_3Uayw0GiG |
| 2026-11-12 14:25:27 | Payment | Succeeded | $1,825.00 | SBP-2027-0008 | pi_3UaywNGiG |

## Signed applications, with their DocuSign envelopes

| Status | Envelope | Signer | Signed (UTC) | Policy issued |
|---|---|---|---|---|
| Issued | ea5b23f4-69f | Olive Owner | 2026-11-12 09:37:29 | SBP-2026-0002 |

## Claims

| Claim | Status | Claimed | Paid out | Policy |
|---|---|---|---|---|
| CLM-2026-0001 | Paid | $4,000.00 | $3,000.00 | SBP-2026-0002 |
| CLM-2026-0002 | Denied | $900.00 |  | SBP-2026-0002 |

Claim payments are simulated: they are recorded in the app and no money moves.
