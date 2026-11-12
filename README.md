# Policy Administration (Track 1)

A platform for managing commercial insurance policies, built for a 48-hour work trial. A **broker** issues a policy, changes its coverage mid-term, corrects mistakes, and cancels it. A **policyholder** sees their coverage, pays what they owe, and reads a statement that explains every charge, payment, and refund.

The idea the whole app is built around: **nothing on the statement is ever edited.** Every action posts new lines, and a mistake is fixed by reversing the wrong line and posting the right one beside it. That is what lets a reviewer trace any amount back to the action and the payment behind it.

- **Track:** 1, policy administration
- **Deployed app:** https://policy-administration.vercel.app
- **Decision log:** [DECISIONS.md](DECISIONS.md), dated, with every assumption marked
- **Integration evidence:** [docs/evidence](docs/evidence/README.md)
- **Video script:** [docs/video-script.md](docs/video-script.md)

## Sign in

All data is fictional. Every login uses the password `demo-password`.

| Role | Email | What they can do |
|---|---|---|
| Broker | `broker@demo.test` | Everything: customers, policies, corrections, cancellations, claims decisions, commissions, the integration log |
| Policyholder (Acme Bakery LLC) | `owner@acme-bakery.test` | See their own policies, sign applications, pay, read the statement, file claims |

Creating a customer as the broker also creates a policyholder login with that customer's email and the same password, so you can sign in as any customer you make.

## The scenario, in two minutes

> A customer has paid for their policy and an additional coverage change. Three weeks later, the broker discovers that the extra coverage began a week earlier than recorded. Correct the effective date and show the revised amount due, keeping the original charge and the correction visible.

1. Sign in as the broker and click **Load demo scenario** on the Customers page. It creates a new customer whose policy was issued and paid six weeks ago, with Cyber Liability added and paid three weeks ago, but recorded as starting a week later than it really did. It takes a few seconds, because it makes two real Stripe test payments. You land on the policy with a $0.00 balance.
2. In **Policy history**, click **Correct this** on entry #2 (the Cyber change). Move the effective date a week earlier and click **Preview correction**.
3. The preview shows exactly what will be posted: a reversal of the original charge, the new charge with its formula, and the new amount due of **$14.00**. Confirm it.
4. The statement now shows the original charge struck through and marked "Superseded by correction #3", the reversal, and the corrected charge. The history entry explains it in plain English: *"Cyber Liability now counts 7 more days … at $2.00 a day … In total, $14.00 more is owed."*
5. Sign in as the policyholder shown on the customer's page. They see the same statement and explanation, and a **Pay $14.00** button.

**Change the date to anything else** and the same thing happens. A later date gives the customer a credit, which the app refunds to their card through Stripe without anyone clicking anything. The same action can be corrected again and again; each correction starts from the current state.

**The calculation**, which every statement line shows under "How was this calculated?":

```
charge = annual premium × days covered ÷ days in the term      (rounded to the cent, per line)

Cyber, $730.00 a year, on a 365-day term that ends Oct 1, 2027:
  recorded from Nov 1:   $730.00 × 334 ÷ 365 = $668.00     (the original charge, paid)
  corrected to Oct 25:   $730.00 × 341 ÷ 365 = $682.00
  the correction posts:  −$668.00 (reversal)  +$682.00 (new charge)  =  $14.00 more due
```

To do it the long way instead of using the button: create a customer, send an application, sign it as the policyholder (DocuSign), issue the policy as the broker, pay as the policyholder, edit coverage as the broker, and pay again.

## The core workflow

| The brief asks for | Where it is |
|---|---|
| Create a customer and issue a policy with coverage, dates, and a premium | Broker → **New customer**, then **Start a new policy**. The policyholder e-signs the application through DocuSign, then the broker issues it. |
| Collect the premium through a sandbox and show pending, successful, or failed | Policyholder → **Pay now** (Stripe test mode, card or US bank account). The **Payments and refunds** table shows each attempt's status and Stripe reference. |
| Add coverage partway through the term, priced from its effective date | Broker → **Edit coverage** on the policy. Pick a date, tick or untick coverages, preview, confirm. |
| Cancel and refund under a documented rule | Broker → **Cancel policy**. Pro-rata: the customer keeps paying only for days up to the cancellation date, and the rest is refunded through Stripe. |
| Policy history and financial statement for both roles, every amount traceable | The policy page, same for both roles. Each statement line opens to show its formula, the history entry that caused it, and the payment or refund record behind it. |

Also built: correcting any past action (including the original issue), editing customer details with a history trail, and the three extensions the brief names.

| Extension | What it does |
|---|---|
| **Claims** | Either role files a claim. It is accepted only if that coverage was in force on the date of loss, so correcting a start date can bring a loss into cover. The broker approves (payout = approved loss − $500 deductible, capped at the coverage limit) or denies with a reason. |
| **Renewals** | **Renew policy** creates a linked policy for the next 12 months with the coverages in force at expiry, at today's prices. A policy and its renewal can never overlap. |
| **Broker commissions** | 10% of premium, calculated line by line from the statement, with a clawback when premium is credited back. |

## How the money works

These rules live in `src/lib/engine` (pure functions, no database) and are used by every screen.

1. **Whole cents, in USD.** No floating-point dollars anywhere.
2. **Daily pro-rata.** `annual premium × days covered ÷ days in term`. The start date counts and the end date doesn't. Every policy runs 12 months, so the term is 365 days, or 366 across a Feb 29.
3. **Rounded per line.** Each line is rounded to the cent, halves up, and totals are sums of rounded lines.
4. **Append-only.** Issue, coverage change, correction, and cancellation each post new lines. A correction reverses the affected lines and posts new ones. Rows are never updated or deleted.
5. **One calculation, replayed.** Premium is always worked out by replaying the policy's history (`replay.ts`). A correction replays it with the corrected action in place, compares the result with the statement, and posts only the difference. A correction that would break a later action is refused with an explanation.
6. **Balance = charges − payments + refunds.** Positive is the amount due. Negative is a credit, which first absorbs anything else owed and is then refunded to the card.
7. **Stripe decides what was paid.** A payment or refund reaches the statement only when Stripe's servers confirm it, by webhook or by a direct status check. Hearing about it twice posts one line.
8. **Cancellation is pro-rata with no penalty.** Refund = paid − earned.

## Integrations: what is live and what is simulated

| | Status | What it does here |
|---|---|---|
| **Stripe** (test mode) | **Live** | Collects premium with Stripe's payment form (card or US bank account). Webhooks move a payment to succeeded, failed, or pending. The Refunds API returns credits after corrections and cancellations, against the original payments. |
| **DocuSign** (developer sandbox) | **Live** | The policyholder signs the application inside the app (embedded signing) before the broker can issue the policy. A completion webhook marks it signed, and the signed PDF with DocuSign's certificate is linked from the policy. |
| Insurer, rating, underwriting | **Simulated** | Prices come from a flat rate table in `src/lib/engine/catalog.ts`. Policies are bound as soon as the broker issues them. |
| Claim payments | **Simulated** | Recording a claim payment marks it paid in the app. No money moves. |
| Paying the broker's commission | **Not modelled** | Commission is calculated and shown only. |
| Policy documents | **Simulated** | The signed application is real (DocuSign). There is no declarations page or policy PDF. |
| Email notifications | **Not built** | |

Both live integrations were tested on the deployed app, including their webhooks. The broker's **Integration log** page lists every request the app sent to a sandbox and every webhook it received. See [docs/evidence](docs/evidence/README.md).

The demo scenario button skips the DocuSign signature and backdates its own history. The policy page says so wherever that applies.

## What we simplified

- **Pay in full only, no installments.** This is the choice we'd most like to discuss. Installments multiply the states of "amount due" (scheduled, due, overdue, partly paid) without exercising anything new in the pro-rata logic the brief focuses on. Pay-in-full keeps one balance per policy, so every amount stays easy to trace.
- **One product, flat prices.** A Small Business Package with three coverages at fixed annual prices. No rating factors such as industry, revenue, limits, or deductibles.
- **No taxes, fees, or surcharges.**
- **No short-rate penalty or minimum earned premium** on cancellation.
- **Fixed 12-month term.** No short-term policies or term extensions.
- **Renewals** can be created at any time and need no new application. A real system offers them 60 to 90 days out, sends a notice, and lapses an unpaid renewal after a grace period. We show the premium as due on the new term's start date and stop there.
- **Claims** have one flat deductible and a per-claim limit. No reserves, partial payments, or annual aggregate limits.
- **Commission** is earned when premium is charged, not when it is collected.
- **Sign-in** is two seeded demo roles with a shared password. No sign-up, password reset, or single sign-on.

Each of these is recorded with its reasoning in [DECISIONS.md](DECISIONS.md).

## What we'd build next

1. **Installment plans**, with a schedule per policy and payments applied to the oldest instalment first.
2. **Real rating**: price by industry, revenue, limits, and deductibles, with the factors saved on each line so the formula stays reproducible.
3. **Taxes and fees** as their own statement lines, each with its own refund rule (many fees aren't refundable).
4. **A proper renewal cycle**: offer, notice, payment by the start date, and automatic lapse for non-payment.
5. **Reinstatement** after a cancellation, and short-rate cancellation where the insurer requires it.
6. **Policy documents**: a declarations page generated from the policy's current state, reissued after each change.
7. **Accounting export** of the ledger, for example to QuickBooks, and payment of commissions.
8. **Email notifications** for each statement event.

## Tests and how the app is checked

| Command | What it covers |
|---|---|
| `npm run check` | Typecheck, lint, and `npm test`: the money rules, the whole workflow against a local test database (including the scenario above), and the payment rules with a stand-in for Stripe. |
| `npm run test:stripe` | The real payment and refund code against Stripe's test mode through its API: a declined card, a card payment, refunds after a correction and a cancellation, a pending bank payment, and the demo scenario. |
| `npm run test:e2e` | A real browser (Playwright) running the scenario end to end, typing test cards into Stripe's own card form. |
| `npm run smoke` | Signs in to the deployed site as each role and opens the main pages. Read-only. |
| `npm run test:deployed` | Refunds and claims in a browser against the deployed site. Changes data. |
| `npm run prod:query` | A read-only summary of the deployed database, for confirming results. |

DocuSign signing is checked by hand, because it happens on DocuSign's own page.

## Run it locally

Requires Node 24 and a local Postgres.

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and SESSION_SECRET; Stripe and DocuSign keys are optional
createdb policy_admin_dev
npm run db:migrate          # create the tables
npm run db:seed             # create the two demo logins
npm run dev
```

Without Stripe keys, policies can be issued and changed but not paid. Without DocuSign keys, the broker issues a policy directly, with no signature step. `.env.example` lists every setting.

## Where things are

| Path | What's there |
|---|---|
| `src/lib/engine/` | The money rules: pro-rata, replaying a policy's history, corrections, refund allocation, commission, claim payout. Pure functions with unit tests. |
| `src/lib/policies/` | The actions: issue, change coverage, correct, cancel, payments and refunds, applications, renewals, claims, the demo scenario. |
| `src/lib/integrations/` | Stripe and DocuSign clients, and the integration log. |
| `src/app/` | Screens and server actions for the broker (`/broker`) and the policyholder (`/portal`), plus the two webhook routes under `/api`. |
| `prisma/schema.prisma` | The data model. `LedgerEntry` is the statement and `PolicyTransaction` is the history. |
| `test/`, `e2e/`, `deployed/`, `smoke/` | Integration tests, browser tests, and the deployed-site checks. |
| `AGENTS.md` | Working notes for coding agents (and people) on how to verify a change. |
| `PLAN.md` | The original plan, kept as written. The app has since grown past it. |

## Stack

Next.js 16 (App Router) and TypeScript, Prisma 7 on Postgres, Tailwind CSS, Zod, Stripe, DocuSign's REST API, Vitest, and Playwright. Deployed on Vercel with a Neon database.
