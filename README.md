# Adventure Access Bookings

Takes a traveler from a trip page to a paid deposit, recorded in Stripe and HubSpot. The full brief is in [CLAUDE.md](CLAUDE.md). This README covers running it.

Status: milestone 4 (payments). Travelers register for a departure, see what they owe and pay by card through Stripe, with the card fee shown as its own line. Staff record wires, checks and credits, and set the card fee. Stripe is in test mode. No itinerary pages, documents, HubSpot or email yet.

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

- **Departures:** create, edit and delete. Prices are entered in dollars and stored in cents. The final balance due date is typed in on every departure; there is no default. Each departure can also list up to four scheduled payments between the deposit and the final balance: a name, a due date and an amount per person. They must fall before the final balance date, and with the deposit they cannot add up to more than the price. A private departure gets an unguessable link. A departure with bookings cannot be deleted; cancel it instead.
- **Policies:** a draft can be edited freely. Publishing locks the text for good, in the app and in the database, so there is a permanent record of what each traveler agreed to. Only a published version can be attached to a departure.
- **Trips:** "Sync from website" reads the feed at `TRIPS_FEED_URL` and updates slug, title, destination and hero image. A trip that left the feed is switched off, never deleted. Until the website publishes the feed, the button explains that it is not set up.
- Every change is written to `activity_log` with who made it.

**Trip feed format** (to be published by the website as `trips.json`, listing only trips that are `unlisted` or `public`):

```json
{ "trips": [ { "slug": "ladakh-multisport", "title": "Ladakh Multisport", "destination": "ladakh", "heroImage": "https://adventure-access.com/images/2024/05/Ladakh-hero-image.jpg" } ] }
```

## Booking flow

- **`/`** lists public departures that can be booked: open or full, in the future, on an active trip, with a published policy attached.
- **`/<trip-slug>/<departure-id>`** is the booking form. A private departure also needs `?key=<token>`; the admin shows the full link. The traveler picks the party size, enters names (email and phone for the lead only), answers the departure's extra questions and accepts the policy. The page shows what is due and when, worked out on the server. The browser never sends an amount.
- **Submitting** runs one database transaction: it locks the departure, counts seats, and creates a pending booking, its travelers, the policy acceptance and a 30 minute seat hold, or refuses and writes nothing. Two people going for the last seat are handled one after the other.
- **`/booking/<reference>?t=<token>`** is the traveler's own booking page. It needs both parts; only a hash of the token is stored. It shows no email or phone number.
- **Coming back** and submitting again from the same browser changes the pending booking and reuses its hold. There is never a second hold.
- **Seats left** = capacity, minus travelers on paid bookings, minus live holds on pending bookings. An expired hold stops counting by itself; no cleanup job is needed for that.
- **`/admin/bookings`** lists bookings; each one opens to its travelers, payments and credits.

## Payments

Money reaches a booking in two ways, and both end in the same database function, so the same rules apply.

- **By card.** The traveler picks an option on their booking page: the deposit, the next scheduled payment, or the whole balance. The server works out the amount from the database and the card fee from settings, and sends the traveler to Stripe's page. Only Stripe's webhook (`/api/stripe/webhook`) records the payment. It checks Stripe's signature, stores the event ID before doing anything, and skips an event it has already handled, so a replay changes nothing. It also checks that what Stripe charged equals what the server asked for; if not, nothing is recorded and the event shows on the admin overview.
- **Offline.** In the admin, open a booking and use "Record a payment" for a wire, ACH, check or cash. Each entry keeps who recorded it. A mistake is voided with a reason, never deleted.
- **Credits.** "Credit" on the same page lowers what a booking owes. A credit can be taken back; every entry is kept.
- **Card fee.** One percentage for the whole system, under Settings in the admin. Only an admin can change it. It is added on top of card payments, shown to the traveler before they pay, and never counts toward the trip price.
- **Status.** A booking becomes "deposit paid" once the deposit is in and "paid in full" once nothing is owed. A payment that arrives after a hold ran out still confirms the booking if the seats are free; if they are gone, the money is recorded, the booking stays pending and it is flagged on the admin overview. Nothing is refunded automatically.
- **Refunds** of card payments are made in the Stripe dashboard; they show up on the booking by themselves. Cancel a booking from its admin page to free its seats.

**Switching card payments on (test mode)**

1. In the Stripe dashboard, with **Test mode** on, copy the secret key (it starts with `sk_test_`) into `STRIPE_SECRET_KEY`: in `.env.local` for your machine, and in Netlify, marked secret, for the deployed site.
2. For your machine, install the Stripe CLI and run `stripe listen --forward-to localhost:4321/api/stripe/webhook`. It prints a signing secret starting with `whsec_`; put it in `STRIPE_WEBHOOK_SECRET` and restart `npm run dev`.
3. For the deployed site, add a webhook endpoint in Stripe pointing at `https://<site>/api/stripe/webhook` for these events: `checkout.session.completed`, `checkout.session.expired`, `payment_intent.payment_failed`, `charge.refunded`. Put its signing secret in Netlify as `STRIPE_WEBHOOK_SECRET`.
4. Pay with Stripe's test card `4242 4242 4242 4242`, any future date, any CVC.

A live key is refused unless `STRIPE_LIVE_MODE` is also `true`. Leave that unset until launch. Until the keys are set, the pay button tells the traveler that card payment is not switched on.

**Housekeeping.** `netlify/functions/cleanup-holds.mts` runs hourly and asks the app to delete seat holds that ran out long ago. It needs `CRON_SECRET` set in Netlify to any long random string. Nothing depends on it running: expired holds already count for nothing.

## Apply migrations to the dev project

Migrations live in `supabase/migrations` and run in filename order. The Supabase CLI pushes them straight to the hosted dev project, so Docker is not needed.

```powershell
npx supabase login
npx supabase link --project-ref pvfnlahywytptizpgkwo
npx supabase db push --dry-run
npx supabase db push
```

`--dry-run` lists what would be applied. Read it before the real push, and check the project ref is the dev project. To add a migration, run `npx supabase migration new <name>` and fill in the file it creates; do not edit one that has been applied.

The dev project is "Bookings" (ref `pvfnlahywytptizpgkwo`). The ten migrations in this folder are already applied there, and the filenames match the versions recorded in the database, so `db push` only sends new ones.

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

Two more checks need the dev database, so they run locally, not in CI:

```powershell
npm run test:race
npm run test:e2e
```

- `npm run test:race` fires 20 bookings at once at a departure with one seat, on the real database, and fails unless exactly one gets a hold. It proves the row lock; the in-process test database cannot, because it runs one statement at a time.
- `npm run test:e2e` drives the booking form in a real browser (Playwright). First time only: `npx playwright install chromium`.
- Both create private throwaway departures and delete them afterward. Both need at least one published policy version.

To exercise the webhook without the Stripe CLI, `node scripts/fake-stripe-event.mjs <reference> <amount_cents> <fee_cents>` sends the local dev server an event signed with your `STRIPE_WEBHOOK_SECRET`, exactly as Stripe would. Add `--bad-signature`, `--charged=<cents>` or a repeated `--event=<id>` to see it refused or skipped. It only talks to localhost.

- `npm test` runs the unit tests and the database tests. The database tests apply every migration to an in-process Postgres (PGlite) and check constraints and row-level security, including that **every table has RLS enabled and forced**. A new table without RLS fails CI. No database or Docker is needed.
- `npm run check:env` fails if any browser-exposed environment variable name appears in the repo.
- `npm run check:build` runs after the build and fails if the local-only staff shortcut reached the built app.
- `npm run audit` fails on high or critical advisories.

## Layout

| Path | What |
|---|---|
| `astro.config.ts` | Astro config and the environment variable schema |
| `netlify.toml` | Netlify build settings and static-file headers |
| `src/pages/` | Routes: the departure list, the booking form (`[trip]/[departure]`), the traveler's booking page (`booking/[reference]`) and `/admin` |
| `src/pages/admin/auth/` | Google sign-in start and callback |
| `src/actions/` | Form actions: the public booking form, and the admin actions, each of which checks the staff role itself |
| `src/layouts/`, `src/components/` | Page shells and form pieces |
| `src/styles/global.css` | Tailwind and the trip-page palette |
| `src/middleware.ts` | Security headers and the staff gate |
| `src/lib/auth/` | Who counts as staff, and resolving the signed-in staff member |
| `src/lib/admin/db.ts` | Admin data access (service role, after the role check) |
| `src/lib/bookings/` | Booking form validation, payment plan, access tokens, and the calls to the booking SQL functions |
| `src/lib/payments/`, `src/lib/stripe/` | What is due, the card fee, the Checkout Session, reading Stripe events, and the calls to the money SQL functions |
| `src/pages/api/` | The Stripe webhook and the cron route |
| `netlify/functions/` | The hourly scheduled function |
| `src/lib/departures/`, `src/lib/policies/`, `src/lib/trips/` | Form parsing and trip feed logic, with tests |
| `src/lib/money.ts`, `src/lib/dates.ts` | Integer-cents and calendar-date helpers |
| `src/lib/schemas/` | Shared Zod building blocks |
| `src/lib/supabase/` | Server clients: anon (RLS applies) and service role (bypasses RLS) |
| `supabase/migrations/` | Schema, constraints, RLS policies and grants |
| `tests/db/` | Database tests and the PGlite harness |
| `tests/e2e/` | Playwright tests for the booking form |
| `scripts/` | CI helper scripts |

## Rules

- One milestone per branch and pull request. Never push to `main`.
- Stripe test mode and the Supabase dev project only.
- No real secrets in code, tests, fixtures or commit messages.
- The service-role client is for the webhook, cron routes, the booking flow (through its SQL functions) and admin actions after a role check. Nowhere else.
- Card money is recorded only by the Stripe webhook. Offline money only by a staff action, with who and why.
- Line endings are LF everywhere (`.gitattributes`). Netlify reads files such as `.nvmrc` as they are, and a Windows line ending breaks the build.
