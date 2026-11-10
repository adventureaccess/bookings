# Milestone 1 plan: Skeleton

Status: waiting for Will's approval. Nothing below has been built.

Done when: CI passes on the PR and an empty preview deploys on Vercel.

## What Will does first (about 15 minutes)

1. Create a private GitHub repo, `adventureaccess/bookings`, with no README.
2. Create a Supabase project for development (suggested name `aa-bookings-dev`). Keep the keys; do not paste them into chat.
3. Create a Vercel project from the GitHub repo once the first branch is pushed. Add the environment variables listed in `.env.example` to Preview only.

In PowerShell, from this folder:

```powershell
git init -b main
git add .
git commit -m "Add project brief and milestone 1 plan"
git remote add origin https://github.com/adventureaccess/bookings.git
git push -u origin main
git switch -c milestone-1-skeleton
```

## Steps

1. **Scaffold.** `create-next-app` with App Router, TypeScript, Tailwind, ESLint, `src/` directory. Turn on `strict` and `noUncheckedIndexedAccess`. Pin exact versions (`save-exact=true` in `.npmrc`). Record the Node version in `.nvmrc` and `engines` (22, same as the website).
2. **Look and feel.** Load Cormorant Garamond and Jost through `next/font/google` (self-hosted, so the CSP stays tight). Tailwind tokens for the trip-page palette, with orange `#E8631A` as the accent. One placeholder home page: the wordmark and "Bookings open soon."
3. **Structure.**
   - `src/app/` routes (placeholder only)
   - `src/lib/env.ts` Zod-validated environment, server-only, fails the build on a missing name
   - `src/lib/money.ts` cents helpers, with unit tests
   - `src/lib/schemas/` shared Zod schemas (empty shells)
   - `src/lib/supabase/` server clients: anon and service role, the second marked `server-only`
4. **Database.** One migration per concern in `supabase/migrations`:
   - `0001_extensions_and_helpers.sql`: `pgcrypto`, `updated_at` trigger, `is_staff()` and `staff_role()` helpers
   - `0002_core_tables.sql`: trips, departures, bookings, travelers, seat_holds, payments
   - `0003_policy_tables.sql`: policy_versions (with a trigger that blocks edits after `published_at`), policy_acceptances
   - `0004_ops_tables.sql`: staff, activity_log, webhook_events, sync_jobs, rate_limits
   - `0005_rls.sql`: RLS enabled and forced on every table
   - Enums for every status column. Check constraints: cents are non-negative, `min_travelers <= max_travelers`, `end_date >= start_date`, currency = `usd`.
   - Indexes on foreign keys, `bookings.reference` (unique), `webhook_events.stripe_event_id` (unique), `seat_holds (departure_id, expires_at)`, `sync_jobs.next_run_at`.
5. **RLS policies.**
   - Anonymous: read `trips` where active; read `departures` where public and status is open or full; read published `policy_versions`. Nothing else, and no writes.
   - Staff (signed in, email in `staff`): read everything; write departures and policy versions for `admin` and `staff` roles; `read_only` reads only.
   - bookings, travelers, seat_holds, payments, policy_acceptances, webhook_events, sync_jobs, rate_limits: no anonymous or direct staff writes. They are written by server code using the service role.
   - A test file asserts that every table in the public schema has RLS enabled, so a future table cannot ship without it.
6. **Environment.** `.env.example` with names only: Supabase URL, anon key, service role key, Stripe secret and webhook secret, HubSpot token, Resend key, Turnstile site and secret keys, cron secret, token-signing secret, site URL. Only the Supabase URL, anon key and Turnstile site key are `NEXT_PUBLIC_`.
7. **CI.** GitHub Actions on every PR: `npm ci`, typecheck, lint, Vitest, `npm audit --audit-level=high`. Dependabot weekly for npm and Actions. A check that fails if any `NEXT_PUBLIC_` name contains SECRET, SERVICE or TOKEN.
8. **Baseline headers.** HSTS, `X-Frame-Options: DENY`, `Referrer-Policy`, and `X-Content-Type-Options` now. The full CSP comes in milestone 6 with Stripe and Turnstile in place.
9. **README.** Local setup for Windows PowerShell, how to apply migrations to the dev project, how to run tests.

## Not in this milestone

No auth, no forms, no Stripe, HubSpot or email code. No DNS changes. No production Supabase project.

## Defaults I will use and flag in the PR

- Current stable Next.js major, not necessarily 15.
- Migrations applied to the hosted dev project with the Supabase CLI (`supabase db push`), so Docker Desktop is not required on Windows.
- The service role performs the booking transaction; anonymous users get read-only policies.
- Rate limiting backed by a Postgres table.

## Questions for Will before milestone 2

1. Is the website repo public or private? It decides how trip data reaches this app.
2. Which Vercel plan is the team on? Five-minute cron may need a paid plan.
3. GitHub repo name: `adventureaccess/bookings` acceptable?
