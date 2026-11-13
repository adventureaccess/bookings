# Milestone 6: Documents

Done when: a traveler uploads insurance and a passport copy and signs the waiver, the files appear in the Shared Drive and nowhere else, staff reject it with a note, and the traveler sees what is still needed.

This PR also carries milestone 5 (group itinerary and roster). Its own pull request, #14, was merged into the milestone 4 branch after that branch had already gone to `main`, so it never reached `main`.

## What is here

- **On the traveler's booking page:** a Documents section for each person on the booking. Upload proof of travel insurance and a passport copy; read the waiver PDF and sign it by typing a full name. Each item shows where it stands: needed, received, accepted, or "send it again" with our note.
- **File checks:** PDF, JPG or PNG, decided from the file's contents, not its name. 4 MB at most.
- **Where files go:** straight to a Google Shared Drive through a service account, named by booking, traveler and kind. The database keeps only the Drive file ID. The page never shows the file or where it is.
- **The waiver:** an admin uploads a PDF under Waivers as a draft and publishes it, which locks it for good. A departure points at one published version. A signature records the typed name, time, IP and browser against that exact version. A person who registered dependents signs once for each.
- **Per departure:** which files are required (both, by default) and which waiver.
- **Staff review:** on a booking, each file has an "Open in Drive" link, Accept, and Reject with a note the traveler sees. The roster shows a count per booking, such as "2 of 3 in, 1 to review".
- **Clearing out:** the overview lists trips that ended over 30 days ago and still have passport copies. Staff delete the file in Drive, then record that on the booking.
- One new migration (three tables, two departure columns, four functions), already applied to the dev project.

## Verified

Everything below used the developer stand-in for Drive (a local folder), because the Shared Drive is not set up yet.

- **In the browser, start to finish:** a traveler registered and uploaded a passport PDF; staff saw "To review" on the booking and "0 of 3 in, 1 to review" on the roster; staff rejected it with a note; the traveler's page showed "Please send it again" with the note; the traveler sent a JPG; staff accepted it; the traveler signed the waiver; the roster read "2 of 3 in".
- **Waivers:** uploaded a PDF as a draft, published it, and opened it at its public address as a PDF.
- **Playwright, 10 tests (1 new):** a disguised non-PDF is refused and nothing is recorded; a real PDF is recorded under the app's own file name, not the traveler's; the page never shows the file name; a one-word name is refused as a signature; a full name signs.
- **Database tests, 19 new:** what a booking is asked for, the newest upload counting, another booking's traveler refused, a canceled booking refused, signing only the attached published waiver, one signature per traveler per version, published waivers locked, and no public or signed-in role able to call any function or write any table.
- **Unit tests:** file type detection, the size limit, file naming (path characters stripped), the Drive client's signed token request checked against a real key pair, the upload request's shape, and failures that do not leak Google's response.
- 256 unit and database tests (was 214), the last-seat race, typecheck, lint, build, audit, and the build check, which now also fails if the local document folder reaches a build.
- The Supabase security advisor reports nothing for the new tables and functions.

## Not verified

- **A real upload to Google Drive.** The Shared Drive and service account do not exist yet, so no file has gone to Drive. This is the heart of the acceptance test and stays open. The Drive client is tested against a fake Google; the README has the setup steps.
- On Netlify or the Deploy Preview, including the 4 MB limit there.
- The real waiver: the Travel Consent PDF has not been supplied. Tests used a one-line stand-in PDF, removed afterward.
- A real Stripe payment is still untested (from milestone 4).

## Decisions and defaults to review

1. **4 MB per file, not 10.** Netlify cannot accept a larger request. A phone photo of a passport is usually under that; a scan at high quality may not be. Going higher means the browser uploading straight to Drive, which is a larger piece of work.
2. **The waiver is signed by typing a full name**, first and last, with a checkbox. No drawn signature.
3. **The waiver PDF is stored in the database**, with its SHA-256. It is the company's form, not personal data, and it must be shown to travelers. Anyone with its address can open a published waiver.
4. **A new upload replaces the old one in the count**, but the old row and its file stay, so there is a history.
5. **The service account uses the full Drive scope.** It is a member of one Shared Drive only, so that is all it can reach.
6. **Files sit flat in the Shared Drive**, told apart by name. No folder per trip yet.
7. **The app never deletes a file.** Staff delete in Drive and record it.
8. **Only an admin can upload or publish a waiver.** Staff can review documents.
9. **Changing a departure's waiver** asks everyone on it to sign the new version.
10. **A local stand-in for Drive** exists in the dev server only, so the flow can be built and tested. Every build strips it and CI checks that.
11. Form posts may now be up to 6 MB (`actionBodySizeLimit`), to carry a file.

## Needs Will

- The Shared Drive and the service account, then two values in Netlify. Steps are in the README under "Connecting Google Drive".
- The Travel Consent PDF, uploaded under Waivers.

## Left in the dev database

Nothing new. The test departure, its booking, the uploads and the temporary policy and waivers were removed. The 14 tours in the library were loaded by Will.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
