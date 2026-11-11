# Policy Administration (Track 1)

A demo platform for managing commercial insurance policies, built for a 48-hour work trial. A **broker** issues a policy, edits its coverage mid-term, corrects mistakes, and cancels it. A **policyholder** sees their coverage, pays what they owe, and reads a statement that explains every charge, payment, and refund.

- **Track:** 1, policy administration
- **Plan:** [PLAN.md](PLAN.md)
- **Decision log:** [DECISIONS.md](DECISIONS.md)

> This README grows as the build progresses. Status as of 2026-11-11: a broker can create customers, issue a policy, edit coverage, correct any past action, and cancel, and both roles see the statement and history. Payments, refunds, and e-signing are not built yet.

## Demo logins

All data is fictional. Both accounts use the password `demo-password`.

| Role | Email |
|---|---|
| Broker | `broker@demo.test` |
| Policyholder (Acme Bakery LLC) | `owner@acme-bakery.test` |

## Integrations

| Integration | Status |
|---|---|
| Stripe (test mode): payments, webhooks, refunds | Planned, not built yet |
| DocuSign (developer sandbox): e-signing the application | Planned, not built yet |
| Carrier, rating, underwriting | Simulated (flat rate table in this repo) |

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

Other commands: `npm test` (unit tests), `npm run typecheck`, `npm run lint`.

## Stack

Next.js 16 (App Router) and TypeScript, Prisma 7 with Postgres, Tailwind CSS, Zod, Vitest.
