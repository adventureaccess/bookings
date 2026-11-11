# Adventure Access Bookings

Takes a traveler from a trip page to a paid deposit, recorded in Stripe and HubSpot. The full brief is in [CLAUDE.md](CLAUDE.md). This README covers running it.

Status: milestone 2 (staff admin and departures). Staff sign in with Google at `/admin` and manage departures, policy versions and the trip list. No traveler booking form, Stripe, HubSpot or email yet.

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

Fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (Project Settings, API Keys, in the Supabase dashboard). The rest can stay blank until their milestones. `.env.local` is ignored by git; never commit it or paste keys into chat, issues or commit messages.

```powershell
npm run dev
```

Open http://localhost:4321. The dev server and the build stop with a list of names if a required variable is missing.

## Environment variables

Every variable is declared in the `env.schema` in `astro.config.ts` and read in server code through `astro:env/server`. None reaches the browser: no name uses Astro's public prefix, and `npm run check:env` fails if one appears. To add a variable, add it to the schema, to `.env.example` (name only) and to Netlify.

## Staff admin

The admin lives at `/admin`. Three things must all be true to get in:

1. The account signed in through Google (not email and password).
2. Its email is confirmed and ends in `@adventure-access.com`.
3. That email is in the `staff` table.

Roles: `admin` and `staff` can change departures and policies; `read_only` can view. Anyone else who completes Google sign-in is signed straight back out. The database enforces the same rule in its row-level security, so the check does not rest on the app alone.

**Adding or changing staff** is done in the Supabase SQL editor for now (a staff screen is not built yet):

```sql
insert into public.staff (email, role) values ('name@adventure-access.com', 'staff');
```

**One-time sign-in setup**

1. Google Cloud Console, APIs & Services, Credentials: create an OAuth client ID of type "Web application" with the redirect URI `https://pvfnlahywytptizpgkwo.supabase.co/auth/v1/callback`.
2. Supabase, Authentication, Sign In / Providers: turn on Google and paste the client ID and secret. Turn **off** the Email provider; only Google should be able to create accounts.
3. Supabase, Authentication, URL Configuration: set the Site URL to the live site and add these redirect URLs: `http://localhost:4321/**`, `https://adventure-access-bookings.netlify.app/**`, `https://*--adventure-access-bookings.netlify.app/**`.

**Working locally without Google.** Set `DEV_STAFF_EMAIL` in `.env.local` to an email that is in the staff table and `npm run dev` treats you as that person. This only exists in the dev server: every build strips it out, and `npm run check:build` fails CI if it ever survives. Remove the line to test real Google sign-in locally.

**What the admin does**

- **Departures:** create, edit and delete. Prices are entered in dollars and stored in cents. A blank balance due date becomes 60 days before the start date. A private departure gets an unguessable link. A departure with bookings cannot be deleted; cancel it instead.
- **Policies:** a draft can be edited freely. Publishing locks the text for good, in the app and in the database, so there is a permanent record of what each traveler agreed to. Only a published version can be attached to a departure.
- **Trips:** "Sync from website" reads the feed at `TRIPS_FEED_URL` and updates slug, title, destination and hero image. A trip that left the feed is switched off, never deleted. Until the website publishes the feed, the button explains that it is not set up.
- Every change is written to `activity_log` with who made it.

**Trip feed format** (to be published by the website as `trips.json`, listing only trips that are `unlisted` or `public`):

```json
{ "trips": [ { "slug": "ladakh-multisport", "title": "Ladakh Multisport", "destination": "ladakh", "heroImage": "https://adventure-access.com/images/2024/05/Ladakh-hero-image.jpg" } ] }
```

## Apply migrations to the dev project

Migrations live in `supabase/migrations` and run in filename order. The Supabase CLI pushes them straight to the hosted dev project, so Docker is not needed.

```powershell
npx supabase login
npx supabase link --project-ref pvfnlahywytptizpgkwo
npx supabase db push --dry-run
npx supabase db push
```

`--dry-run` lists what would be applied. Read it before the real push, and check the project ref is the dev project. To add a migration, run `npx supabase migration new <name>` and fill in the file it creates; do not edit one that has been applied.

The dev project is "Bookings" (ref `pvfnlahywytptizpgkwo`). The seven migrations in this folder are already applied there, and the filenames match the versions recorded in the database, so `db push` only sends new ones.

## Hosting on Netlify

The app is its own Netlify project, `adventure-access-bookings`, separate from the marketing site but in the same team. It is live at https://adventure-access-bookings.netlify.app. Build settings come from `netlify.toml`; the Astro Netlify adapter turns server routes into Netlify Functions.

- The project is linked to the GitHub repo: every pull request gets a Deploy Preview and production deploys from `main`.
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set on the project. `SUPABASE_SERVICE_ROLE_KEY` is required from milestone 2: add it in Project configuration, Environment variables, with "Contains secret values" ticked, or the build fails. Changing a variable needs a new deploy to take effect.
- The custom domain `book.adventure-access.com` is not attached yet.

Security headers are set in two places that must agree: `src/middleware.ts` for server-rendered pages and `netlify.toml` for static files. A test checks they match.

## Checks

```powershell
npm run check:env
npm run typecheck
npm run lint
npm test
npm run build
npm run check:build
npm run audit
```

CI runs all of these on every pull request.

- `npm test` runs the unit tests and the database tests. The database tests apply every migration to an in-process Postgres (PGlite) and check constraints and row-level security, including that **every table has RLS enabled and forced**. A new table without RLS fails CI. No database or Docker is needed.
- `npm run check:env` fails if any browser-exposed environment variable name appears in the repo.
- `npm run check:build` runs after the build and fails if the local-only staff shortcut reached the built app.
- `npm run audit` fails on high or critical advisories.

## Layout

| Path | What |
|---|---|
| `astro.config.ts` | Astro config and the environment variable schema |
| `netlify.toml` | Netlify build settings and static-file headers |
| `src/pages/` | Routes: the placeholder home page and `/admin` |
| `src/pages/admin/auth/` | Google sign-in start and callback |
| `src/actions/` | Admin form actions. Each one checks the staff role itself |
| `src/layouts/`, `src/components/` | Page shells and form pieces |
| `src/styles/global.css` | Tailwind and the trip-page palette |
| `src/middleware.ts` | Security headers and the staff gate |
| `src/lib/auth/` | Who counts as staff, and resolving the signed-in staff member |
| `src/lib/admin/db.ts` | Admin data access (service role, after the role check) |
| `src/lib/departures/`, `src/lib/policies/`, `src/lib/trips/` | Form parsing and trip feed logic, with tests |
| `src/lib/money.ts`, `src/lib/dates.ts` | Integer-cents and calendar-date helpers |
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
