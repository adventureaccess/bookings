# Milestone 5: Group itinerary and roster

Done when: Will builds a Ladakh group trip from the library tour, changes two days, the private link shows that group's itinerary, and two people who register separately both appear on the roster.

Stacked on #13 (milestone 4). Merge that first.

## What is here

- **Tour templates.** Each tour in the library can carry a template itinerary: days and highlights. Ladakh Multisport's is loaded from the website repo.
- **Itinerary editor** on each departure: copy from the tour or from another departure, then edit, add, remove and reorder items. An itinerary belongs to its departure; changing it touches nothing else.
- **Group name** on a departure, a label only staff see.
- **The group's page.** The private link now shows the itinerary, then price and payment schedule, then the registration form, with a button at the top that jumps to the form.
- **Register yourself.** The form's wording now says each person registers themselves, and adds others only if they are paying for them.
- **Roster** per departure: every registration with its status, paid and owed, and totals for the group.
- **Shared computers.** Two people registering one after the other in the same browser each get their own booking. Before this, the second would have overwritten the first. Submitting again with the same email still changes that person's own pending booking.
- **Trip feed** accepts an optional itinerary per tour, for when the website publishes it.
- `scripts/import-tours.mjs` loads tours and their itineraries from the website repo. It only reads that repo.
- One new migration (one table, two columns, one function, and the booking page function now returns the itinerary), already applied to the dev project.

## Verified

- **The acceptance scenario, in the browser as staff, on the dev database:** created a private Ladakh Multisport departure for "Test family"; copied the tour's 8 items; changed two days and moved one; opened the private link and saw the changed days, the highlights and the photos, with the staff label absent; registered two people separately; both appeared on the roster owing $8,589 each.
- **Database tests, 9 new:** replacing an itinerary, order, bad input leaving the old one in place, private departures needing their key, and that no public or signed-in role can read or change the table or call the function.
- **Playwright, 9 tests (2 new):** the group sees its itinerary above the form and the top button reaches it; two people on one computer get two bookings and two holds.
- 214 unit and database tests (was 193), the last-seat race on the real database, typecheck, lint, build, build check and audit pass.
- The import ran as a dry run for all 14 website tours and for real on Ladakh Multisport.

## Not verified

- On Netlify or the Deploy Preview.
- The trip feed carrying an itinerary: unit-tested, but the website publishes no feed yet.
- A real Stripe payment is still untested (from milestone 4).

## Decisions and defaults to review

1. **Only Ladakh Multisport's itinerary is loaded.** The other 13 website tours are marked internal and in review, so I left them for Will: `node scripts/import-tours.mjs` loads them all.
2. **A website chapter becomes one item** ("Days 1–2", its paragraphs, then a line per day). Highlights become highlight items. The site's "day types" and route strip are not copied.
3. **Photos are addresses, not uploads.** An item holds an `https://` address, normally an image already on adventure-access.com.
4. **Itinerary text is plain text** with blank lines between paragraphs and "- " for list lines, the same as policy text.
5. **Copying replaces the whole itinerary**, with a warning. There is no undo.
6. **The same person is recognized by email** when deciding whether a second submission changes a pending booking or makes a new one.
7. **The roster's Documents column** says "Not collected yet" until milestone 6.
8. **The public departure list** is unchanged.

## Tooling changes forced by Windows

Windows application control began blocking two unsigned files on Will's machine during this work. No Windows setting was changed.

- A native file Astro uses was blocked, stopping the dev server, typecheck and build. The library's own WebAssembly version is installed locally instead (not saved to `package.json` or the lockfile). The README has the one command to rerun after `npm ci`.
- Playwright's downloaded browser was blocked. The browser tests now use the installed Microsoft Edge on Windows.

Netlify and CI run on Linux and are not affected.

## Left in the dev database

- Ladakh Multisport now has its template itinerary (8 items).
- Nothing else new. The test departure, its bookings and the temporary policy were removed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
