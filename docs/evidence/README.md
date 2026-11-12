# Integration evidence

Evidence that the two sandbox integrations are live: Stripe in test mode and DocuSign's developer sandbox. Everything here is fictional test data, and no real money moves.

| File | What it shows | Where it comes from |
|---|---|---|
| [stripe.md](stripe.md) | The webhook endpoint Stripe is configured to call, the payment and refund events Stripe sent for the deployed app's policies with their delivery status, and the refunds. | Stripe's API, test mode |
| [docusign.md](docusign.md) | Each application sent for signature with DocuSign's own audit trail (created, opened, viewed in-session, signed), and the completion webhook DocuSign delivered with the app's reply. | DocuSign's API, sandbox |
| [deployed-app.md](deployed-app.md) | What the deployed app itself recorded: its integration log (every request sent and webhook received), its payments and refunds with Stripe references, its signed applications with DocuSign envelope ids, and its claims. | The deployed app's database, read-only |
| [screenshots/](screenshots) | The reviewers' scenario on the deployed app, step by step, ending with the integration log. | A browser run against the deployed site |

## How the three line up

The same references appear in all three places, which is the point. For example, the refund after a correction on the deployed app:

- **The app's database** has a refund of $14.00 on policy SBP-2026-0001, marked succeeded, with a Stripe reference starting `re_3Uaw3Q`.
- **The app's integration log** has a `refund.create` request sent, followed by `refund.created` and `refund.updated` webhooks received, for that reference.
- **Stripe** has that refund as succeeded for $14.00, against the payment that paid for the coverage, with no webhook deliveries outstanding.

And for the signed application: the app's database has envelope `ea5b23f4` signed at 09:37:29 UTC on 2026-11-12 and policy SBP-2026-0002 issued from it; DocuSign's audit trail has the same envelope signed in-session at the same second; and DocuSign's delivery log shows `envelope-completed` sent to the app, which replied `{"received":true}`.

## The screenshots

| Screenshot | What it shows |
|---|---|
| `01-scenario-start-paid-policy` | The starting point: a paid policy with Cyber added and paid, both through real Stripe test payments. |
| `02-correction-preview` | The broker moves Cyber's start a week earlier. The preview shows the reversal, the new charge with its formula, and $14.00 due, before anything is saved. |
| `03-broker-statement-after-correction` | The statement with the original charge (struck through, marked superseded), the reversal, and the corrected charge. |
| `04-policyholder-statement-and-explanation` | The same policy as the customer sees it, with the plain-English explanation and a Pay button. |
| `05-policyholder-paid` | After paying $14.00 through Stripe's card form. |
| `06-refund-after-second-correction` | The date corrected the other way: the credit is refunded to the card by the app, and the refund appears on the statement and in the payments table. |
| `07-integration-log` | The app's log of requests sent to Stripe and DocuSign and webhooks received. |
| `08-policy-with-docusign-signature` | A policy issued from an application signed through DocuSign, with the link to the signed PDF. |

## Refreshing this folder

```bash
npm run evidence               # rewrites the three .md files from Stripe, DocuSign, and the deployed database
npm run evidence:screenshots   # reruns the scenario on the deployed site and retakes the screenshots (creates demo data)
```

Both read their keys from git-ignored local files. Ids are shortened in these files so they can be matched against the dashboards without being published in full.
