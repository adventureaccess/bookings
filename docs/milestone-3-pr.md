# Milestone 3: Booking form and holds

Done when: two concurrent bookings for the last seat produce exactly one hold, proved by a database-level test, with Playwright covering the form.

## What is here

- **Departure list** at `/`. Public departures that can be booked, with seats left. Shows "Bookings open soon." when there are none.
- **Booking form** at `/<trip-slug>/<departure-id>` (`?key=` for a private departure). Party size, names, email and phone for the lead only, the departure's extra questions for each traveler, and policy acceptance. Shows the deposit, scheduled payments and final balance, worked out on the server. The browser never sends an amount.
- **The booking transaction.** One database function locks the departure, counts seats, and creates the pending booking, travelers, policy acceptance (with IP and browser) and a 30 minute seat hold, or refuses and writes nothing.
- **Seat counting.** Seats left = capacity, minus travelers on paid bookings, minus live holds on pending bookings. An expired hold stops counting by itself.
- **Coming back.** Submitting again from the same browser changes the pending booking and reuses its hold. Never a second hold.
- **Traveler's booking page** at `/booking/<reference>?t=<token>`. Needs both parts; only a hash of the token is stored. Shows no email or phone number.
- **Admin: Bookings.** A read-only list with each booking's hold state.
- **A real 404 page.**
- One new migration (five SQL functions, no table changes), already applied to the dev project.

## Verified

- **The last-seat race, on the real dev database** (`npm run test:race`): 20 bookings fired at once at a departure with one seat gave exactly 1 booking and 1 hold, with 19 refused. 12 parties of two fired at once at three seats gave exactly one party held. Run twice, same result.
- **Database tests** (in-process Postgres, 20 new): the rules above, every refusal (closed, full, started, no policy, policy changed, wrong private key, switched-off trip), resubmitting, and that the public and signed-in roles cannot call any booking function.
- **Playwright, 7 tests in a real browser** against the dev database: a party of two books and the database holds exactly what was entered; mistakes show per field with typed values kept and nothing held; resubmitting reuses the booking; the terms can be read; a second visitor who loaded the form before the last seat went is refused and told the departure is full; a private departure and a booking page are 404 without their key or token.
- **By eye,** desktop and phone width: form, held page, departure list, admin bookings list.
- 130 unit and database tests (was 87), typecheck, lint, build, build check and audit pass.
- The Supabase security advisor reports nothing for the new functions.

## Not verified

- **On Netlify.** Everything above ran locally. The Deploy Preview should be checked once: the caller's IP for the acceptance record and the secure cookie only exist there.
- **With the real policy.** No policy version is published yet, so the tests used a temporary published policy, which I removed afterward. Nothing can be booked until version 1 is published and attached to a departure.
- **Playwright and the race test are not in CI.** CI has no database. They run locally with `npm run test:e2e` and `npm run test:race`.

## Before sending travelers here

- **No bot protection beyond a honeypot yet.** Turnstile and rate limits are milestone 6. Until then a script could hold every seat on a public departure for 30 minutes at a time. Keep real departures private, or leave them without a policy, until that lands.
- **No payment.** A held booking simply expires. The held page says so and asks the traveler to write to info@adventure-access.com.

## Decisions and defaults to review

1. **Service role in the booking flow.** The brief limited the service role to the booking transaction. Seat counts need bookings and holds, which the public role must never read, so the booking pages also read through four narrow SQL functions that only the service role can run. CLAUDE.md is updated to say so.
2. **The lead accepts the policy for the whole party** (review default). The checkbox says "for myself and on behalf of everyone in my party". Brian to confirm.
3. **Solo travelers** pay the departure price and see "We will confirm rooming with you" (review default).
4. **At most 10 travelers per booking.** Larger groups book with staff.
5. **Choosing the party size reloads the page** and clears the form, because pages have no client-side script. A small island could make this smoother later.
6. **Extra questions are asked for every traveler**, all optional.
7. **A departure with no policy is not listed and cannot be booked.**
8. **Resubmitting** is recognized by an httpOnly cookie (2 hours). The traveler re-enters details; their hold carries over and restarts at 30 minutes. A private departure's held page has no link back to the form, because the key is not stored with the booking.
9. **Access tokens are random and stored hashed**, so `TOKEN_SIGNING_SECRET` is not used.
10. **Booking references are 4 characters** (about a million combinations), without 0, O, 1 or I.
11. **Expired pending bookings stay in the table.** They hold no seats. The cleanup job is milestone 4.
12. **Admin bookings list** was not in the milestone; added so staff can see holds. Detail, refunds and export stay in milestone 6.
13. **Playwright added** (`@playwright/test`), with Chromium downloaded locally.

## Left in the dev database

Nothing new. All test bookings, test departures and the temporary policy were removed. The placeholder Ladakh departure and the draft policy version 1 are as they were.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
