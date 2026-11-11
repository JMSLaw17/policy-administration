# Plan: Policy Administration Demo (Track 1)

**Status:** draft for review, 2026-11-11. Nothing is built yet.

## 1. What we're building, in one paragraph

A web app where a **broker** issues a small-business insurance policy, changes its coverage mid-term, corrects mistakes, and cancels it, and where a **policyholder** sees their coverage, pays what they owe, and reads a statement that explains every dollar. Payments and refunds run through **Stripe test mode**. Before a policy is bound, the policyholder e-signs the application through the **DocuSign developer sandbox**. The heart of the app is a ledger: every amount on a statement links back to the policy action and payment record that produced it.

## 2. What the reviewers score, and where we earn it

| Score area | Points | How the plan earns it |
|---|---|---|
| Understanding the financial problem | 30 | Append-only ledger, daily pro-rata math shown on every line, corrections that reverse and rebook instead of editing history |
| Working app | 25 | Full core workflow for both roles, deployed, with seeded demo data |
| Sandbox integrations | 20 | Stripe (payments, webhooks, refunds) plus DocuSign (e-signing the application), with an in-app integration log as evidence |
| Live debrief | 15 | A "how was this calculated?" panel on every charge, so we can answer live when they change the date |
| Engineering judgment | 10 | Small scope done well, unit tests on the money math, decision log, a clear "what we left out" list |

## 3. The product (kept deliberately small)

**One product:** a Small Business Package policy with a 12-month term.

**Coverages, each with a flat annual price** (chosen so the daily math is easy to check by hand):

| Coverage | Annual premium | Per day (365-day term) |
|---|---|---|
| General Liability (required) | $1,095.00 | $3.00 |
| Cyber Liability (optional) | $730.00 | $2.00 |
| Business Property (optional) | $365.00 | $1.00 |

Pricing is a flat rate per coverage. There are no rating factors such as industry or revenue. That is a documented simplification, and it's the first thing we'd add next.

## 4. The money rules (the most important section)

These rules are written down once and used everywhere: in the code, the statement, and the debrief.

1. **Money is stored as whole cents** (integers), never floating point. All amounts are in USD.
2. **Daily pro-rata.** A coverage's charge for part of the term is `annual premium × days covered ÷ days in term`. The start date counts, the end date doesn't (a policy from Oct 1 to the next Oct 1 is 365 days).
3. **Rounding.** Each charge line is rounded to the nearest cent (half rounds up) and then lines are added up. We never round a total.
4. **History is never edited.** Every action (issue, edit coverage, correct, cancel) is a new *policy transaction* that writes new ledger lines. Fixing a mistake means reversing the old lines and posting new ones, so the original charge and the correction both stay visible.
5. **Balance** is charges minus payments plus refunds. A positive balance is the **amount due**. A negative balance is a **credit** owed to the customer.
6. **Cancellation rule: pro-rata refund of unearned premium.** The broker picks a cancellation date. The customer keeps paying only for days covered up to that date. Whatever they paid beyond that is refunded to their card through Stripe. If they still owed money, the refund shrinks or becomes a balance due. There's no short-rate penalty or minimum earned premium (documented simplification).
7. **Payment status comes from Stripe**, not from the browser. A payment is *pending* until Stripe's webhook says *succeeded* or *failed*. Only succeeded payments reduce the balance.

### Worked example: the scenario the reviewers will test

| Date | Action | Calculation | Ledger line | Balance |
|---|---|---|---|---|
| Oct 1, 2026 | Issue policy, General Liability, term Oct 1, 2026 to Oct 1, 2027 | $1,095 × 365/365 | +$1,095.00 charge | $1,095.00 due |
| Oct 1 | Customer pays (Stripe) | | −$1,095.00 payment | $0.00 |
| Oct 20 | Broker edits coverage to add Cyber, **recorded** effective Nov 1 | $730 × 334/365 | +$668.00 charge | $668.00 due |
| Oct 20 | Customer pays (Stripe) | | −$668.00 payment | $0.00 |
| Nov 10 (three weeks later) | Broker corrects: Cyber actually began **Oct 25** | Reverse the old line, then $730 × 341/365 | −$668.00 reversal, +$682.00 charge | **$14.00 due** |

The customer sees all three Cyber lines, with the original marked "superseded by correction," and a plain-English note: *"Your Cyber coverage start date was corrected from Nov 1 to Oct 25. That adds 7 days of coverage at $2.00/day, so you owe $14.00."*

If the reviewers move the date **later** instead (say Nov 8), the new charge is smaller and the customer has a credit. As a real billing system would, the app first uses that credit to pay down anything else the customer owes. Whatever is left is refunded to their card through Stripe automatically, and the statement shows the refund line. The debrief answer is always the same formula: reverse the old line, post the new line, and the difference is what changes.

**Cancellation example:** if this policy is cancelled effective Apr 1, 2027, there are 183 unused days. The refund is $1,095 × 183/365 = $549.00 for General Liability plus $730 × 183/365 = $366.00 for Cyber, so $915.00 back to the card (assuming everything was paid).

### How a broker edits a policy

Every edit is a new dated change (an "endorsement"). Nothing is ever overwritten.

| Edit | How it works | Money effect |
|---|---|---|
| Edit coverage | One action. The broker picks an effective date and ticks or unticks coverages. General Liability is required and can't be unticked | Each coverage turned on gets a pro-rata charge for the days covered. Each coverage turned off gets a pro-rata credit for the unused days (same math as cancellation, for one coverage). The preview shows every line and the net amount, and a net credit is applied to any balance and refunded otherwise |
| Correct a past change | Pick any earlier change, including the original issue, and fix its date or coverage | Reverse that change's lines and post the corrected ones. Both stay visible |
| Edit details | Business name, contact, address | None. Recorded in the policy history with who changed it and when |

## 5. Who can do what

| | Broker | Policyholder |
|---|---|---|
| Create customers | Yes | No |
| Issue, edit coverage, correct, cancel | Yes | No |
| Edit business and contact details | Yes | No |
| Retry a failed refund | Yes | No |
| See coverage and policy history | All customers | Own policies only |
| Pay amount due | No (can send a payment link) | Yes |
| See the statement and calculation details | Yes | Yes |

Login is a simple email and password with **seeded demo accounts** for each role (e.g. `broker@demo.test` and `owner@acme-bakery.test`), listed in the README for reviewers.

## 6. Screens

**Broker**
- Customers list, and a new customer form
- Policy page with tabs: Coverage, History (every transaction), Statement (ledger), Payments
- Action buttons: Edit coverage, Correct a past change, Cancel policy, Edit details. Each money-affecting action shows a **preview of the money impact before confirming**.
- Integration log: every Stripe and DocuSign event, sent and received

**Policyholder**
- My policies: current coverage, dates, and status
- Pay now: Stripe payment form with live status (pending, succeeded, failed)
- Statement: running balance, and each line opens a "How was this calculated?" panel that links to the action and payment behind it

## 7. Integrations: what's live and what's simulated

| Integration | Sandbox | What it does | Live or simulated |
|---|---|---|---|
| **Stripe** | Test mode | Collects premium (Payment Element with test cards), webhooks drive pending, succeeded, and failed, and the Refunds API returns cancellation refunds and credits | **Live** (test mode) |
| **DocuSign** | Developer sandbox (free, no card) | The policyholder signs the application inside our app (embedded signing) before the broker binds the policy. A Connect webhook marks it signed, and the signed PDF is linked from the policy history | **Live** (sandbox) |
| Email notifications | n/a | Not built. Resend's free tier could be added later | **Not built** |
| Insurance carrier, rating, underwriting | n/a | Premiums come from our own flat rate table, and policies are bound instantly | **Simulated** |
| Policy documents | n/a | An HTML summary page instead of a real declarations PDF | **Simulated** |

Test cards cover the three states: `4242…` succeeds, `4000 0000 0000 0002` is declined, and a delayed-confirmation method (US bank account test mode) shows a real *pending* state.

Every request we send and every webhook we receive is saved in an **integration log table**, which doubles as the "evidence" link for the submission, alongside dashboard screenshots.

## 8. Tech stack

| Piece | Choice | Why |
|---|---|---|
| App | **Next.js (App Router) + TypeScript** | Frontend and backend in one TypeScript codebase, and easy to deploy |
| Database | **Postgres** with **Prisma** | Real transactions and constraints for financial data, and typed queries |
| Hosting | **Vercel** for the app, **Neon** for Postgres (free tiers, no card needed) | Fast deploy, and a public URL for Stripe webhooks |
| UI | Tailwind + shadcn/ui | Clean screens quickly |
| Validation | Zod | One schema for forms and the API |
| Tests | Vitest for the money engine, one Playwright run-through of the scenario | The math is where bugs would hurt most |
| Auth | Signed cookie sessions with seeded users | Good enough for a demo, and no third-party auth to set up |

## 9. Data model (simplified)

- **User**: email, password hash, role (broker or policyholder), linked customer
- **Customer**: business name, contact name, email, address (all fictional)
- **Policy**: policy number, customer, start date, end date, status (active, cancelled)
- **PolicyTransaction**: the history. Type (issue, coverage change, correction, cancellation, details change), effective date, who did it, when, reason, and for corrections, which transaction it corrects
- **CoveragePeriod**: which coverage was active between which dates, created by which transaction
- **LedgerEntry**: the statement. Amount in cents, kind (charge, reversal, payment, refund), the transaction or payment it came from, and the calculation inputs (rate, days, term days) so the "how calculated" panel can show the formula
- **Payment**: Stripe PaymentIntent id, amount, status
- **Refund**: Stripe refund id, the payment it refunds, amount, status
- **IntegrationEvent**: provider, direction, event type, payload, timestamp

The ledger only ever gets new rows. Nothing in it is updated or deleted.

## 10. Build order

| # | Milestone | Done when |
|---|---|---|
| 0 | Setup | Repo, Next.js, Prisma, Neon, login with seeded users, deployed to Vercel |
| 1 | Money engine | Pure TypeScript pro-rata, coverage change, reversal, and cancellation functions, with the worked examples above as unit tests |
| 2 | Issue a policy | Broker creates a customer and policy, and the statement shows the charge |
| 3 | Payments | Stripe payment, webhooks, pending, succeeded, and failed shown to both roles |
| 4 | Edit coverage | One mid-term "Edit coverage" action that turns coverages on or off from an effective date, with a money preview |
| 5 | Correction | The reviewer scenario works end to end, and any past change (including the original issue) can be corrected |
| 6 | Cancel and refund | Pro-rata refund through Stripe, credits applied and auto-refunded, refund status shown |
| 7 | Details edits and statement polish | Non-money detail edits with an audit trail, and every line traceable with "how calculated" panels for both roles |
| 8 | DocuSign and integration log | Application signed in-app before binding, webhook received, evidence page |
| 9 | Submission | README (track, integrations, demo logins), decision log, video, screenshots |

Milestones 1 through 6 are the core workflow and come first.

## 11. What we're leaving out (and why)

- **Installments and billing plans.** Pay-in-full only, so the ledger stays easy to trace. This is the choice we'd defend in the debrief, because installments multiply the number of "amount due" states without testing anything new about pro-rata logic.
- **Taxes, fees, and surcharges** (state premium taxes, policy fees)
- **Short-rate cancellation penalties and minimum earned premium**
- **Rating factors** (industry, revenue, limits and deductibles)
- **Claims, renewals, and broker commissions** (listed by the brief as extensions)
- **Manual premium overrides and term extensions.** Each would add rules without exercising anything new in the money logic.
- **Corrections after cancellation.** Blocked, with a clear message.

## 12. Questions for you

Each has a default I'll go with unless you say otherwise.

1. ~~Second integration~~: decided. DocuSign.
2. **Hosting:** Vercel + Neon (default). You'll need to create free accounts for these, plus Stripe and DocuSign developer accounts, and give me test keys in a local `.env` file.
3. ~~Refunding a credit after a correction~~: decided. The credit pays down any open balance first, and anything left is refunded automatically (see the decision log).
