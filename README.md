# Policy Administration (Track 1)

A demo platform for managing commercial insurance policies, built for a 48-hour work trial. A **broker** issues a policy, edits its coverage mid-term, corrects mistakes, and cancels it. A **policyholder** sees their coverage, pays what they owe, and reads a statement that explains every charge, payment, and refund.

- **Track:** 1, policy administration
- **Plan:** [PLAN.md](PLAN.md)
- **Decision log:** [DECISIONS.md](DECISIONS.md)

> This README grows as the build progresses. Status as of 2026-11-11: the policy workflow, Stripe payments and refunds, DocuSign signing, customer details editing, and the three extensions (claims, renewals, broker commissions) are built and tested.

## Demo logins

All data is fictional. Both accounts use the password `demo-password`.

| Role | Email |
|---|---|
| Broker | `broker@demo.test` |
| Policyholder (Acme Bakery LLC) | `owner@acme-bakery.test` |

## Integrations

| Integration | Status |
|---|---|
| Stripe (test mode): payments, webhooks, refunds | Live in test mode, tested locally and on the deployed app |
| DocuSign (developer sandbox): e-signing the application | Live in the sandbox, tested locally and on the deployed app, including the completion webhook |
| Carrier, rating, underwriting | Simulated (flat rate table in this repo) |
| Claim payments | Simulated (recorded in the app, no money moves) |
| Paying commission to the broker | Not modelled (commission is calculated and shown only) |

## Run it locally

Requires Node 24 and a local Postgres.

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL and SESSION_SECRET
createdb policy_admin_dev
npm run db:migrate          # create the tables
npm run db:seed             # create the demo logins
npm run dev
```

Other commands: `npm test` (unit tests, plus integration tests against a local `policy_admin_test` database that is created automatically), `npm run typecheck`, `npm run lint`.

### Checking the deployed database

`npm run prod:query` prints a read-only summary of the deployed app's database (policies and balances, applications, payments, refunds, and recent integration events). `npm run prod:query -- "select ..."` runs one SELECT. It reads the connection string from a git-ignored `.env.production.local` file (`PROD_DATABASE_URL=...`) and can't change data: the session and every transaction are read-only, and only a single statement is accepted.

## Stack

Next.js 16 (App Router) and TypeScript, Prisma 7 with Postgres, Tailwind CSS, Zod, Vitest.
