# Milestone 7: HubSpot and email

Done when: a test booking appears as a deal with all travelers associated, and a forced HubSpot failure retries and then succeeds.

This PR goes straight to `main` and carries milestones 5 and 6 with it, because #15 is not merged yet. Merging this one alone brings `main` fully up to date; #15 will then show as merged too. Stacked pull requests have twice left work stranded off `main`, so each one now targets `main`.

## What is here

- **A queue, filled by the database.** Triggers on bookings and documents add a job in the same transaction as the change: a new registration, money arriving, a place confirmed, a credit, a void, a cancellation, a document handed in. No code path can forget to queue.
- **A worker** that takes jobs one at a time, every five minutes from a Netlify scheduled function, or on demand from the admin. A failure waits 2 minutes, then 10, 30, 2 hours, 6 hours, 12 hours; after six tries the job stops and staff are emailed once.
- **HubSpot sync.** A contact per traveler with their own email, found by email; only empty fields are filled on an existing contact, and no marketing status is set. One deal per booking, linked to those contacts, in the pipeline and stage chosen in the admin. Amount is the total less credits.
- **Emails,** plain text. Traveler: registered (with the booking link), place confirmed, payment received, new link. Staff: new registration, payment received, document to review, sync failed.
- **Admin: Sync.** What is set up, what is waiting, what stopped and why, Retry, "Run the queue now", the HubSpot pipeline and stage choices, and the deal properties HubSpot is missing.
- **Admin: "Send a new link"** on a booking, for a traveler who lost theirs. The old link stops working.
- One new migration (three columns on `sync_jobs`, three triggers, six functions), already applied to the dev project.

## What I found in HubSpot (read only)

- One deal pipeline, "Sales Pipeline", with the standard seven stages.
- None of the six booking deal properties exist.

I created nothing in HubSpot. The app sends a custom property only once it exists, and Sync lists the missing ones with the type to create.

## Verified

- **The acceptance scenario, against a stand-in HubSpot, with the real queue and the real worker** (`tests/db/sync-worker.test.ts`): a booking of three became one deal with the two travelers who have emails linked to it, and the one without an email skipped; a HubSpot that failed twice was retried and succeeded on the third try with one deal and no doubled contacts; a later payment moved the same deal to its new stage and amount; a job that failed six times stopped, emailed staff once, and went through after a staff retry.
- **The booking link** is emailed once and then gone from the stored job; a search of the whole queue for the token finds nothing.
- **Database tests, 21 new:** exactly which changes queue which jobs, one HubSpot job however many changes pile up, no receipt for a void, no job from writing the deal ID back, the retry delays, giving up, and no public or signed-in role able to touch the queue.
- **Unit tests:** contact rules (lead first, duplicates and blanks skipped, only empty fields filled), deal properties and stage mapping, missing properties left out and reported, error messages that carry a status and never a name or email, every email template, and the Resend request.
- **In the browser:** a registration queued three jobs (HubSpot update, staff notice, traveler email with the link); Sync showed them waiting and both integrations as not set up; "Run the queue now" left them untouched; "Send a new link" queued the new-link email. The cron route refused a missing and a wrong secret.
- 318 unit and database tests (was 256), 10 Playwright tests (9 ran; the waiver step skips when no waiver is published), the last-seat race, typecheck, lint, build, build check and audit all pass.
- The Supabase security advisor reports nothing for the new functions.

## Not verified

- **Real HubSpot.** There is no private app token, so nothing has been sent to the real portal. This is the acceptance test and stays open until the token exists.
- **Real email.** There is no Resend key or verified sending domain, so no email has been sent.
- The scheduled function on Netlify, and anything on the Deploy Preview.
- Still open from earlier milestones: a real Stripe payment, and a real upload to Google Drive.

## Decisions and defaults to review

1. **Nothing goes to HubSpot until an admin picks the pipeline and stages.** Suggested, using the existing pipeline: registered and not paid = Contract Sent; deposit paid and paid in full = Closed Won; canceled and refunded = Closed Lost.
2. **Jobs wait when an integration is not set up,** without using up tries, and go out once it is.
3. **Traveler emails after registration do not repeat the booking link.** Only a hash of the token is stored, so it cannot be rebuilt. They say "the link in your registration email", and staff can send a new one.
4. **A new registration email is added** beyond the brief's list, because it is the only way the link reaches the traveler by email.
5. **Existing HubSpot contacts keep their names and phone.** The app fills blanks only.
6. **Marketing status is never set** on any contact, lead or otherwise. HubSpot's own default applies.
7. **Emails are plain text.**
8. **The worker runs every five minutes.** That is about 8,600 runs a month.
9. **The deal amount is the total less credits;** the brief said the total, before credits existed.
10. **Staff notices go to info@adventure-access.com** unless `STAFF_NOTIFY_EMAIL` is set.

## One caution

The deployed site and the tests share the dev database. The browser tests and the race test make real bookings there for a few seconds. They now delete the jobs those bookings queue, but if the worker ran in that moment a test booking could reach HubSpot or the staff inbox. Before adding the HubSpot token or the Resend key to Netlify, give the deployed site its own database, or stop running those tests against the shared one.

## Needs Will

- A HubSpot private app token with the five CRM scopes in the README, then the pipeline choice under Sync.
- Whether to create the six deal properties, and whether to keep the Sales Pipeline or make a "Trip Bookings" one.
- A Resend account, a verified sending domain (DNS records), an API key and the from address.
- `CRON_SECRET` in Netlify, if not set yet.

## Left in the dev database

Nothing new. The test departure, its booking, the queued jobs and the temporary policy were removed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
