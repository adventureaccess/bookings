// Loads the website's tours into this app's library: slug, title,
// destination, hero image and a template itinerary for each. A stand-in for
// the trip feed until the website publishes one.
//
// It only READS the website repo. In the database it adds tours that are
// missing and updates the ones that are there; it never deletes a tour and
// never changes whether one is switched on.
//
// Usage:
//   node scripts/import-tours.mjs                 all tours, from ../adventure-access-site
//   node scripts/import-tours.mjs ladakh-multisport zanskar-mountain-biking
//   node scripts/import-tours.mjs --dry-run       show what would change, change nothing
//   WEBSITE_REPO=<path> node scripts/import-tours.mjs
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment or
// .env.local. DEV PROJECT ONLY.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { itineraryFromWebsiteTrip } from "../src/lib/itinerary/items.ts";

const SITE = "https://adventure-access.com";

function readEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

const env = { ...readEnvFile(".env.local"), ...process.env };
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.filter((arg) => !arg.startsWith("--"));
const tripsDir = join(env.WEBSITE_REPO ?? join("..", "adventure-access-site"), "src", "content", "trips");

if (!existsSync(tripsDir)) {
  console.error(`No tours found at ${tripsDir}. Set WEBSITE_REPO to the website repo.`);
  process.exit(1);
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in .env.local) first.");
  process.exit(1);
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

const tours = [];
for (const file of readdirSync(tripsDir).filter((name) => name.endsWith(".json")).sort()) {
  const slug = file.replace(/\.json$/, "");
  if (only.length > 0 && !only.includes(slug)) continue;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    console.warn(`Skipping ${file}: not a valid slug.`);
    continue;
  }
  const trip = JSON.parse(readFileSync(join(tripsDir, file), "utf8"));
  const title = text(trip.title);
  const destination = text(trip.destination);
  if (!title || !destination) {
    console.warn(`Skipping ${file}: no title or destination.`);
    continue;
  }
  const hero = text(trip.hero?.image);
  tours.push({
    slug,
    title,
    destination,
    hero_image_url: hero.startsWith("/") ? `${SITE}${hero}` : /^https:\/\//.test(hero) ? hero : null,
    itinerary: itineraryFromWebsiteTrip(trip, SITE),
  });
}

if (tours.length === 0) {
  console.error("Nothing to import.");
  process.exit(1);
}

const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
console.log(`Database: ${new URL(env.SUPABASE_URL).host}${dryRun ? " (dry run)" : ""}`);

const { data: existing, error: readError } = await db.from("trips").select("slug");
if (readError) {
  console.error(`Could not read the tours (${readError.code}).`);
  process.exit(1);
}
const known = new Set(existing.map((row) => row.slug));

let failed = false;
for (const tour of tours) {
  const days = tour.itinerary.filter((item) => item.kind === "day").length;
  const highlights = tour.itinerary.length - days;
  const action = known.has(tour.slug) ? "update" : "add";
  console.log(`${action.padEnd(6)} ${tour.slug}: ${days} day items, ${highlights} highlights`);
  if (dryRun) continue;

  // New tours start switched on; existing ones keep their setting.
  const { error } = known.has(tour.slug)
    ? await db.from("trips").update(tour).eq("slug", tour.slug)
    : await db.from("trips").insert({ ...tour, active: true });
  if (error) {
    failed = true;
    console.error(`  failed (${error.code})`);
  }
}

console.log(failed ? "Finished with errors." : dryRun ? "Dry run: nothing changed." : "Done.");
// Set the exit code and let Node finish by itself; exiting abruptly while
// connections are closing trips an assertion on Windows.
process.exitCode = failed ? 1 : 0;
