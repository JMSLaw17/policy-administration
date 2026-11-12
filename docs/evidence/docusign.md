# DocuSign evidence (developer sandbox)

Collected 2026-11-12 11:51:06 UTC from DocuSign's API on its sandbox host, demo.docusign.net. Documents signed there are watermarked and not legally binding.

## Envelopes

Each application the app sent for signature, with DocuSign's own audit trail. "Viewed In-Session" means the signer signed inside the app (embedded signing), not from an emailed link.

### Envelope `ea5b23f4-69f…`: completed

"Insurance application for Acme Bakery LLC", signer Olive Owner. Sent 2026-11-12 09:35:54 UTC, completed 2026-11-12 09:37:29 UTC.

| Time (UTC) | Action | Envelope status |
|---|---|---|
| 2026-11-12 09:35:53 | Registered | created |
| 2026-11-12 09:36:59 | Opened | sent |
| 2026-11-12 09:37:21 | Viewed In-Session | delivered |
| 2026-11-12 09:37:29 | Signed | completed |
| 2026-11-12 09:37:31 | Printable Copy Attached to Email | completed |
| 2026-11-12 09:37:51 | Printable Copy Delivered | completed |

### Envelope `f62627ff-7ad…`: completed

"Insurance application for Acme Bakery LLC", signer Olive Owner. Sent 2026-11-11 21:19:44 UTC, completed 2026-11-11 21:22:04 UTC.

| Time (UTC) | Action | Envelope status |
|---|---|---|
| 2026-11-11 21:19:44 | Registered | created |
| 2026-11-11 21:21:38 | Opened | sent |
| 2026-11-11 21:21:42 | Viewed In-Session | delivered |
| 2026-11-11 21:22:04 | Signed | completed |
| 2026-11-11 21:22:06 | Printable Copy Attached to Email | completed |

## Webhook deliveries (DocuSign Connect)

What DocuSign sent to the deployed app when an envelope was completed, and the app's reply. Failed deliveries on record: 0.

| Time (UTC) | Envelope | Event | Delivered to | App's reply |
|---|---|---|---|---|
| 2026-11-12 09:37:51 | `ea5b23f4-69f…` | `envelope-completed` | /api/docusign/webhook | `{"received":true}` |

DocuSign can't reach a developer's laptop, so envelopes signed against a local copy of the app have no delivery here.
