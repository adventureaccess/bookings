# Milestone 4: Payments

Done when: a test-mode card payment including the fee reaches `deposit_paid`, replaying the webhook changes nothing, a tampered amount is impossible, and after staff record a wire and a credit the balance is right.

This PR also carries the reshaped brief (`CLAUDE.md`). Its own pull request, #12, was merged into the milestone 3 branch after that branch had already gone to `main`, so it never reached `main`.

## What is here

- **Pay by card.** A traveler's booking page shows the trip total, credits, payments and balance, and offers the deposit, the next scheduled payment or the whole balance. The server works out the amount and the card fee and sends them to Stripe Checkout as two lines. The browser only says which option it picked.
- **The Stripe webhook** at `/api/stripe/webhook`: the only path that records card money. Signature check, event ID stored first, already-handled events skipped, one payment row per Checkout Session, and a check that Stripe charged exactly what the server asked for.
- **Offline payments.** Staff record a wire, ACH, check or cash on a booking, with a date and a note. Who recorded it is kept. A mistake is voided with a reason, never deleted.
- **Credits.** Staff add a credit to a booking or take one back. Every entry is kept.
- **Card fee.** One system-wide percentage under Settings, changeable only by an admin. It starts at 3%.
- **Status rules, in one database function** used by both card and offline money: deposit in means `deposit_paid`, nothing owed means `paid_in_full`. A payment after a hold ran out still confirms if the seats are free; if not, the money is recorded and the booking is flagged, with no automatic refund.
- **Admin.** Each booking opens to its travelers, payments and credits. The overview lists bookings whose money and status do not line up, and Stripe events that could not be recorded. Staff can clear a flag and cancel a booking.
- **Final balance date** is now required on every departure, with no default.
- **Hold cleanup.** An hourly Netlify scheduled function calls a route protected by a shared secret.
- Refunds made in Stripe are picked up from `charge.refunded` and shown on the booking.
- One new migration (two tables, new payment columns, ten functions), already applied to the dev project.

## Verified

- **Database tests, 33 new:** card, offline, credits, voids, refunds, the late-payment cases, and that no public or signed-in role can call any money function.
- **The webhook route, on the local server with events signed the way Stripe signs them** (`scripts/fake-stripe-event.mjs`, with a throwaway signing secret):
  - a wrong signature and an unsigned request were refused (400) and nothing was stored;
  - an event where "Stripe" charged 1 cent against a $750 deposit was refused, kept as an error, and nothing was recorded;
  - a $750 deposit plus $22.50 fee moved the booking to `deposit_paid` with one payment row;
  - sending the same event again answered "duplicate" and changed nothing;
  - the same Checkout Session under a new event ID still left one payment row.
- **In the browser, as staff:** recorded a $2,000 wire and a $500 credit on a $4,950 booking and the balance read $2,450. Voided the wire. Changed the card fee to 2.9% and saw it applied; 12% was refused. Cleared a flag and canceled a booking.
- **In the browser, as a traveler:** the booking page showed the balance and both card options with the fee spelled out. With no Stripe key set, the pay button said card payment is not switched on.
- The cron route refused a missing and a wrong secret and ran with the right one.
- 193 unit and database tests (was 130), 7 Playwright tests, the last-seat race on the real database, typecheck, lint, build, build check and audit all pass.
- The Supabase security advisor reports nothing for the new tables and functions.

## Not verified

- **A real Stripe test-mode payment.** There is no Stripe key on this machine or in Netlify, so no Checkout Session has actually been created and no real Stripe event has arrived. Everything up to and after Stripe's own page is tested; the hop through Stripe is not. This is the first half of the acceptance test and stays open until Will adds test keys. Steps are in the README under Payments.
- **The scheduled function on Netlify.** It can only run there.
- **Anything on the Deploy Preview.**

## Decisions and defaults to review

1. **Credits are entries on the booking, not a payment method.** The brief listed "credit" both ways; one place is clearer.
2. **Card options are the deposit, the next scheduled payment, or the whole balance.** Any other amount goes through an offline payment.
3. **A confirmed booking never drops back to pending by itself.** If a void or refund takes it below the deposit it stays "deposit paid" and is flagged for staff, so nobody loses a seat to a correction.
4. **The Stripe session lasts 31 minutes**, Stripe's minimum being 30, and a pending booking's hold is stretched to 33 minutes when payment starts, so a paid session always has its seat.
5. **The booking's access token is never sent to Stripe.** Stripe returns the traveler to a page that finds their booking from their own cookie.
6. **A live Stripe key is refused** unless `STRIPE_LIVE_MODE` is true.
7. **No refund button in the admin.** Card refunds are made in Stripe and appear here by themselves. An offline refund is not built yet.
8. **Cancel and "clear this notice"** were not in the milestone; added because a flagged booking otherwise has no way out.
9. **Hold cleanup runs hourly**, not every five minutes, which avoids the Netlify plan question. Nothing depends on it.
10. **No promotion codes yet.** Checkout does not offer them; credits cover the cases seen in YouLi.
11. **`stripe` added** as a dependency.

## Needs Will

- Stripe test keys, locally and in Netlify, and a test webhook endpoint for the deployed site (listed in the README; I did not create one).
- `CRON_SECRET` in Netlify, any long random string.
- The real card fee, typed into Settings.

## Left in the dev database

Nothing new. All test bookings, payments, events, the test departure and the temporary policy were removed. The card fee is at its starting 3%.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
