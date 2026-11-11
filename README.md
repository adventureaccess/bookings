# Adventure Access Bookings

Takes a traveler from a trip page to a paid deposit, recorded in Stripe and HubSpot. The full brief is in [CLAUDE.md](CLAUDE.md). This README covers running it.

Status: milestone 1 (skeleton). There is a placeholder home page, the full database schema with row-level security, and CI. No auth, forms, Stripe, HubSpot or email yet.

Built with Astro (server-rendered), hosted on Netlify, with a Supabase Postgres database.

## What you need

- Node 22.23.4 or newer (`node -v`)
- A Supabase **dev** project. Never point this at production data.
- Commands below are for Windows PowerShell.

## First-time setup

```powershell
npm ci
Copy-Item .env.example .env.local
notepad .env.local
```

Fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project Settings, API Keys, in the Supabase dashboard). The rest can stay blank until their milestones. `.env.local` is ignored by git; never commit it or paste keys into chat, issues or commit messages.

```powershell
npm run dev
```

Open http://localhost:4321. The dev server and the build stop with a list of names if a required variable is missing.

## Environment variables

Every variable is declared in the `env.schema` in `astro.config.ts` and read in server code through `astro:env/server`. None reaches the browser: no name uses Astro's public prefix, and `npm run check:env` fails if one appears. To add a variable, add it to the schema, to `.env.example` (name only) and to Netlify.

## Apply migrations to the dev project

Migrations live in `supabase/migrations` and run in filename order. The Supabase CLI pushes them straight to the hosted dev project, so Docker is not needed.

```powershell
npx supabase login
npx supabase link --project-ref pvfnlahywytptizpgkwo
npx supabase db push --dry-run
npx supabase db push
```

`--dry-run` lists what would be applied. Read it before the real push, and check the project ref is the dev project. To add a migration, run `npx supabase migration new <name>` and fill in the file it creates; do not edit one that has been applied.

The dev project is "Bookings" (ref `pvfnlahywytptizpgkwo`). The six migrations in this folder are already applied there, and the filenames match the versions recorded in the database, so `db push` only sends new ones.

## Hosting on Netlify

The app is its own Netlify project, `adventure-access-bookings`, separate from the marketing site but in the same team. It is live at https://adventure-access-bookings.netlify.app. Build settings come from `netlify.toml`; the Astro Netlify adapter turns server routes into Netlify Functions.

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set on the project. Add later secrets in Project configuration, Environment variables, and tick "Contains secret values" for each. Changing a variable needs a new deploy to take effect.
- **Still to do:** link the project to the GitHub repo (Project configuration, Build & deploy, Link repository, `adventureaccess/bookings`), so every pull request gets a Deploy Preview and production deploys from `main`. Until then, deploys are uploaded by hand from a working copy.
- The custom domain `book.adventure-access.com` is not attached yet.

Security headers are set in two places that must agree: `src/middleware.ts` for server-rendered pages and `netlify.toml` for static files. A test checks they match.

## Checks

```powershell
npm run check:env
npm run typecheck
npm run lint
npm test
npm run build
npm run audit
```

CI runs all of these on every pull request.

- `npm test` runs the unit tests and the database tests. The database tests apply every migration to an in-process Postgres (PGlite) and check constraints and row-level security, including that **every table has RLS enabled and forced**. A new table without RLS fails CI. No database or Docker is needed.
- `npm run check:env` fails if any browser-exposed environment variable name appears in the repo.
- `npm run audit` fails on high or critical advisories.

## Layout

| Path | What |
|---|---|
| `astro.config.ts` | Astro config and the environment variable schema |
| `netlify.toml` | Netlify build settings and static-file headers |
| `src/pages/` | Routes (placeholder only so far) |
| `src/layouts/` | Page shell: fonts, metadata |
| `src/styles/global.css` | Tailwind and the trip-page palette |
| `src/middleware.ts` | Security headers on every server response |
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
- Line endings are LF everywhere (`.gitattributes`). Netlify reads files such as `.nvmrc` as they are, and a Windows line ending breaks the build.
