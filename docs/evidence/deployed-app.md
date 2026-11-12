# What the deployed app recorded

Read 2026-11-12 11:51:06 UTC from the deployed app's database (read-only). These are the app's own records of its sandbox activity: the same rows the broker's Integration log page shows.

## Integration log: every sandbox request sent and webhook received

"Sent" is a request the app made to a sandbox. "Received" is a webhook the sandbox delivered to the app.

8 received Stripe rows have no policy. They are payments made by local and automated tests on the same Stripe test account, delivered here because Stripe sends every event to this address. The app took no action on them, and has since been changed to leave such events out of the log.

| Time (UTC) | Service | Direction | Event | Reference | Policy |
|---|---|---|---|---|---|
| 2026-11-11 20:06:23 | stripe | Sent | payment_intent.create | pi_3UahmlGiG | SBP-2026-0001 |
| 2026-11-11 20:07:12 | stripe | Sent | payment_intent.create | pi_3UahnYGiG | SBP-2026-0001 |
| 2026-11-11 20:26:25 | stripe | Received | payment_intent.succeeded | pi_3UahnYGiG | SBP-2026-0001 |
| 2026-11-11 20:28:34 | stripe | Received | payment_intent.payment_failed | pi_3UahmlGiG | SBP-2026-0001 |
| 2026-11-11 20:28:40 | stripe | Received | payment_intent.canceled | pi_3UahmlGiG | SBP-2026-0001 |
| 2026-11-11 21:06:59 | stripe | Received | payment_intent.payment_failed | pi_3UahmlGiG | SBP-2026-0001 |
| 2026-11-11 21:07:49 | stripe | Received | payment_intent.canceled | pi_3UahmlGiG | SBP-2026-0001 |
| 2026-11-11 21:08:03 | stripe | Received | payment_intent.succeeded | pi_3UahnYGiG | SBP-2026-0001 |
| 2026-11-12 09:35:54 | docusign | Sent | envelope.create | ea5b23f4-69f |  |
| 2026-11-12 09:36:57 | docusign | Sent | envelope.recipient_view | ea5b23f4-69f |  |
| 2026-11-12 09:37:51 | docusign | Received | envelope-completed | ea5b23f4-69f |  |
| 2026-11-12 10:00:46 | stripe | Received | payment_intent.succeeded | pi_3UauoCGiG |  |
| 2026-11-12 10:00:47 | stripe | Received | refund.created | re_3UauoCGiG |  |
| 2026-11-12 10:00:47 | stripe | Received | refund.updated | re_3UauoCGiG |  |
| 2026-11-12 10:00:48 | stripe | Received | payment_intent.payment_failed | pi_3UauoFGiG |  |
| 2026-11-12 10:00:49 | stripe | Received | payment_intent.canceled | pi_3UauoFGiG |  |
| 2026-11-12 10:00:50 | stripe | Received | payment_intent.processing | pi_3UauoGGiG |  |
| 2026-11-12 10:00:51 | stripe | Received | payment_intent.processing | pi_3UauoIGiG |  |
| 2026-11-12 10:01:06 | stripe | Received | payment_intent.succeeded | pi_3UauoGGiG |  |
| 2026-11-12 11:20:32 | stripe | Sent | payment_intent.create | pi_3Uaw3QGiG | SBP-2026-0001 |
| 2026-11-12 11:20:36 | stripe | Received | payment_intent.succeeded | pi_3Uaw3QGiG | SBP-2026-0001 |
| 2026-11-12 11:20:38 | stripe | Sent | refund.create | re_3Uaw3QGiG | SBP-2026-0001 |
| 2026-11-12 11:20:39 | stripe | Received | refund.created | re_3Uaw3QGiG | SBP-2026-0001 |
| 2026-11-12 11:20:39 | stripe | Received | refund.updated | re_3Uaw3QGiG | SBP-2026-0001 |

## Payments and refunds, with their Stripe references

| Time (UTC) | Kind | Status | Amount | Policy | Stripe reference |
|---|---|---|---|---|---|
| 2026-11-11 20:06:23 | Payment | Failed | $1,095.00 | SBP-2026-0001 | pi_3UahmlGiG |
| 2026-11-11 20:07:11 | Payment | Succeeded | $1,095.00 | SBP-2026-0001 | pi_3UahnYGiG |
| 2026-11-12 11:20:32 | Payment | Succeeded | $728.00 | SBP-2026-0001 | pi_3Uaw3QGiG |
| 2026-11-12 11:20:37 | Refund | Succeeded | $14.00 | SBP-2026-0001 | re_3Uaw3QGiG |

## Signed applications, with their DocuSign envelopes

| Status | Envelope | Signer | Signed (UTC) | Policy issued |
|---|---|---|---|---|
| Issued | ea5b23f4-69f | Olive Owner | 2026-11-12 09:37:29 | SBP-2026-0002 |

## Claims

| Claim | Status | Claimed | Paid out | Policy |
|---|---|---|---|---|
| CLM-2026-0001 | Paid | $4,000.00 | $3,000.00 | SBP-2026-0001 |
| CLM-2026-0002 | Denied | $900.00 |  | SBP-2026-0001 |

Claim payments are simulated: they are recorded in the app and no money moves.
