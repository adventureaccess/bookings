# Milestone 8: Admin finish and launch prep

Done when: the security checklist is ticked and Will approves going live on one pilot group trip.

This PR targets `main`.

## What is here

- **Rate limits,** kept in Postgres. Per address, per ten minutes: 40 registration posts, 20 payment starts, 30 uploads, 30 waiver signatures, 20 staff sign-in starts, 60 cron calls. Only a hash of the address is stored. Counting and checking are one statement, so two requests at once cannot both slip under. Old counters are cleared by the hourly hold cleanup.
- **Cloudflare Turnstile** on the registration form, verified on the server. It switches on when both keys are set in Netlify; until then the form works as before.
- **Strict security headers.** A Content Security Policy with no inline scripts or styles, plus Permissions-Policy and Cross-Origin-Opener-Policy, on server pages and static files alike. Stylesheets are now always linked, never inlined.
- **CSV export.** All bookings, or one group from its roster. One row per traveler; money on the first row of each booking so a column can be summed. Cells that look like spreadsheet formulas are written as text. Every export is logged.
- **Activity log.** Admin, Activity: every staff change with who and when. Each booking page shows its own.
- **Admin, Settings, "Check the Drive connection".** Signs in as the service account and looks at the folder without adding a file, and says which step fails.
- **Runbook** (`docs/runbook.md`): launch steps, day-to-day tasks, what to do when something goes wrong.
- **Security checklist** (`docs/security-checklist.md`): each requirement in the brief, where it is enforced, how it is checked, and what is still open.
- One new migration (two functions on the existing `rate_limits` table), already applied to the dev project.

## Defaults and decisions to flag

- **Database (Will, Nov 13):** one shared Supabase project through testing, a clean one at launch. Recorded in the brief; the steps are in the runbook.
- **Rate limit numbers** are my defaults. The registration limit is set so a group of ten on one office network, with mistakes, stays under it.
- **If the rate limit table cannot be reached, the request goes through.** A database problem should not lock travelers out; the other checks still apply.
- **The policy is off in local development,** because the dev server injects inline scripts. It is checked on the Deploy Preview instead.
- **Staff are still added in the Supabase SQL editor.** The brief does not ask for a staff screen; the runbook has the two statements.
- **The repository is public.** Nothing secret is in it, but it should probably be private before launch. Will's call.

## Verified

- **Database tests, 8 new:** a caller is allowed up to the limit and refused after, a new window starts fresh, scopes and callers do not share counters, bad arguments are refused, old counters are cleared, and no public or signed-in role can call either function or read the table.
- **Unit tests:** the headers in code match `netlify.toml`; the policy has each directive and no `unsafe-inline`; rate limit keys never contain the address; Turnstile refuses a missing token, a failed check, a bad reply and an unreachable Cloudflare; CSV quoting, the formula guard, one row per traveler, money on one row only.
- **In the dev database after applying:** neither new function can be run by `anon` or `authenticated`; the security advisor shows only the leaked-password notice, which does not apply to Google-only sign-in.
- **A production build** has no inline styles or scripts from the app's own pages.
- Typecheck, lint, all tests, build, `check:build`, `check:env` and audit pass.

## Checked on the Deploy Preview

- **Headers:** all seven are served on server pages. The app's own pages raise no policy violations in the browser; the only two console errors are Netlify's preview toolbar being blocked, which production does not have.
- **Rate limit:** 23 staff sign-in starts from one address; 20 went through, 3 were refused.
- **The export and activity pages** send a signed-out visitor to sign-in.

## Found while checking

- **A real Drive upload failed.** A test registration worked; uploading a test PDF was refused by Google and nothing was saved. The app's log line is not readable from outside Netlify, so I added the connection check above to name the step.
- **The scheduled functions run but answer 500:** "URL or CRON_SECRET is not set". The secret is not reaching them.

## Not verified yet

- The signed-in admin pages under the policy (they need a staff sign-in).
- Turnstile against Cloudflare: needs the keys.
- Everything listed under "Acceptance checks" in the runbook: a real Stripe test payment, a real Drive upload, HubSpot, email, the scheduled functions.

## For Will

1. Create a Turnstile widget in Cloudflare and enter `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` in Netlify.
2. Read `docs/security-checklist.md`; the open boxes are yours or need your keys.
3. Read `docs/runbook.md`, "Before the pilot trip".
