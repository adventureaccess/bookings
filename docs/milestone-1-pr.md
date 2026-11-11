# Milestone 1: Skeleton

> Historical. Written on Nov 10, 2026, when the app was Next.js on Vercel. On Nov 11 it moved to Astro on Netlify; see README.md and CLAUDE.md for the current setup.

Paste this as the pull request description for `milestone-1-skeleton`.

## What is here

- Next.js 16.4.6 (App Router), TypeScript strict with `noUncheckedIndexedAccess`, Tailwind 4. Exact versions pinned (`.npmrc` `save-exact=true`), Node 22 in `.nvmrc` and `engines`.
- Cormorant Garamond and Jost self-hosted through `next/font`; the trip-page palette as Tailwind tokens (copied from `TripPage.astro` in the website repo). Placeholder home page: "Bookings open soon."
- `src/lib`: Zod-validated environment, cents helpers, shared Zod building blocks, anon and service-role Supabase clients (both `server-only`).
- Five migrations covering all 13 tables, enums for every status column, check constraints, indexes, RLS enabled and forced on every table, explicit grants.
- 39 tests. The database tests apply the migrations to an in-process Postgres (PGlite) and check constraints, the published-policy lock, and row-level security for the public, a non-staff Google account, each staff role and the service role.
- CI: public env name check, typecheck, lint, tests, build, `npm audit --audit-level=high`. Dependabot weekly for npm and Actions.
- Baseline headers: HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`. `X-Powered-By` removed.
- README with PowerShell setup, migrations and checks.

## Verified locally

- `npm run typecheck`, `npm run lint`, `npm test` (39 passed), `npm run check:env`, `npm run build` all pass.
- `npm audit --audit-level=high` passes. 7 moderate advisories remain, all in `@typescript-eslint` packages pulled in by `eslint-config-next` (lint tooling, not shipped).
- The home page renders in the dev server with both fonts, no requests to other origins, and all four headers present.

## Not verified yet

- CI on GitHub and the Vercel preview. Both need the repo and the Vercel project to exist. This is the remaining part of "done".
- Migrations against a real Supabase project. They have only run against PGlite with stand-ins for Supabase's roles and `auth.jwt()`. Run `npx supabase db push --dry-run` against the dev project first.

## Defaults and deviations to review

1. **Next.js 16, not 15.** Current stable major at scaffold time. The scaffold turns on `cacheComponents` and `partialPrefetching`; I left them on.
2. **TypeScript 5.9 and ESLint 9, not the newest majors (7 and 10).** These are what `create-next-app` 16.4.6 targets. Dependabot will propose the upgrades.
3. **Environment check is staged.** The plan said the build fails on any missing name. As built, only the three Supabase names are required; Stripe, HubSpot, Resend, Turnstile, cron and token-signing names are optional until the milestone that uses them. Otherwise the empty preview could not deploy without placeholder Stripe and HubSpot keys in Vercel. Each name becomes required in its milestone.
4. **`SITE_URL` is server-only and optional.** It falls back to the Vercel deployment URL so previews need no setup.
5. **RLS test runs on PGlite, not Supabase.** Fast and Docker-free, but it is a stand-in. Migrations run there as a role with no superuser or bypass-RLS rights, which is stricter than Supabase.
6. **Additions beyond the data model in CLAUDE.md:**
   - `currency` on departures, bookings and payments (the brief says "with a currency column").
   - `payments.status` values: pending, succeeded, failed.
   - `sync_jobs.next_run_at` is nullable; null means finished. A status column may be clearer in milestone 5.
   - `can_write()` helper alongside `is_staff()` and `staff_role()`.
   - Extra constraints: deposit cannot exceed price, balance due date cannot be after the start date, a private departure needs a token, one lead traveler per booking, one hold per booking, one payment row per Checkout Session and per refund, staff emails must be lowercase `@adventure-access.com`, hero image must be `https://`.
7. **Grants are explicit.** The migration revokes Supabase's default table grants from `anon` and `authenticated` (including for future tables), then grants back only what the policies allow.
8. **Staff cannot write `trips`.** Trips come from the website feed through server code.
9. **CI also runs the build**, with placeholder environment values. Not in the plan; it catches a broken build before Vercel does.
10. Service role performs the booking transaction; rate limiting is a Postgres table (both as planned).

## Questions before milestone 2

1. Is the website repo public or private? It decides how trip data reaches this app.
2. Which Vercel plan is the team on? Five-minute cron may need a paid plan.
3. GitHub repo name: `adventureaccess/bookings` acceptable?
