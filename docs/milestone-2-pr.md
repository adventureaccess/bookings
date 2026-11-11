# Milestone 2: Staff admin and departures

Paste this as the pull request description for `milestone-2-admin`.

Done when: Will can sign in, create a Ladakh Multisport departure, and a non-staff Google account is refused.

## What is here

- **Sign-in.** `/admin` requires Google sign-in through Supabase Auth. To get in, an account must have signed in through Google, have a confirmed `@adventure-access.com` email, and be in the `staff` table. Anyone else who completes Google sign-in is signed straight back out.
- **Roles.** `admin` and `staff` can change departures and policies; `read_only` can view. The role is checked on the server in every action, not only on the page.
- **Departures.** Create, edit, delete. Dollars in, cents stored. Blank balance due date becomes 60 days before departure. Private departures get an unguessable link. A departure with bookings cannot be deleted.
- **Policy versions.** Drafts are editable; publishing locks the text permanently. Only a published version can be attached to a departure.
- **Trips.** "Sync from website" reads a feed and updates the trip list; trips that leave the feed are switched off, never deleted.
- **Activity log.** Every admin change records who made it.
- **Database.** One new migration: staff status now requires that the account was created through Google, so a staff email alone is not enough. Already applied to the dev project.
- 79 tests (was 40): staff rules, dollar parsing, the departure form, the trip feed, and the new database rule.

## Verified

Locally, against the dev database, using the local-only staff shortcut (see below):

- Signed out: every admin page redirects to sign-in; every action answers 401; a cross-site form post is refused (403).
- Created a departure in the browser: validation errors show per field and keep what was typed; a corrected form saves, and the row in the database has the right cents, dates and questions.
- Edited a departure to private (link token created) and back.
- Attaching a draft policy to a departure is refused.
- Policy flow with a throwaway version: create, edit, publish, then edits and a second publish are refused. The throwaway was removed from the dev database afterward.
- Read-only role: pages hide the buttons and disable the fields; all five actions answer 403.
- Trip sync with no feed configured explains that instead of failing.
- Typecheck, lint, 79 tests, build, build check and audit pass.

## Not verified

- **Real Google sign-in.** It needs the Google OAuth client and the Supabase provider settings, which only Will can create. Starting sign-in correctly redirects to Supabase's Google endpoint, but the round trip, and the refusal of a non-staff Google account, have not been exercised. This is the milestone's acceptance test and is still open.
- **Trip sync against a real feed.** The website does not publish `trips.json` yet. The feed parsing and sync planning are unit-tested; the fetch has not run against a live URL.
- The Deploy Preview for this PR will fail until `SUPABASE_SERVICE_ROLE_KEY` is set in Netlify.

## Decisions and defaults to review

1. **Admin data access uses the service role after a server-side role check**, as CLAUDE.md allows, rather than the signed-in user's own database permissions. The row-level security policies for staff remain as a second line of defense.
2. **Local-only staff shortcut.** `DEV_STAFF_EMAIL` in `.env.local` lets the dev server act as a staff member without Google, so the admin can be developed and tested. It is compiled out of every build, and CI fails if it is ever found in the built app. The email must still be in the staff table.
3. **Turn off Supabase's Email provider.** Sign-in should be Google only. The new migration and the app both refuse non-Google accounts, so this is a third layer, but it should still be off.
4. **No staff management screen.** Staff are added with one SQL statement (in the README). A screen can come with milestone 6.
5. **Balance due date conflict.** The default here is 60 days before departure (from the brief). The policy text on the website says full payment is due 30 days before arrival. One of them needs to change before policy version 1 is published.
6. **Policy version 1 is a draft**, copied from the website's payment terms page with formatting changes only (headings, and the cancellation table turned into a list). The link to the PDF version was dropped. Will and Brian to review and publish.
7. **Custom questions** are one optional short-answer question per line. Brian's list of what YouLi asks today may need richer types.
8. **A departure can be open with no policy attached.** The overview flags it. Milestone 3 must refuse bookings on a departure without a policy.
9. **Booking link format** is `/<trip-slug>/<departure-id>`, with `?key=<token>` for private departures. Shown in the admin, but the page arrives in milestone 3.
10. **Trip feed** format and rule (only `unlisted` or `public` trips) are in the README. The website PR to publish it is still to do. Ladakh Multisport was seeded by hand in the dev database.
11. **No Playwright yet.** Google sign-in cannot be automated, and the brief puts Playwright on the booking flow (milestone 3).
12. **Row types are hand-written** (`src/lib/db-types.ts`) for the handful of tables the admin reads, not generated.

## Left in the dev database

- Will as `admin` in `staff`.
- The Ladakh Multisport trip.
- Policy version 1, draft.
- One test departure: Ladakh Multisport, Jul 10 to 22, 2027, $4,950, $750 deposit, 10 seats. The numbers are placeholders; edit or delete it.
- Activity log rows from testing.
