# Decision log

Short, dated notes on decisions that affected the build. Newest at the bottom. Assumptions made where the brief was silent are marked **Assumption**.

## 2026-11-11

- **Track 1, policy administration.** Fullstack TypeScript: Next.js (App Router), Prisma, Postgres. One codebase keeps the frontend and backend types in sync, and Postgres gives us real transactions for financial writes.
- **One product with flat per-coverage pricing.** A Small Business Package with General Liability ($1,095/yr, required), Cyber ($730/yr), and Business Property ($365/yr). The prices are chosen to work out to whole dollars per day so the math is easy to verify live. **Assumption:** no rating factors, taxes, or fees.
- **Money in integer cents, rounded per line.** Each pro-rated line is rounded half-up to the cent, and totals are sums of rounded lines. This avoids floating-point drift and makes every statement line reproducible by hand.
- **Daily pro-rata with actual days in term.** `annual × days covered ÷ days in term`, start date inclusive, end date exclusive. **Assumption:** the brief doesn't specify a convention, and this is the common industry one.
- **Append-only ledger, and corrections reverse and rebook.** No ledger row is ever edited or deleted. A correction posts a reversal of the original charge and a new charge, so the brief's requirement to keep "the original charge and the correction visible" falls out of the design rather than being a special case.
- **Cancellation is pro-rata with no penalty.** Refund equals paid minus earned premium, sent back through Stripe Refunds. **Assumption:** no short-rate penalty or minimum earned premium.
- **Payment status comes only from Stripe webhooks.** The browser redirect is never trusted to mark a payment as paid. This is what makes "pending, succeeded, failed" honest.
- **Integrations: Stripe test mode (live) and Resend email (live, sandbox).** Carrier, underwriting, and policy documents are simulated. Every integration call and webhook is stored in an integration log for evidence.
- **Left out: installments.** Pay-in-full only. This keeps "amount due" a single number per policy, and installments wouldn't exercise anything new in the pro-rata logic.
