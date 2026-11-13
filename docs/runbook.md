# Runbook

How to launch the bookings app, run it day to day, and what to do when something goes wrong. Written for Will and Brian. Commands are PowerShell.

## Before the pilot trip

Work down this list in order. Nothing here is done by the app or by Claude without being asked: keys are entered by Will in the Netlify UI and never pasted into chat, code or email.

### 1. A clean database

Testing has used one shared Supabase project, "Bookings" (`pvfnlahywytptizpgkwo`). It holds test bookings and throwaway data. At launch, start clean (Will, Nov 13, 2026):

1. Create a new Supabase project for production in the same organization. Pick a region near the travelers (US East).
2. Apply the migrations to it:

```powershell
npx supabase link --project-ref <new-project-ref>
```

```powershell
npx supabase db push --dry-run
```

```powershell
npx supabase db push
```

3. In the new project: Authentication, Providers. Turn Google on with the same OAuth client, and turn Email off. Add `https://book.adventure-access.com/admin/auth/callback` to the redirect URLs, and the new project's callback URL to the Google OAuth client.
4. Add the first staff member by hand in the SQL editor (after that, staff are added the same way; there is no staff screen):

```sql
insert into public.staff (email, role) values ('<your work email>', 'admin');
```

5. In Netlify, change `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to the new project's values and redeploy.
6. Sign in, then: sync or import the tours, set the card fee under Settings, publish the policy, upload and publish the waiver, choose the HubSpot pipeline under Sync.
7. Keep the old project for a month as the test database, then pause or delete it.

### 2. Keys in Netlify

Project configuration, Environment variables, "Contains secret values" ticked for every key. A change needs a new deploy.

| Variable | From | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase, Project settings, API | The production project |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe | Test keys until the last step below |
| `STRIPE_LIVE_MODE` | you | Set to `true` only together with live keys. A live key without it is refused |
| `CRON_SECRET` | you | Any long random string |
| `GOOGLE_SERVICE_ACCOUNT_KEY`, `GOOGLE_DRIVE_FOLDER_ID` | Google Cloud, the Shared Drive | Documents |
| `HUBSPOT_ACCESS_TOKEN` | HubSpot private app | Scopes: contacts read and write, deals read and write |
| `RESEND_API_KEY`, `EMAIL_FROM`, `STAFF_NOTIFY_EMAIL` | Resend | The sending domain must be verified |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare, Turnstile | Add `book.adventure-access.com` as the hostname. Both must be set or the check is off |

### 3. Domain and email

- Attach `book.adventure-access.com` to the Netlify project (Domain management). Netlify shows the one CNAME record to add at the DNS host.
- In Resend, verify a sending subdomain such as `mail.adventure-access.com`. It shows the SPF, DKIM and DMARC records to add.
- After the domain is live, update the Google OAuth client and Supabase redirect URLs to it.

### 4. Stripe

1. Developers, Webhooks, add an endpoint: `https://book.adventure-access.com/api/stripe/webhook`.
2. Events: `checkout.session.completed`, `checkout.session.expired`, `payment_intent.payment_failed`, `charge.refunded`, `invoice.paid`.
3. Put the endpoint's signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Run one test-mode payment end to end (see "Acceptance checks") before switching to live keys.
5. To go live: create the same endpoint in live mode, then set the live secret key, the live signing secret and `STRIPE_LIVE_MODE=true` together, and redeploy.

### 5. Acceptance checks, on the real site

Do these with one private test departure and your own email. Each is a milestone's "done when" that could not be run until the keys existed.

- [ ] **Card payment.** Register, pay the deposit with Stripe test card 4242 4242 4242 4242. The booking shows Deposit paid; the fee is its own line in Stripe. In Stripe, resend the webhook event: nothing changes.
- [ ] **Offline money.** Record a wire and add a credit on the same booking. The balance is right.
- [ ] **Documents.** Upload insurance and a passport copy, sign the waiver. The files are in the Shared Drive, named by booking reference. Reject one with a note; the traveler's page says what is still needed. Delete the test files from the drive.
- [ ] **HubSpot.** The booking is a deal in the chosen pipeline with the traveler linked.
- [ ] **Email.** The traveler gets "registered" with their link; info@ gets the staff notice.
- [ ] **Scheduled functions.** Netlify, Logs, Functions: `sync-jobs` runs every five minutes and `cleanup-holds` hourly, both answering 200.
- [ ] **Bot check.** The registration form shows the Turnstile box and a registration goes through.
- [ ] **Headers.** Open the site with the browser's developer tools on the Console tab and click through registration, payment and the admin. No "Content Security Policy" errors.
- [ ] Cancel the test booking and delete the test departure.

### 6. Go live

- [ ] `docs/security-checklist.md` has no open item you have not accepted.
- [ ] Policy version 1 is confirmed by Will and Brian and published.
- [ ] The pilot departure is private, with its balance date, schedule, itinerary, policy, waiver and required documents set.
- [ ] Live Stripe keys are in (step 4.5), and one small real payment has been made and refunded.
- [ ] Send the group its private link.

## Day to day

**Build a group trip.** Admin, Departures, New. Choose the tour, dates, price, deposit, balance date, payment schedule, group name, policy, waiver, required documents. Open Itinerary and copy it from the tour, then edit. Copy the private link from the departure page and send it.

**Watch a group.** Departures, the departure, Roster: each traveler with what they have paid, what they owe and their documents. "Download this group as CSV" gives the same as a spreadsheet.

**Record money that did not come by card.** Bookings, the booking, Record a payment: method, amount, date received, note. A mistake is voided with a reason, never deleted. A credit is added under Credits with a reason.

**Refund a card payment.** Refund it in the Stripe dashboard. The webhook writes the refund row on the booking. Add a note on the booking saying why.

**Review documents.** Bookings, the booking, Documents. Open the file in Drive, then Accept, or Reject with a note the traveler will see.

**A traveler lost their link.** Bookings, the booking, Send a new link. The old one stops working.

**Add or remove staff.** In the Supabase SQL editor. Roles: `admin` (everything), `staff` (everything except the card fee, the HubSpot pipeline and waivers), `read_only` (look only).

```sql
insert into public.staff (email, role) values ('<their work email>', 'staff');
```

```sql
delete from public.staff where email = '<their work email>';
```

**See who did what.** Admin, Activity. Every staff change and every export is listed with who and when. Each booking also shows its own activity.

**Export.** Bookings, "Download all as CSV". One row per traveler; the money columns are on the first row of each booking so a column can be summed. The file holds names, emails and phone numbers: keep it in the company Drive and delete it when done.

**After a trip.** Passport copies and insurance files stay in the Shared Drive until someone deletes them. The admin overview lists trips that ended more than 30 days ago and still have passport copies. Delete the files in Drive, then mark them deleted on the booking.

## When something goes wrong

**A booking shows "Needs a look".** A card payment arrived for a booking whose hold had run out and the trip was full, or an amount did not match. The money is in Stripe and is not refunded automatically. Decide: make room (raise the group size) or refund in Stripe. Then clear the notice on the booking.

**A traveler paid but the booking still says pending.** Stripe, Developers, Webhooks, the endpoint: look for failed deliveries and press Resend. Replays are safe; an event is only ever applied once. If the deliveries show 400 "signature", `STRIPE_WEBHOOK_SECRET` does not match the endpoint.

**"Failed sync" email, or jobs stopped under Sync.** The row says why (a status code, never personal details). Fix the cause (usually a missing or expired key, or a HubSpot property that does not exist), then press Retry. Jobs retry on their own six times over about a day before stopping.

**Emails are not arriving.** Sync shows whether email is set up and whether jobs are waiting. Check `EMAIL_FROM` uses the verified domain, then Resend's log.

**An upload fails.** Over 4 MB or not a PDF, JPG or PNG: the traveler is told so. Otherwise check the service account is still a member of the Shared Drive and `GOOGLE_DRIVE_FOLDER_ID` is right.

**"Too many tries. Wait ten minutes."** The rate limit. One address may post the registration form 40 times, start 20 payments, upload 30 files and start 20 staff sign-ins in ten minutes. A whole group registering from one office network could reach the registration limit; it clears by itself. The numbers are in `src/lib/rate-limit-rules.ts`.

**The Turnstile box does not load or always fails.** Check the hostname is listed on the Turnstile widget in Cloudflare and both keys are set. To switch the check off in an emergency, remove `TURNSTILE_SECRET_KEY` and redeploy; the honeypot and rate limits still apply.

**A page is blank or half-styled after a change.** Most likely the Content Security Policy blocked something new. The browser console names it. The policy is in `src/lib/security-headers.ts` and must be mirrored in `netlify.toml`; a test checks they match.

**A bad deploy.** Netlify, Deploys, pick the last good one, "Publish deploy". This rolls back code only, not the database.

**A key may have leaked.** Rotate it where it was issued (Stripe, Supabase, HubSpot, Resend, Google Cloud, Cloudflare), put the new value in Netlify, redeploy. For the Supabase service role key or the Google service account key, also look through Activity and the Shared Drive for anything unexpected.

**Personal data went somewhere it should not have.** Stop the cause first (unpublish the deploy, revoke the link with "Send a new link", remove the file). Write down what, whose, when and who could see it. Will decides who must be told.

**The database needs restoring.** Supabase, Database, Backups. Daily backups are kept on the paid plan only; confirm the plan before launch. A restore does not touch Stripe: card money can be rebuilt by resending webhook events from Stripe, offline payments cannot.
