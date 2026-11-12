// Proves, on a real Postgres, that concurrent bookings cannot oversell a
// departure: many travelers go for the last seat at the same moment and
// exactly one gets a hold.
//
// The unit tests (tests/db/booking.test.ts) run in an in-process database
// that handles one statement at a time, so they cannot exercise the row lock.
// This script can: every request below is its own database transaction.
//
// Usage: npm run test:race
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment or
// .env.local. DEV PROJECT ONLY. It creates two private throwaway departures,
// books against them and deletes everything it created. It needs one
// published policy version to exist.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

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
const url = env.SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in .env.local) first.");
  process.exit(1);
}

const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
console.log(`Database: ${new URL(url).host}`);

const fail = (message) => {
  throw new Error(message);
};

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) fail(`${what} failed (${error.code ?? "unknown"})`);
  return data;
}

function party(size, tag) {
  return Array.from({ length: size }, (_, i) => ({
    first_name: i === 0 ? "Race" : `Guest${i}`,
    last_name: `Test ${tag}`,
    email: i === 0 ? `race-${tag}@example.com` : "",
    phone: i === 0 ? "+1 555 0100" : "",
    is_lead: i === 0,
    answers: {},
  }));
}

async function createDeparture(tripId, policyId, seats) {
  const key = randomBytes(24).toString("base64url");
  const row = await must(
    db
      .from("departures")
      .insert({
        trip_id: tripId,
        start_date: "2099-07-10",
        end_date: "2099-07-22",
        price_cents: 495000,
        deposit_cents: 75000,
        balance_due_date: "2099-05-11",
        max_travelers: seats,
        visibility: "private",
        private_token: key,
        policy_version_id: policyId,
      })
      .select("id")
      .single(),
    "create test departure",
  );
  return { id: row.id, key };
}

async function removeDeparture(id) {
  await must(db.from("bookings").delete().eq("departure_id", id), "delete test bookings");
  await must(db.from("departures").delete().eq("id", id), "delete test departure");
}

/** Fires `attempts` bookings of `size` travelers at once and reports what happened. */
async function race(departure, policyId, attempts, size) {
  const results = await Promise.all(
    Array.from({ length: attempts }, (_, i) =>
      db.rpc("create_booking", {
        p_departure_id: departure.id,
        p_key: departure.key,
        p_policy_version_id: policyId,
        p_travelers: party(size, String(i)),
        p_access_token_hash: randomBytes(32).toString("hex"),
        p_ip: null,
        p_user_agent: "race-last-seat",
        p_source: "race-test",
        p_resume_booking_id: null,
        p_hold_minutes: 5,
      }),
    ),
  );
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) fail(`${errors.length} requests errored (${errors[0].error.code})`);
  const won = results.filter((r) => r.data.ok).length;
  const refused = results.filter((r) => r.data.reason === "not_enough_seats").length;
  const holds = await must(
    db.from("seat_holds").select("seats").eq("departure_id", departure.id),
    "read holds",
  );
  const bookings = await must(
    db.from("bookings").select("id").eq("departure_id", departure.id),
    "read bookings",
  );
  return {
    won,
    refused,
    holds: holds.length,
    heldSeats: holds.reduce((sum, h) => sum + h.seats, 0),
    bookings: bookings.length,
  };
}

const created = [];
let failed = false;
try {
  const trip = await must(
    db.from("trips").select("id").eq("active", true).limit(1).maybeSingle(),
    "find a trip",
  );
  const policy = await must(
    db
      .from("policy_versions")
      .select("id")
      .not("published_at", "is", null)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "find a published policy",
  );
  if (!trip) fail("No active trip. Add one in the admin first.");
  if (!policy) fail("No published policy version. Publish one in the admin first.");

  // 1. Twenty travelers, one seat.
  const lastSeat = await createDeparture(trip.id, policy.id, 1);
  created.push(lastSeat.id);
  const one = await race(lastSeat, policy.id, 20, 1);
  console.log("Last seat, 20 at once:", one);
  if (one.won !== 1 || one.holds !== 1 || one.bookings !== 1 || one.refused !== 19) {
    failed = true;
    console.error("FAIL: expected exactly one booking and one hold.");
  }

  // 2. Twelve parties of two, three seats: one party fits, never two.
  const three = await createDeparture(trip.id, policy.id, 3);
  created.push(three.id);
  const two = await race(three, policy.id, 12, 2);
  console.log("Three seats, 12 parties of two at once:", two);
  if (two.won !== 1 || two.heldSeats !== 2 || two.bookings !== 1) {
    failed = true;
    console.error("FAIL: expected exactly one party of two to be held.");
  }
} catch (error) {
  failed = true;
  console.error(`FAIL: ${error.message}`);
} finally {
  for (const id of created) {
    try {
      await removeDeparture(id);
    } catch (error) {
      failed = true;
      console.error(`Cleanup failed for a test departure: ${error.message}`);
    }
  }
}

console.log(failed ? "Race test FAILED." : "Race test passed: no seat was sold twice.");
process.exit(failed ? 1 : 0);
