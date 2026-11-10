# Adventure Access Bookings

Takes a traveler from a trip page to a paid deposit, recorded in Stripe and HubSpot. The full brief is in [CLAUDE.md](CLAUDE.md). This README covers running it.

Status: milestone 1 (skeleton). There is a placeholder home page, the full database schema with row-level security, and CI. No auth, forms, Stripe, HubSpot or email yet.

## What you need

- Node 22 or newer (`node -v`)
- A Supabase **dev** project. Never point this at production data.
- Commands below are for Windows PowerShell.

## First-time setup

```powershell
npm ci
Copy-Item .env.example .env.local
notepad .env.local
```

Fill in the three Supabase values (Project Settings, API, in the Supabase dashboard). The rest can stay blank until their milestones. `.env.local` is ignored by git; never commit it or paste keys into chat, issues or commit messages.

```powershell
npm run dev
```

Open http://localhost:3000. The build and the dev server stop with a list of names if a required variable is missing.

## Apply migrations to the dev project

Migrations live in `supabase/migrations` and run in filename order. The Supabase CLI pushes them straight to the hosted dev project, so Docker is not needed.

```powershell
npx supabase login
npx supabase link --project-ref <dev-project-ref>
npx supabase db push --dry-run
npx supabase db push
```

`--dry-run` lists what would be applied. Read it before the real push, and check the project ref is the dev project. To add a migration, create the next numbered file (`0006_...sql`); do not edit one that has been pushed.

## Checks

```powershell
npm run typecheck
npm run lint
npm test
npm run check:env
npm run audit
npm run build
```

CI runs all of these on every pull request.

- `npm test` runs the unit tests and the database tests. The database tests apply every migration to an in-process Postgres (PGlite) and check constraints and row-level security, including that **every table has RLS enabled and forced**. A new table without RLS fails CI. No database or Docker is needed.
- `npm run check:env` fails if a `NEXT_PUBLIC_` name looks like a secret or is not on the allowlist of three public names.
- `npm run audit` fails on high or critical advisories.

## Layout

| Path | What |
|---|---|
| `src/app/` | Routes (placeholder only so far) |
| `src/lib/env.schema.ts` | Every environment variable, validated with Zod |
| `src/lib/env.ts` | The validated environment, server-only |
| `src/lib/money.ts` | Integer-cents helpers |
| `src/lib/schemas/` | Shared Zod building blocks |
| `src/lib/supabase/` | Server clients: anon (RLS applies) and service role (bypasses RLS) |
| `supabase/migrations/` | Schema, constraints, RLS policies and grants |
| `tests/db/` | Database tests and the PGlite harness |
| `scripts/` | CI helper scripts |

## Rules

- One milestone per branch and pull request. Never push to `main`.
- Stripe test mode and the Supabase dev project only.
- No real secrets in code, tests, fixtures or commit messages.
- The service-role client is for the webhook, cron routes, the booking transaction and admin actions after a role check. Nowhere else.
