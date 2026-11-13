# Adventure Access Bookings

Takes a traveler from a trip page to a paid deposit, recorded in Stripe and HubSpot. The full brief is in [CLAUDE.md](CLAUDE.md). This README covers running it.

Status: milestone 5 (group itinerary and roster). Staff build a trip for a group from a tour in the library, edit its itinerary and send the group a private link. Each traveler sees the itinerary there, registers themselves and pays. Each traveler also hands in their insurance proof and passport copy and signs the waiver there, and staff review them. Staff see a roster per trip. Each booking is queued for HubSpot and for emails to the traveler and staff. Stripe is in test mode, and Google Drive, HubSpot and email are not connected yet.

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

## Group trips

The normal case is a trip built for one group.

1. **Create the departure** in the admin: choose the tour, give it a group name (a label only staff see), dates, price, deposit, the final balance date and any scheduled payments. Set "Who can see it" to "Private link only".
2. **Open Itinerary** on the departure. "Copy from the tour" brings in the tour's itinerary from the library; "from another departure" copies one you already edited. Then change it for this group: edit, add, remove or reorder days and highlights. It belongs to this departure only.
3. **Send the booking link** shown on the departure page. The group sees its itinerary, price and payment schedule, then the registration form.
4. **Each traveler registers themselves** and gets their own booking page, where they pay. Someone booking and paying for dependents, such as their children, adds them to their own registration.
5. **Open Roster** on the departure to see everyone who registered, what each has paid and what each owes.

Two people registering one after the other on the same computer each get their own booking. Submitting again with the same email changes that person's pending booking instead.

**The tour library.** Each tour carries a template itinerary. Until the website publishes its feed, load tours from the website repo on your machine:

```powershell
node scripts/import-tours.mjs --dry-run
node scripts/import-tours.mjs ladakh-multisport
node scripts/import-tours.mjs
```

The first shows what would change, the second loads one tour, the third loads all of them. It reads `..\adventure-access-site` (set `WEBSITE_REPO` for another place), adds tours that are missing and updates the rest. It never deletes a tour or switches one on or off. Ladakh Multisport is already loaded.

## Documents

Each traveler handles their own, on their own booking page.

- **What is asked for** is set on the departure: proof of travel insurance, a passport copy, and which waiver to sign. A new departure asks for both files.
- **Uploads** must be a PDF, JPG or PNG of up to 4 MB. The type is decided from the file's contents, not its name. The limit is Netlify's: a request there cannot be much larger.
- **Where files go.** Straight to one restricted Google Shared Drive, named by booking, traveler and kind (`AA-7K3Q_Norbu-Tenzin_passport_2026-11-12.pdf`). The database keeps only the Drive file ID. Nothing read from a passport is stored. The traveler sees "received", "accepted" or "send it again", never the file.
- **Review.** Open a booking in the admin: each file has an "Open in Drive" link, Accept, and Reject with a note the traveler sees. The roster shows a count per booking.
- **The waiver** is a PDF an admin uploads under Waivers. It starts as a draft; publishing locks it for good. Attach a published version to a departure. Each traveler opens the PDF and signs by typing their full name; the name, time, IP and browser are recorded against that exact version. Someone who registered dependents signs once for each.
- **Clearing out.** The admin overview lists trips that ended more than 30 days ago and still have passport copies. Delete the files in the Shared Drive, then use "File deleted from Drive" on the booking to record it. The app never deletes a file itself.

**Connecting Google Drive (one time)**

1. In Google Drive, create a Shared Drive for traveler documents. Add only staff as members. In its settings, turn off sharing with people outside the company.
2. In Google Cloud Console, in the same project as the sign-in client, enable the Google Drive API. Under IAM, Service accounts, create a service account, then create a JSON key for it and download the file.
3. Add the service account's email address to the Shared Drive as a **Contributor**. That is the only place it has access to.
4. In Netlify, set `GOOGLE_SERVICE_ACCOUNT_KEY` to the whole contents of the JSON key file, marked secret, and `GOOGLE_DRIVE_FOLDER_ID` to the Shared Drive's ID (the last part of its address in the browser). Put the same two in `.env.local` to try it on your machine. Then delete the downloaded key file.

Until those are set, a deployed site tells travelers that uploads are not switched on. On a developer's machine, uploads go to a `.local-documents` folder instead, so the flow can be tried without Drive; that stand-in is stripped from every build and `npm run check:build` fails if it survives.

## HubSpot and email

Nothing is sent to HubSpot or by email while a traveler waits. A change to a booking adds a job to a queue in the same database transaction, and a worker sends it a few minutes later.

- **What queues a job.** A new registration, money arriving, a place being confirmed, a credit, a void, a cancellation, and a document being handed in. Database triggers do this, so no code path can forget.
- **HubSpot.** Each traveler with their own email becomes a contact, found by email. On a contact that already exists, only empty fields are filled; nothing staff entered is overwritten, and no marketing status is set. Each booking becomes one deal, linked to those contacts, in the pipeline and stage chosen under Sync in the admin. The deal amount is the total less credits.
- **Deal properties.** The app fills `booking_reference`, `trip_slug`, `departure_date`, `travelers`, `amount_paid` and `booking_app_url` when they exist in HubSpot. It never creates them. Sync lists the ones that are missing, with the type to create.
- **Emails.** To the traveler: registered (with the link to their booking page), place confirmed, payment received. To staff: new registration, payment received, document to review, and a notice when a job has stopped retrying. Plain text. No email carries a document or anything from one.
- **The booking link.** It is emailed once, at registration, and then removed from the queue: only a hash of the traveler's token is kept. If a traveler loses the link, "Send a new link" on the booking emails a fresh one, and the old one stops working.
- **Retries.** A failed job waits 2 minutes, then 10, 30, 2 hours, 6 hours and 12 hours. After six tries it stops, staff get an email, and it shows under Sync with its error and a Retry button.
- **Not set up yet?** Jobs simply wait, without using up tries, and go out once the keys are in.

**Switching HubSpot on**

1. In HubSpot, Settings, Integrations, Private Apps: create a private app with these scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.schemas.deals.read`. Copy its access token.
2. Put the token in Netlify as `HUBSPOT_ACCESS_TOKEN`, marked secret (and in `.env.local` to try it locally).
3. In the admin, open Sync and choose the pipeline and a stage for each booking status. Nothing is sent until this is saved.
4. Optional: create the six deal properties that Sync lists as missing.

**Switching email on**

1. In Resend, add and verify a sending domain, such as `mail.adventure-access.com`. Resend lists the DNS records to add; add them where the domain's DNS is managed.
2. Create an API key and put it in Netlify as `RESEND_API_KEY`, marked secret.
3. Set `EMAIL_FROM` in Netlify, for example `Adventure Access <bookings@mail.adventure-access.com>`. Staff notices go to `info@adventure-access.com` unless `STAFF_NOTIFY_EMAIL` says otherwise.

The worker runs every five minutes from `netlify/functions/sync-jobs.mts` and needs `CRON_SECRET`, the same one the hold cleanup uses. "Run the queue now" under Sync does the same thing on demand.

**One caution while the deployed site shares the dev database.** The browser tests and the race test make real bookings in that database for a few seconds. They delete the queue jobs those bookings create, but if the worker runs in that moment, a test booking could reach HubSpot or the staff inbox. Before adding the HubSpot token or the Resend key to Netlify, give the deployed site its own database, or stop running those tests against the shared one.

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

The dev project is "Bookings" (ref `pvfnlahywytptizpgkwo`). The thirteen migrations in this folder are already applied there, and the filenames match the versions recorded in the database, so `db push` only sends new ones.

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
- `npm run test:e2e` drives the booking form in a real browser (Playwright). On Windows it uses the installed Microsoft Edge; elsewhere run `npx playwright install chromium` once.
- Both create private throwaway departures and delete them afterward. Both need at least one published policy version.

To exercise the webhook without the Stripe CLI, `node scripts/fake-stripe-event.mjs <reference> <amount_cents> <fee_cents>` sends the local dev server an event signed with your `STRIPE_WEBHOOK_SECRET`, exactly as Stripe would. Add `--bad-signature`, `--charged=<cents>` or a repeated `--event=<id>` to see it refused or skipped. It only talks to localhost.

- `npm test` runs the unit tests and the database tests. The database tests apply every migration to an in-process Postgres (PGlite) and check constraints and row-level security, including that **every table has RLS enabled and forced**. A new table without RLS fails CI. No database or Docker is needed.
- `npm run check:env` fails if any browser-exposed environment variable name appears in the repo.
- `npm run check:build` runs after the build and fails if the local-only staff shortcut or the local document folder reached the built app.
- `npm run audit` fails on high or critical advisories.

## If Windows blocks a file

Windows application control (Smart App Control) can block unsigned programs that tools download. Two have been blocked on this machine:

- **A native file Astro uses** (`satteri`). `npm run dev`, `typecheck` and `build` then stop with "An Application Control policy has blocked this file". The library ships a WebAssembly version for this case. Install it after every `npm ci`:

```powershell
npm install --no-save --force @bruits/satteri-wasm32-wasi@0.11.7
```

- **Playwright's own browser.** The browser tests use the installed Microsoft Edge on Windows for that reason.

Neither changes any Windows setting, and neither affects Netlify or CI, which run on Linux.

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
| `src/lib/hubspot/`, `src/lib/email/`, `src/lib/sync/` | The HubSpot client and sync, the email templates and sender, and the queue worker |
| `src/lib/documents/`, `src/lib/drive/` | Upload checks, file naming, the Drive uploader, waivers and document review |
| `src/lib/itinerary/`, `src/lib/admin/itinerary.ts` | Itinerary items, the tour template mapping, and the editor's and roster's data access |
| `src/lib/payments/`, `src/lib/stripe/` | What is due, the card fee, the Checkout Session, reading Stripe events, and the calls to the money SQL functions |
| `src/pages/api/` | The Stripe webhook and the cron route |
| `netlify/functions/` | The scheduled functions: hold cleanup hourly, the sync worker every five minutes |
| `src/lib/departures/`, `src/lib/policies/`, `src/lib/trips/` | Form parsing and trip feed logic, with tests |
| `src/lib/money.ts`, `src/lib/dates.ts` | Integer-cents and calendar-date helpers |
| `src/lib/schemas/` | Shared Zod building blocks |
| `src/lib/supabase/` | Server clients: anon (RLS applies) and service role (bypasses RLS) |
| `supabase/migrations/` | Schema, constraints, RLS policies and grants |
| `tests/db/` | Database tests and the PGlite harness |
| `tests/e2e/` | Playwright tests for the booking form |
| `scripts/` | CI helper scripts, the race test, the tour import and the fake Stripe event sender |

## Rules

- One milestone per branch and pull request. Never push to `main`.
- Stripe test mode and the Supabase dev project only.
- No real secrets in code, tests, fixtures or commit messages.
- The service-role client is for the webhook, cron routes, the booking flow (through its SQL functions) and admin actions after a role check. Nowhere else.
- Card money is recorded only by the Stripe webhook. Offline money only by a staff action, with who and why.
- Line endings are LF everywhere (`.gitattributes`). Netlify reads files such as `.nvmrc` as they are, and a Windows line ending breaks the build.
