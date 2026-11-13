# Adventure Access Bookings App

A separate app where each traveler on a trip built for their group registers, sees the itinerary, pays their own share, and hands in their own documents. Money is recorded in Stripe or by staff, people in HubSpot. It replaces YouLi's trip pages, registration, payments and documents, one group trip at a time.

Source brief: Will, Nov 10, 2026. Amendments from the Nov 10 review are marked **(review)**. Reshaped on Nov 12, 2026, after comparing the build with how YouLi is actually used; those changes are marked **(Nov 12)**.

## Context

- Adventure Access runs small-group adventure trips in Ladakh, Nepal, Bhutan and Yunnan.
- **How trips are sold (Nov 12).** The website is the tour library: each tour page describes a general trip with a season and a "starting at" price. A traveler expresses interest, staff reply, and the tour is customized for that group: dates, days, price and payment schedule. Fixed-date departures that strangers book directly are the rare case. Volume is low (four bookings in the last year), so favor simple and correct over scalable.
- Trip pages live in the Astro marketing site (`adventureaccess/website`, Netlify) as JSON files in `src/content/trips/`. That repo is read-only from here. The site stays static and only links to this app.
- This app owns departures, itineraries for a group, bookings, holds, payment records and traveler documents. Stripe is the system of record for card money. HubSpot (portal 244183775) is the system of record for people and the sales pipeline.
- YouLi keeps running in parallel until one full booking season has gone through this app.

## Words

- **Tour**: a general trip in the website's library. The `trips` table.
- **Departure**: one run of a tour with dates, a price and an itinerary. The `departures` table. Usually a **group trip**: private, built for one group, reached by its own link. Sometimes a public fixed-date departure that anyone can book.
- **Booking**: one traveler's own registration on a departure **(Nov 12)**. Each person registers, pays and hands in documents for themselves. A booking can hold more than one traveler only when one person registers and pays for dependents, such as a parent with children.

## Stack

| Piece | Choice | Notes |
|---|---|---|
| App | Astro (server output), TypeScript strict, Tailwind | Astro Actions for forms, endpoints in `src/pages/api` for webhooks and cron, middleware for the staff gate. Pages are plain HTML with no client framework; add an island only where a screen needs it. No client-side secrets. Switched from Next.js on Nov 11, 2026, to match the website and run natively on Netlify |
| Hosting | Netlify, `book.adventure-access.com` | Its own Netlify site, separate from the marketing site, same team. Deploy Preview per PR; production from `main` only. Server routes run as Netlify Functions through `@astrojs/netlify`. Switched from Vercel on Nov 11, 2026 |
| Database | Supabase Postgres | Migrations in `supabase/migrations`; row-level security on every table |
| Files | A restricted Google Shared Drive in the company Workspace **(Will, Nov 12)** | Traveler documents only. The app uploads through a service account and keeps only the file ID. Staff open files in Drive with their own Google sign-in. Sharing outside the company is switched off on the drive |
| Staff login | Supabase Auth, Google sign-in, `@adventure-access.com` only | `staff` allowlist table with roles |
| Payments | Stripe Checkout (hosted), webhooks; offline payments recorded by staff **(Nov 12)** | The webhook is the only thing that marks card money as paid |
| CRM | HubSpot private app token, CRM v3 API | Contacts, deals, associations |
| Email | Resend (default) | Transactional only; marketing stays in HubSpot |
| Jobs | Netlify Scheduled Functions hitting protected routes | Hold cleanup and the `sync_jobs` worker **(review)**. Functions live in `netlify/functions` and call the app's routes with the shared secret header |
| Validation | Zod on every input | Shared schemas for forms and API. Import `z` from `astro/zod` so Actions and schemas share one copy |
| Tests | Vitest for logic, Playwright for the booking flow | Stripe test mode, Stripe CLI for webhooks. `npm run test:race` and `npm run test:e2e` need the dev database and run locally, not in CI |

## How a booking moves (Nov 12)

1. A traveler reads a tour on the website and expresses interest. That is a HubSpot form on the tour page, not this app.
2. Staff build a departure for the group from the tour: dates, price per person, deposit, payment schedule, card fee, extra questions, required documents, and the itinerary, copied from the tour and edited for this group.
3. Staff send the group its private link, `book.adventure-access.com/<trip-slug>/<departure-id>?key=<token>`. The page shows their itinerary, price and payment schedule.
4. Each traveler opens the link and registers themselves: their details, the extra questions, the policy. The server validates it, then creates their pending booking and a seat hold (30 minutes) in one transaction. Each gets their own booking page.
5. Each traveler pays their own share. By card: the server creates a Stripe Checkout Session, and the `checkout.session.completed` webhook records the payment. Offline (wire, ACH, check, credit): staff record it in the admin. Either way the booking moves to `deposit_paid`, then `paid_in_full`, and the hold becomes a confirmed seat.
6. Each traveler hands in their own documents on their booking page: proof of travel insurance and the waiver. Staff review them.
7. HubSpot sync and emails go through `sync_jobs`. Failures retry and show in the admin.

A public fixed-date departure follows the same steps from 4, reached from the departure list at `/` instead of a private link.

Tour content comes from a `trips.json` published by the website **(review: this feed does not exist yet; see Open items)**: slug, title, destination, hero image and, from Nov 12, the itinerary to copy. Once copied onto a departure, the itinerary belongs to that departure and is edited here. Departures, prices and capacity live only here.

## Data model

Money is integer cents with a `currency` column (always `usd`). Every table has `id uuid`, `created_at`, `updated_at`. Items marked **(Nov 12)** are not built yet.

- `trips`: slug (matches the website file), title, destination, hero_image_url (absolute), active, itinerary jsonb (the tour's template: a list of items shaped like `itinerary_items`)
- `departures`: trip_id, start_date, end_date, price_cents, deposit_cents, balance_due_date, min_travelers, max_travelers, status (open, full, closed, canceled), visibility (public, private), private_token, policy_version_id, custom_questions jsonb, payment_schedule jsonb (scheduled payments per person between the deposit and the final balance: label, due_date, amount_cents; added Nov 11, 2026). **(Nov 12)** group_name (staff label, e.g. "Hulsey family"), required_documents jsonb. `balance_due_date` is typed in on every departure; there is no default
- `itinerary_items` **(Nov 12)**: departure_id, position, kind (highlight, day), day_label, title, body_md, image_url. The group's own itinerary
- `bookings`: departure_id, reference (e.g. AA-7K3Q), access_token_hash, status (pending, deposit_paid, paid_in_full, canceled, refunded), lead_traveler_id, traveler_count, total_cents, discount_cents, paid_cents, needs_attention, hubspot_deal_id, source
- `booking_adjustments` **(Nov 12)**: booking_id, amount_cents, reason, created_by. Credits and other changes to what a booking owes. `discount_cents` is their sum plus any Stripe promotion discount
- `travelers`: booking_id, first_name, last_name, email (required for the lead only **(review)**), phone, is_lead, answers jsonb, hubspot_contact_id
- `seat_holds`: departure_id, booking_id, seats, expires_at
- `payments`: booking_id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_refund_id, amount_cents, kind (deposit, balance, refund), status. **(Nov 12)** method (card, wire, ach, check, cash, other; a credit is a booking adjustment, not a payment), fee_cents (card fee charged on top; not counted toward the trip), received_on, note, recorded_by, voided_at, void_reason. Card rows are written only by the webhook, refunds included **(review)**; offline rows only by an admin action
- `traveler_documents` **(Nov 12)**: booking_id, traveler_id, kind (insurance, passport), drive_file_id, file_name, status (submitted, accepted, rejected), reviewed_by, reviewed_at, note
- `waiver_versions` and `waiver_acceptances` **(Nov 12)**: the waiver PDF (kept in the database with its SHA-256; it is the company's form, not personal data), versioned and immutable once published like a policy, and each traveler's own acceptance (typed full name, accepted_at, ip, user_agent). A departure points at one with `waiver_version_id`
- `policy_versions`: title, body_md, version, published_at. Immutable once published
- `policy_acceptances`: booking_id, traveler_id, policy_version_id, accepted_at, ip, user_agent
- `staff`: email, role (admin, staff, read_only)
- `settings` **(Nov 12)**: key, value. Holds the system-wide card fee
- `activity_log`: actor, entity, entity_id, action, data jsonb
- `webhook_events`: stripe_event_id (unique), type, processed_at, error
- `sync_jobs`: kind (hubspot, email), payload jsonb, attempts, last_error, next_run_at, booking_id, completed_at, failed_at. Rows are added by database triggers on bookings and traveler_documents, inside the same transaction as the change
- `rate_limits`: key, window_start, count **(review)**

Seats available = max_travelers − confirmed travelers − unexpired holds. Check and insert the hold inside one transaction with `select … for update` on the departure row. Availability never depends on the cleanup cron having run. On a group trip the capacity is the size of the group, and each traveler who registers holds one seat; the same rule applies.

## Payment rules

- The server decides every amount. The browser never sends a price.
- **Same price for everyone on a departure (Will, Nov 12).** No per-person prices or dates. A different arrangement for one traveler is a credit on their booking, or its own departure.
- **Everyone pays for themselves (Will, Nov 12).** Each booking has its own balance, payments and credits. One person paying for dependents registers them on their own booking.
- **Two ways money is recorded (Will, Nov 12).** The Stripe webhook is the only path that marks card money paid or refunded. Offline payments (wire, ACH, check, cash) are recorded by an admin or staff role in the admin: method, amount, date received and a note, logged with who. An offline payment is never deleted; it is voided with a reason. Both paths update `paid_cents` and the booking status through the same code.
- **Card fee (Will, Nov 12).** One percentage for the whole system, typed in by an admin in settings; zero allowed. Not set per departure. A change applies to payments started after it. It is added to card payments only, shown to the traveler as its own line before they pay, sent to Stripe as a second line item, and stored in `fee_cents`. It never counts toward the trip price or `paid_cents`. Will is handling whether and how the surcharge may be charged; build it regardless.
- What a traveler can pay by card: the deposit (`deposit_cents × travelers`) first, then the next scheduled payment or the whole remaining balance. Checkout in payment mode, `customer_creation: always`, booking reference and IDs in metadata.
- Milestone payments (Will, Nov 11, 2026): each departure may set its own schedule of payments between the deposit and the final balance, in `payment_schedule`. Amounts are fixed cents per person; each is due before `balance_due_date`; deposit plus scheduled payments never exceed the price. No automatic charges or reminders.
- Final balance = `total_cents − discount_cents − paid_cents`, due on the departure's `balance_due_date`, which staff set on each departure **(Will, Nov 12)**.
- **Credits (Nov 12).** Staff add an adjustment to a booking with a reason. Coupons, if used, are Stripe promotion codes: read the discount from the completed session, never from the form. **(review, default)** Both reduce what is owed (stored in `discount_cents`); `paid_cents` is what was actually received.
- Refunds: for card payments the admin calls the Stripe API with a reason and logs who and why; the `charge.refunded` webhook writes the `payments` row, so dashboard refunds are captured too **(review)**. An offline refund is recorded by staff like an offline payment. Partial refunds allowed.
- Webhooks: `checkout.session.completed`, `checkout.session.expired`, `payment_intent.payment_failed`, `charge.refunded`, `invoice.paid`. Verify the signature, store the event ID first, skip events already processed.
- A traveler who cancels Checkout and resubmits reuses the same pending booking and hold. Never a second hold **(review)**. The browser remembers the pending booking in an httpOnly cookie; the booking transaction takes it as a resume id.
- A late `checkout.session.completed` for an expired hold still confirms if a seat is free. If not, set `needs_attention` and do not auto-refund.
- Test mode everywhere until Will flips the keys.

## Documents (Nov 12)

- v1 handles three: **proof of travel insurance** and a **passport copy** (files the traveler uploads), and the **waiver**, the Travel Consent and Release of Liability form (signed in the app). Visas and flights are undecided and not built.
- **Passports are required (Will, Nov 12).** Collecting them here replaces sending them by email. A passport copy is only ever a file in the restricted Shared Drive: no passport number, date of birth or other detail from it is typed into or stored in the database.
- **Each traveler handles their own (Will, Nov 12)**, on their own booking page: their uploads, their waiver. A person who registered dependents does it for each of them.
- The waiver is a PDF Will provides, kept as a version that cannot change once published. The traveler opens it and signs in the app: their typed full name, the time, IP and browser are recorded against that version.
- Uploads: PDF, JPG or PNG, 4 MB at most (Netlify cannot take a larger request; larger files would need the browser to upload straight to Drive), type checked on the server from the file's contents.
- **Where files live (Will, Nov 12).** A Google Shared Drive in the company Workspace, restricted to staff, with sharing outside the company switched off. The app uploads through a service account that can only add files to that drive, names each file by booking reference and document kind, and stores only the Drive file ID. Files are never kept in the app's database or on Netlify. Staff open them in Drive with their own Google sign-in; the admin links to them. The traveler sees "received", "accepted" or "rejected", not the file.
- Staff mark each document accepted or rejected with a note. The booking page shows the traveler what is still needed.
- Documents are personal data: never in logs, emails or HubSpot. Only a "documents complete" flag leaves this app.

## Security and privacy (requirements)

- No card data touches our servers. Stripe Checkout only; no Elements in v1.
- Secrets live in Netlify environment variables (set in the UI, never in `netlify.toml`), server-only, marked as secret values. Every variable is declared in the `env.schema` in `astro.config.ts` and read through `astro:env/server`. No variable uses Astro's browser-exposed `PUBLIC_` prefix; CI fails if one appears. `.env.example` has names only.
- RLS on every table. Public routes use server code with narrow queries. The service role is used only in the webhook, cron routes, the booking flow and admin actions after a role check. In the booking flow it only calls purpose-built SQL functions (seat counts, the departure for its booking page, the booking transaction, a traveler's own booking summary), which no public role can execute (milestone 3: seat counts need bookings and holds, which the public role must never read).
- Admin requires Google sign-in with a verified `@adventure-access.com` email present in `staff`. Check the role on the server for every admin action. Recording, voiding and adjusting money needs the admin or staff role, never read_only.
- Booking pages are addressed by reference plus a signed token, never sequential IDs. They show no other traveler's email or phone.
- Document files are private **(Nov 12)**: they go straight to the restricted Shared Drive and are read only by staff signed in to Google. The app never serves a document back to a browser. The service account key is a server-only secret with access to that one drive.
- Zod on every field with length caps. Honeypot plus Cloudflare Turnstile on the booking form. Rate limits on form posts, uploads and webhook-adjacent routes (Postgres-backed).
- Headers: strict CSP (allow Stripe and Turnstile), HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`.
- Passport copies are collected as files in the restricted Shared Drive **(Will, Nov 12)**. No passport numbers, dates of birth, medical or dietary details are typed into or stored in the database.
- Cron and internal routes require a shared secret header.
- Pinned dependency versions, Dependabot on, `npm audit` clean at high and critical before merge.
- Logs never include full emails, phone numbers or tokens.

## Integrations

**HubSpot.** Upsert a contact per traveler by email; never overwrite non-empty fields with blanks. One deal per booking, stages mirror booking status, amount = `total_cents / 100`. Associate the deal with every traveler contact. Deal properties: booking_reference, trip_slug, departure_date, travelers, amount_paid, booking_app_url. All writes go through `sync_jobs` with retries and backoff; never block the traveler. **(review)** Skip the contact for an additional traveler with no email or the same email as another traveler in the booking, and do not mark additional travelers as marketing contacts. List existing pipelines and properties first, reuse what fits, ask before creating any. **(Nov 12)** "Express interest" on the website is a HubSpot form; this app does not take inquiries.

**Website.** Read-only. Two small, separate PRs in the website repo: the feed (`trips.json`, now with each tour's itinerary) and the "Express interest" form on tour pages.

**Stripe.** Will's existing account. No Products; Checkout uses `price_data` built from the departure, plus a second line for the card fee. **(review)** Test webhooks point at one stable staging URL, not per-PR preview URLs.

**Email.** One provider, sending from a verified `adventure-access.com` subdomain with SPF, DKIM and DMARC. Traveler: registered (carries the link to their booking page, sent once), booking confirmed, payment received, and a new link when staff send one. Staff (info@adventure-access.com): new booking, payment received, document handed in, failed sync.

## Design

Match the trip pages (not the rest of the site, which uses Fraunces): Cormorant Garamond headings, Jost body, orange `#E8631A` accents. Plain, specific copy: short sentences, no exclamation marks, no hype. American English everywhere (traveler, canceled, center).

## Milestones

One branch and PR per milestone, each with a preview deploy. Stop after each one for Will's review. Milestones 4 to 8 were re-planned on Nov 12.

1. **Skeleton.** Done.
2. **Staff admin and departures.** Done.
3. **Booking form and holds.** Built; in review. Departure list, form with custom questions, policy acceptance, pending booking plus hold, capacity checks. It already defaults to one traveler per booking; the wording shifts to "register yourself" in milestone 5.
4. **Payments.** Built; in review. The system-wide card fee setting, card payment through Stripe Checkout with the fee, webhook with signature check and idempotency, offline payments and voids, credits, the booking page showing what is paid and owed with a pay button, success and canceled pages, hold cleanup cron, and the final balance date made a required field on every departure. Done when a test-mode card payment including the fee reaches `deposit_paid`, replaying the webhook changes nothing, a tampered amount is impossible, and after staff record a wire and a credit the balance is right.
5. **Group itinerary and roster.** Built; in review. Itinerary on a departure, copied from the tour or from another departure and edited in the admin; group name; the group's page showing itinerary, price and schedule above the registration form; a roster in the admin showing each traveler in the group with what they have paid, what they owe and their documents. Done when Will builds a Ladakh group trip from the library tour, changes two days, the private link shows that group's itinerary, and two people who register separately both appear on the roster.
6. **Documents.** Built; in review, with a local stand-in until the Shared Drive is connected. Each traveler's insurance and passport uploads and signed waiver on their own booking page, staff review, files in the restricted Shared Drive. Done when a traveler uploads insurance and a passport copy and signs the waiver, the files appear in the Shared Drive and nowhere else, staff reject it with a note, and the traveler sees what is still needed.
7. **HubSpot and email.** Built; in review, tested against stand-ins until the HubSpot token and the Resend key exist. Sync queue and worker, contacts, deal, associations, emails, retry from admin. Done when a test booking appears as a deal with all travelers associated, and a forced HubSpot failure retries and then succeeds.
8. **Admin finish and launch prep.** Built; in review. Booking detail, activity log, CSV export, security headers, Turnstile, rate limits, README and runbook. Done when the security checklist is ticked and Will approves going live on one pilot group trip.

Not in v1 (design for, don't build): per-person prices or dates, automatic collection of scheduled payments, reminders, AutoPay, late fees, auto-cancel, visa handling, flight details, waitlists, rooming lists, single supplements, affiliates, multi-currency, a traveler mobile app.

## Open decisions (build with the default, flag it in the PR, keep going)

- Deposit: flat per person, set on each departure.
- Policy version 1 text: start from the website's `/payment-terms-cancellation-policy` page; Will and Brian confirm.
- Card fee: starts at 3%, as YouLi appears to charge today, until Will types the real number into settings.
- Waiver: Will supplies the Travel Consent PDF. Each traveler signs it in the app (typed full name, time, IP). Alternative: download, sign on paper and upload the signed copy.
- Dependents: a person may register and pay for dependents on their own booking, and accepts the policy and waiver for each of them.
- Document storage: a restricted Google Shared Drive, decided Nov 12. Will sets it up before milestone 6.
- Database: one shared Supabase project through testing; a clean project at launch, and the test one is deleted afterward (Will, Nov 13, 2026). Steps are in `docs/runbook.md`.
- Document retention: files stay in the Shared Drive until staff delete them. The admin lists trips that ended more than 30 days ago and still have passport copies.
- Hosting: Netlify (decided Nov 11, 2026). Email: Resend.
- HubSpot pipeline: the portal has one, "Sales Pipeline", with the standard stages. An admin picks the pipeline and a stage per booking status under Sync; nothing is sent until then. Suggested with the existing pipeline: registered, not paid = Contract Sent; deposit paid and paid in full = Closed Won; canceled and refunded = Closed Lost. Creating a "Trip Bookings" pipeline is Will's call.
- HubSpot deal properties: none of the six exist yet. The app sends each only once it exists and never creates one.
- Pilot: one Ladakh Multisport group trip in 2027.
- Custom questions per trip: YouLi asks "Choose your activities" as free text with a PDF. One optional short-answer question per line covers it.
- The public departure list stays, for the rare fixed-date trip.

## Open items (need Will or Brian)

- **Trip feed.** The website has no `trips.json`, and all 14 trips are `visibility: internal`, `status: review`. Needed: a filtered public feed (slug, title, destination, hero image, and the itinerary from each trip's `chapters`) and a rule for which trips appear. Until then itineraries are typed or pasted in the admin.
- **Other documents (Nov 12).** Insurance, passport copies and the waiver are in. Visas and flights are undecided.
- **Waiver PDF.** Will to supply the Travel Consent and Release of Liability form before milestone 6.
- **Google setup for documents (Nov 12).** Will creates the Shared Drive (staff only, external sharing off) and a Google Cloud service account added to it as a contributor, and enters the key in Netlify himself. Do not create either without asking.
- **Document retention (Nov 12).** How long passport copies and insurance files are kept after a trip ends, and who deletes them. See the default under Open decisions.
- **Policy acceptance.** Settled Nov 12: each traveler registers and accepts for themselves. Only someone registering dependents accepts on their behalf, and the checkbox wording says so.
- **Solo travelers.** Website prices are double occupancy and single supplements are out of v1. Default: charge the departure price and show "We will confirm rooming with you."
- **Cron frequency.** Confirm before milestone 4 that the Netlify plan allows a five-minute scheduled function and enough function invocations for it.
- **Bot protection.** Rate limits are in. Turnstile is built but off until Will creates the widget in Cloudflare and enters `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` in Netlify. Keep real departures private until then.

## Working rules

- One milestone per branch and PR. Never push to `main`; Will merges.
- Stripe test mode and a Supabase dev project only. Never touch live Stripe keys or production data.
- Never put real secrets in code, tests, fixtures or commit messages. Will enters keys himself.
- Do not create HubSpot pipelines or properties, Stripe webhooks, DNS records, Google Drive folders or service accounts without asking. List exactly what you would create.
- Write tests alongside features: unit tests for pricing, capacity and status transitions; Playwright for the booking flow; webhook tests with the Stripe CLI.
- Will works on Windows with PowerShell. Give commands that work there.
- Commit messages: imperative sentence case, no prefix tags.
- When a decision is unsettled, use the default, note it in the PR description, and keep going.
