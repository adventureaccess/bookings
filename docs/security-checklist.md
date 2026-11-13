# Security checklist

Each requirement from the brief, with where it is enforced and how it is checked. `[x]` means built and checked. `[ ]` means open: it needs a key, a setting or a decision from Will, and says which. Last reviewed with milestone 8, Nov 13, 2026.

## Card data and money

- [x] **No card data touches our servers.** Stripe Checkout only; there is no card field anywhere in the app. `form-action` in the Content Security Policy allows posting only to this site, Stripe Checkout, Supabase and Google sign-in.
- [x] **The server decides every amount.** The pay form sends a booking and a choice (deposit, next payment, balance), never a price. Unit tests in `src/lib/payments`.
- [x] **Only the webhook marks card money paid.** Signature checked, event ID stored first, repeats skipped, and an amount that does not match the session is refused. `src/lib/stripe/events.test.ts`, `tests/db/payments.test.ts`.
- [x] **Offline payments, voids and credits need the admin or staff role** and are logged with who. Never deleted, only voided.
- [x] **A live Stripe key is refused** unless `STRIPE_LIVE_MODE` is `true`.
- [ ] **A real test-mode payment end to end.** Not run: Stripe test keys and the webhook are not set up yet (Will, skipped for now). Runbook, "Acceptance checks".

## Secrets

- [x] **Server-only, declared in the schema.** Every variable is in `env.schema` in `astro.config.ts` and read through `astro:env/server`.
- [x] **No browser-exposed variable names.** `npm run check:env` fails CI if one appears.
- [x] **`.env.example` has names only.** No secret is in code, tests, fixtures or commits.
- [x] **Development shortcuts do not ship.** `npm run check:build` fails if the local staff shortcut or the local document folder reaches the built app.
- [ ] **Every Netlify variable marked "Contains secret values".** Will to confirm in the Netlify UI; it cannot be read from here.

## Database

- [x] **Row-level security enabled and forced on every table.** A database test fails CI for any table without it.
- [x] **No public or signed-in role can read bookings, travelers, payments, documents, the queue or rate limits.** Database tests per table.
- [x] **Server-only SQL functions.** Execute is revoked from public, anon and authenticated, and granted to the service role only, including the two new rate limit functions (checked in the dev database after applying).
- [x] **The service role is used only** in the webhook, cron routes, the booking flow through its SQL functions, and admin code after a role check.
- [x] **Supabase security advisor:** one notice, leaked-password protection, which does not apply because sign-in is Google only.
- [ ] **Email sign-in switched off in Supabase.** Will, in Authentication, Providers.

## Staff access

- [x] **Google sign-in, verified `@adventure-access.com` email, present in `staff`.** Checked in the middleware for everything under `/admin`.
- [x] **The role is checked on the server in every admin action,** not only on the page. The export route checks again.
- [x] **Read-only staff cannot change anything.**
- [x] **Every staff change is in the activity log,** now visible under Admin, Activity. Exports are logged too.

## Travelers

- [x] **Booking pages are addressed by reference plus a token.** Only a hash of the token is stored. No sequential IDs.
- [x] **A booking page shows no other traveler's email or phone.**
- [x] **The booking link is emailed once and then removed from the stored job.**
- [x] **Zod on every field with length caps.**
- [x] **Honeypot on the registration form.**
- [x] **Turnstile on the registration form, checked on the server.** Built and unit tested against a stand-in. A request with no token, a bad token or an unreachable Cloudflare is refused.
- [ ] **Turnstile switched on.** Needs `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` from Will's Cloudflare account. Until both are set the check is off; keep real departures private.
- [x] **Rate limits, Postgres-backed,** on the registration form, starting a payment, uploads, signing the waiver, starting staff sign-in and the cron routes. The key is a hash of the address, never the address. Counting and checking are one statement. `tests/db/rate-limit.test.ts`.
- [ ] **Rate limits seen working on the deployed site.** They are off in local development. To be checked on the Deploy Preview.

## Documents

- [x] **Files go to the restricted Shared Drive and nowhere else.** The database holds only the Drive file ID. The app never serves a file back.
- [x] **Type checked from the file's contents,** 4 MB cap, PDF, JPG or PNG only.
- [x] **No passport number, date of birth, medical or dietary detail has a field or a column.**
- [x] **Documents are never in logs, emails or HubSpot.** Emails say only that a document was handed in.
- [ ] **A real upload to the Shared Drive.** Tested against a local stand-in only. The keys are now in Netlify; to be run on the deployed site.
- [ ] **The drive is staff only with outside sharing off, and the service account can only add files.** Will to confirm in Google.
- [ ] **Retention.** How long files are kept after a trip, and who deletes them. Default: staff delete; the admin lists trips over 30 days past.

## Headers

- [x] **Strict Content Security Policy.** No inline scripts or styles; scripts only from this site and Cloudflare Turnstile; frames only Turnstile; `frame-ancestors 'none'`; `object-src 'none'`. A production build was searched for inline styles and scripts from the app's pages: none.
- [x] **HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, Permissions-Policy, Cross-Origin-Opener-Policy.**
- [x] **Same headers on server pages and static files.** A test compares `src/lib/security-headers.ts` with `netlify.toml`.
- [x] **Cross-site form posts refused** (`checkOrigin`).
- [ ] **No policy violations in a real browser.** The policy is not applied in local development, so this is checked on the Deploy Preview.

## Jobs, logs and dependencies

- [x] **Cron routes require the shared secret header** and refuse a missing or wrong one.
- [x] **Logs never include full emails, phone numbers or tokens.** Database errors log the code only; HubSpot and email errors carry a status only (unit tested).
- [x] **The CSV export cannot run formulas.** Cells starting with `=`, `+`, `-` or `@` are written as text. Unit tested.
- [x] **Pinned dependency versions, Dependabot on, `npm audit` clean at high and critical in CI.**
- [ ] **Scheduled functions seen running on Netlify.** Will to look at the function logs, or tell me to.

## Before real travelers

- [ ] A clean production database (runbook, step 1).
- [ ] Repository visibility decided (it should be private).
- [ ] Policy version 1 confirmed and published.
- [ ] Will approves going live on one pilot group trip.
