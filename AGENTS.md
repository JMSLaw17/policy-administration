<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Working on this repo

This file is the shared guide for every coding agent. `CLAUDE.md` is a symlink to it, so Claude Code, Codex, Cursor and others all read the same instructions. Edit `AGENTS.md`; keep the Next.js block above as it is (`next dev` maintains it).

Insurance policy administration demo (Corgi work trial, Track 1). Next.js 16 App Router, TypeScript, Prisma 7 on Postgres, Stripe test mode, DocuSign developer sandbox. Deployed at https://policy-administration.vercel.app on Vercel Hobby with Neon Postgres.

- Plan: `PLAN.md`. Decisions and assumptions: `DECISIONS.md` (add a short dated entry for any important decision).
- No pull requests: commit and push straight to `main`. Pushing to `main` deploys to Vercel.
- All data is fictional. Never use real money, real people or live keys.

## How to verify a change

Run these, in this order, before saying a change works:

1. `npm run check`: typecheck, lint and `npm test` in one go. `npm test` is the unit and integration tests; they run against a local `policy_admin_test` database that is created and migrated automatically. They refuse to run against a database that isn't local.
2. If the change touches payments or refunds: `npm run test:stripe` (talks to the real Stripe test mode, needs the Stripe keys in `.env`).
3. If the change touches screens or the main workflow: `npm run test:e2e` (Playwright in the installed Chrome, against its own `policy_admin_e2e` database on port 3200, started by `scripts/e2e-server.mjs`). DocuSign is switched off in this copy, so the broker issues policies directly. Failure screenshots land in `test-results/`.

To look at the running app yourself: `npm run dev`, then sign in at http://localhost:3000/login.

## Demo logins and test data

- Broker: `broker@demo.test`. Policyholder (Acme Bakery LLC): `owner@acme-bakery.test`. Both use the password `demo-password` (see `src/lib/demo.ts`). `npm run db:seed` recreates them.
- Stripe test cards: `4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` is declined. Any future expiry, any CVC, any ZIP.
- DocuSign sandbox signing happens on DocuSign's own page and can't be automated; check it by hand.

## Checking the deployed app

- `npm run smoke` signs in to https://policy-administration.vercel.app as each demo user and opens the main pages and the first policy and customer it finds. It is read-only apart from signing in. Run it after a push to `main` once Vercel has deployed. `SMOKE_URL=http://localhost:3000 npm run smoke` runs the same check against your dev server.
- `npm run test:deployed` checks refunds and claims on the deployed site in a browser. Unlike the smoke check it changes data: on an existing paid policy (`POLICY=SBP-2026-0001` by default) it adds Cyber if needed, pays by test card, corrects the date a week later so the app refunds the difference, then files two claims and approves one and denies the other. It can be rerun. `DEPLOYED_URL=http://localhost:3100 POLICY=... npm run test:deployed` runs it against a dev server. `npm run test:deployed -- cancel-and-renew` runs only the second file, which loads two demo scenarios, cancels one with its refund, and renews the other; `-- refunds-and-claims` runs only the first.
- `npm run evidence` rewrites `docs/evidence/*.md` from Stripe's API, DocuSign's API, and the deployed database (read-only). `npm run evidence:screenshots` reruns the scenario on the deployed site in a browser and saves screenshots to `docs/evidence/screenshots` (it creates demo data).
- `npm run prod:query` prints a read-only summary of the deployed database (policies and balances, applications, payments, refunds, recent integration events). `npm run prod:query -- "select ..."` runs one SELECT. Needs `PROD_DATABASE_URL` in the git-ignored `.env.production.local`. It cannot change data; never try to write to production.
- The broker's Integration log page (`/broker/integrations`) shows recent Stripe and DocuSign webhook events as the app received them.

## Interface conventions

- A button never changes size or wording when clicked. Wrap its text in `<ButtonLabel pending={...}>` from `src/components/ui.tsx` and disable it while pending: the label keeps its space and a spinner shows in its place.
- Everything clickable shows a pointer cursor (a global rule in `src/app/globals.css`), and disabled controls show "not allowed".
- Every money-affecting broker action shows a preview of its effect on the statement before it is confirmed.

## Things that have bitten us

- Run `npm run build` before pushing. A type error that only shows in the build has broken a Vercel deployment before.
- After changing `prisma/schema.prisma`, run `npx prisma generate` and restart `npm run dev`. The dev server keeps the old database client in memory and fails with errors like "Cannot read properties of undefined (reading 'findMany')".
- `prisma migrate dev` stops when it has a warning to confirm and there's no terminal to answer it. Write the migration with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` into a new folder under `prisma/migrations/`, then apply it with `npx prisma migrate deploy`.
- If a newly added route returns 404 in development, restart the dev server.
- DocuSign's consent redirect was registered for `http://localhost:3100`, so local signing is tested with `npm run dev -- -p 3100`.
- In browser tests, Stripe's card form resizes as fields appear. Wait for it to settle before clicking Pay (see `payByCard` in `e2e/scenario.spec.ts`).
- Stripe sends webhooks for every test payment to the deployed app, including payments made locally or by tests. The webhook handler ignores, and doesn't log, events whose policy isn't in its own database.

## The reviewers' scenario

A customer has paid for a policy and a mid-term coverage change. Three weeks later the broker learns the extra coverage began a week earlier than recorded. Correcting the effective date must show the revised amount due and keep the original charge and the correction both visible. `e2e/scenario.spec.ts` drives this end to end. The broker's **Load demo scenario** button (`src/lib/policies/demo-scenario.ts`) creates a fresh customer and policy at the scenario's starting point, with real Stripe test payments and a backdated history, so the correction can be tried without issuing, signing, and paying first.

## MCP servers

`.mcp.json` sets up two project MCP servers for Claude Code (other agents keep MCP config in their own files):

- **Playwright** (`@playwright/mcp`): drive the running app in a browser, click through screens and take screenshots. Use it to look at a change by hand; use `npm run test:e2e` to prove it.
- **Vercel** (`https://mcp.vercel.com`): read deployments, build logs and runtime logs for the deployed app, e.g. when a Stripe or DocuSign webhook fails in production. Signs in with Vercel OAuth; read, don't change project settings.

## Secrets

`.env`, `.env.production.local` and `docusign_private.pem` are git-ignored. Never print their contents, commit them, or paste them anywhere.
