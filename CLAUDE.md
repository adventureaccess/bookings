# Adventure Access Bookings App

A separate booking app that takes a traveler from a trip page to a paid deposit, recorded in Stripe and HubSpot. It replaces YouLi's registration and payments, one departure at a time. Source brief: Will, Nov 10, 2026. Amendments from the Nov 10 review are marked **(review)**.

## Context

- Adventure Access runs small-group adventure trips in Ladakh, Nepal, Bhutan and Yunnan.
- Trip pages live in the Astro marketing site (`adventureaccess/website`, Netlify) as JSON files in `src/content/trips/`. That repo is read-only from here. The site stays static and only links to this app.
- This app owns departures, bookings, holds and payments records. Stripe is the system of record for money. HubSpot (portal 244183775) is the system of record for people and the sales pipeline.
- YouLi keeps running in parallel until one full booking season has gone through this app.

## Stack

| Piece | Choice | Notes |
|---|---|---|
| App | Astro (server output), TypeScript strict, Tailwind | Astro Actions for forms, endpoints in `src/pages/api` for webhooks and cron, middleware for the staff gate. Pages are plain HTML with no client framework; add an island only where a screen needs it. No client-side secrets. Switched from Next.js on Nov 11, 2026, to match the website and run natively on Netlify |
| Hosting | Netlify, `book.adventure-access.com` | Its own Netlify site, separate from the marketing site, same team. Deploy Preview per PR; production from `main` only. Server routes run as Netlify Functions through `@astrojs/netlify`. Switched from Vercel on Nov 11, 2026 |
| Database | Supabase Postgres | Migrations in `supabase/migrations`; row-level security on every table |
| Staff login | Supabase Auth, Google sign-in, `@adventure-access.com` only | `staff` allowlist table with roles |
| Payments | Stripe Checkout (hosted), webhooks | The webhook is the only thing that marks money as paid |
| CRM | HubSpot private app token, CRM v3 API | Contacts, deals, associations |
| Email | Resend (default) | Transactional only; marketing stays in HubSpot |
| Jobs | Netlify Scheduled Functions hitting protected routes | Hold cleanup and the `sync_jobs` worker **(review)**. Functions live in `netlify/functions` and call the app's routes with the shared secret header |
| Validation | Zod on every input | Shared schemas for forms and API. Import `z` from `astro/zod` so Actions and schemas share one copy |
| Tests | Vitest for logic, Playwright for the booking flow | Stripe test mode, Stripe CLI for webhooks |

## How a booking moves

1. Trip page links to `book.adventure-access.com/<trip-slug>/<departure-id>`.
2. Traveler submits the form. The server validates it, then creates a pending booking and a seat hold (30 minutes) in one transaction.
3. The server creates a Stripe Checkout Session for the deposit and redirects. The session's `expires_at` matches the hold **(review)**.
4. Stripe sends `checkout.session.completed`. The webhook verifies the signature, records the payment, marks the booking `deposit_paid` and turns the hold into a confirmed seat.
5. The webhook enqueues the HubSpot sync and the emails in `sync_jobs`. Failures retry and show in the admin.

Trip content is not copied. The app reads slug, title, destination and hero image from a `trips.json` published by the website **(review: this feed does not exist yet; see Open items)**. Departures, prices and capacity live only here.

## Data model

Money is integer cents with a `currency` column (always `usd`). Every table has `id uuid`, `created_at`, `updated_at`.

- `trips`: slug (matches the website file), title, destination, hero_image_url (absolute), active
- `departures`: trip_id, start_date, end_date, price_cents, deposit_cents, balance_due_date, min_travelers, max_travelers, status (open, full, closed, canceled), visibility (public, private), private_token, policy_version_id, custom_questions jsonb, payment_schedule jsonb (scheduled payments per person between the deposit and the final balance: label, due_date, amount_cents; added Nov 11, 2026)
- `bookings`: departure_id, reference (e.g. AA-7K3Q), access_token_hash, status (pending, deposit_paid, paid_in_full, canceled, refunded), lead_traveler_id, traveler_count, total_cents, discount_cents, paid_cents, needs_attention, hubspot_deal_id, source
- `travelers`: booking_id, first_name, last_name, email (required for the lead only **(review)**), phone, is_lead, answers jsonb, hubspot_contact_id
- `seat_holds`: departure_id, booking_id, seats, expires_at
- `payments`: booking_id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_refund_id, amount_cents, kind (deposit, balance, refund), status. Written only by the webhook, refunds included **(review)**
- `policy_versions`: title, body_md, version, published_at. Immutable once published
- `policy_acceptances`: booking_id, traveler_id, policy_version_id, accepted_at, ip, user_agent
- `staff`: email, role (admin, staff, read_only)
- `activity_log`: actor, entity, entity_id, action, data jsonb
- `webhook_events`: stripe_event_id (unique), type, processed_at, error
- `sync_jobs`: kind (hubspot, email), payload jsonb, attempts, last_error, next_run_at
- `rate_limits`: key, window_start, count **(review)**

Seats available = max_travelers − confirmed travelers − unexpired holds. Check and insert the hold inside one transaction with `select … for update` on the departure row. Availability never depends on the cleanup cron having run.

## Payment rules

- The server decides every amount. The browser never sends a price.
- The Stripe webhook is the only path that marks anything paid or refunded.
- Deposit = `deposit_cents × travelers`, Checkout in payment mode, `customer_creation: always`, booking reference and IDs in metadata.
- Milestone payments (Will, Nov 11, 2026): each departure may set its own schedule of payments between the deposit and the final balance, in `payment_schedule`. Amounts are fixed cents per person; each is due before `balance_due_date`; deposit plus scheduled payments never exceed the price. v1: staff send a Stripe payment link or invoice for each one from the admin. No automatic charges or reminders.
- Final balance = `total_cents − paid_cents`, due on `balance_due_date`. v1: staff send a Stripe payment link or invoice from the admin.
- Coupons are Stripe promotion codes. Read the discount from the completed session, never from the form. **(review, default)** The discount reduces `total_cents` (stored in `discount_cents`); `paid_cents` is what was actually charged.
- Refunds: the admin calls the Stripe API with a reason and logs who and why. The `charge.refunded` webhook writes the `payments` row, so dashboard refunds are captured too **(review)**. Partial refunds allowed.
- Webhooks: `checkout.session.completed`, `checkout.session.expired`, `payment_intent.payment_failed`, `charge.refunded`, `invoice.paid`. Verify the signature, store the event ID first, skip events already processed.
- A traveler who cancels Checkout and resubmits reuses the same pending booking and hold. Never a second hold **(review)**.
- A late `checkout.session.completed` for an expired hold still confirms if a seat is free. If not, set `needs_attention` and do not auto-refund.
- Test mode everywhere until Will flips the keys.

## Security and privacy (requirements)

- No card data touches our servers. Stripe Checkout only; no Elements in v1.
- Secrets live in Netlify environment variables (set in the UI, never in `netlify.toml`), server-only, marked as secret values. Every variable is declared in the `env.schema` in `astro.config.ts` and read through `astro:env/server`. No variable uses Astro's browser-exposed `PUBLIC_` prefix; CI fails if one appears. `.env.example` has names only.
- RLS on every table. Public routes use server code with narrow queries. The service role is used only in the webhook, cron routes, the booking transaction and admin actions after a role check.
- Admin requires Google sign-in with a verified `@adventure-access.com` email present in `staff`. Check the role on the server for every admin action.
- Booking pages are addressed by reference plus a signed token, never sequential IDs. They show no other traveler's email or phone.
- Zod on every field with length caps. Honeypot plus Cloudflare Turnstile on the booking form. Rate limits on form posts and webhook-adjacent routes (Postgres-backed).
- Headers: strict CSP (allow Stripe and Turnstile), HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- No passport numbers, dates of birth, medical or dietary details in v1.
- Cron and internal routes require a shared secret header.
- Pinned dependency versions, Dependabot on, `npm audit` clean at high and critical before merge.
- Logs never include full emails, phone numbers or tokens.

## Integrations

**HubSpot.** Upsert a contact per traveler by email; never overwrite non-empty fields with blanks. One deal per booking, stages mirror booking status, amount = `total_cents / 100`. Associate the deal with every traveler contact. Deal properties: booking_reference, trip_slug, departure_date, travelers, amount_paid, booking_app_url. All writes go through `sync_jobs` with retries and backoff; never block the traveler. **(review)** Skip the contact for an additional traveler with no email or the same email as another traveler in the booking, and do not mark additional travelers as marketing contacts. List existing pipelines and properties first, reuse what fits, ask before creating any.

**Website.** Read-only. The "Book this trip" button is a small, separate PR in the website repo.

**Stripe.** Will's existing account. No Products; Checkout uses `price_data` built from the departure. **(review)** Test webhooks point at one stable staging URL, not per-PR preview URLs.

**Email.** One provider, sending from a verified `adventure-access.com` subdomain with SPF, DKIM and DMARC. Traveler: booking confirmed. Staff (info@adventure-access.com): new booking, failed sync.

## Design

Match the trip pages (not the rest of the site, which uses Fraunces): Cormorant Garamond headings, Jost body, orange `#E8631A` accents. Plain, specific copy: short sentences, no exclamation marks, no hype. American English everywhere (traveler, canceled, center).

## Milestones

One branch and PR per milestone, each with a preview deploy. Stop after each one for Will's review.

1. **Skeleton.** Repo, Astro, Tailwind with fonts and colors, Supabase project, migrations for all tables, RLS, `.env.example`, CI (typecheck, lint, test, audit). Done when CI passes and an empty preview deploys.
2. **Staff admin and departures.** Google sign-in limited to staff, trip sync, departure CRUD, policy versions. Done when Will can sign in, create a Ladakh Multisport departure, and a non-staff Google account is refused.
3. **Booking form and holds.** Departure list, form with custom questions, policy acceptance, pending booking plus hold, capacity checks. Done when two concurrent bookings for the last seat produce exactly one hold (proved by a database-level test, with Playwright covering the form **(review)**).
4. **Stripe deposit.** Checkout session, webhook with signature check and idempotency, success and canceled pages, hold cleanup cron. Done when a test-mode booking reaches `deposit_paid`, replaying the webhook changes nothing, and a tampered amount is impossible.
5. **HubSpot and email.** Sync queue and worker, contacts, deal, associations, emails, retry from admin. Done when a test booking appears as a deal with all travelers associated, and a forced HubSpot failure retries and then succeeds.
6. **Admin finish and launch prep.** Booking detail, balance link, refunds, activity log, CSV export, security headers, Turnstile, rate limits, README and runbook. Done when the security checklist is ticked and Will approves going live on one pilot departure.

Not in v1 (design for, don't build): automatic collection of scheduled payments, reminders, AutoPay, late fees, auto-cancel, traveler portal, document upload, waitlists, rooming lists, single supplements, affiliates, multi-currency.

## Open decisions (build with the default, flag it in the PR, keep going)

- Deposit: flat per person, set on each departure.
- Balance due date: 60 days before departure.
- Policy version 1 text: start from the website's `/payment-terms-cancellation-policy` page; Will and Brian confirm.
- Stripe fees: we absorb, no surcharge.
- Hosting: Netlify (decided Nov 11, 2026). Email: Resend.
- HubSpot pipeline: reuse an existing one or create "Trip Bookings". Ask first.
- Pilot departure: a 2027 Ladakh Multisport date.
- Custom questions per trip: Brian to list what YouLi asks today.

## Open items from the review (need Will or Brian)

- **Trip feed.** The website has no `trips.json`, and all 14 trips are `visibility: internal`, `status: review`. Milestone 2 needs a filtered public feed (slug, title, destination, hero image only) and a rule for which trips appear.
- **Policy acceptance.** Only the lead traveler sees the form. Default: the lead accepts on behalf of the party and the checkbox wording says so. Brian to confirm.
- **Solo travelers.** Website prices are double occupancy and single supplements are out of v1. Default: charge the departure price and show "We will confirm rooming with you."
- **Cron frequency.** Confirm before milestone 4 that the Netlify plan allows a five-minute scheduled function and enough function invocations for it.

## Working rules

- One milestone per branch and PR. Never push to `main`; Will merges.
- Stripe test mode and a Supabase dev project only. Never touch live Stripe keys or production data.
- Never put real secrets in code, tests, fixtures or commit messages. Will enters keys himself.
- Do not create HubSpot pipelines or properties, Stripe webhooks or DNS records without asking. List exactly what you would create.
- Write tests alongside features: unit tests for pricing, capacity and status transitions; Playwright for the booking flow; webhook tests with the Stripe CLI.
- Will works on Windows with PowerShell. Give commands that work there.
- Commit messages: imperative sentence case, no prefix tags.
- When a decision is unsettled, use the default, note it in the PR description, and keep going.
