import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { as, createDatabase } from "./harness";

/**
 * The booking transaction and seat counting, against every migration in an
 * in-process Postgres. PGlite runs one statement at a time, so these tests
 * prove the rules, not the row lock. The lock is exercised against a real
 * Postgres by scripts/race-last-seat.mjs.
 */

let db: PGlite;
let policyId: string;
let tripId: string;

interface BookingResult {
  ok: boolean;
  reason?: string;
  seats_left?: number;
  booking_id?: string;
  reference?: string;
  expires_at?: string;
  resumed?: boolean;
}

const lead = (overrides: Record<string, unknown> = {}) => ({
  first_name: "Tenzin",
  last_name: "Lead",
  email: "Lead@Example.com",
  phone: "+1 555 0100",
  is_lead: true,
  answers: { q1: "172 cm" },
  ...overrides,
});
const guest = (n: number) => ({
  first_name: `Guest${n}`,
  last_name: "Traveler",
  email: "",
  is_lead: false,
  answers: {},
});
const party = (size: number) => [lead(), ...Array.from({ length: size - 1 }, (_, i) => guest(i + 1))];

async function seedDeparture(overrides: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    trip_id: tripId,
    start_date: "2099-07-10",
    end_date: "2099-07-22",
    price_cents: 495000,
    deposit_cents: 75000,
    balance_due_date: "2099-05-11",
    max_travelers: 4,
    policy_version_id: policyId,
    ...overrides,
  };
  const keys = Object.keys(row);
  const result = await db.query<{ id: string }>(
    `insert into departures (${keys.join(", ")})
     values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return result.rows[0]!.id;
}

interface BookOptions {
  key?: string | null;
  policy?: string;
  resume?: string | null;
  travelers?: unknown[];
}

function book(departureId: string, size: number, options: BookOptions = {}): Promise<BookingResult> {
  return as(db, { role: "service_role" }, async () => {
    const { rows } = await db.query<{ result: BookingResult }>(
      `select public.create_booking($1, $2, $3, $4::jsonb, $5, $6::inet, $7, $8, $9) as result`,
      [
        departureId,
        options.key ?? null,
        options.policy ?? policyId,
        JSON.stringify(options.travelers ?? party(size)),
        "hash-" + Math.random().toString(36).slice(2),
        "203.0.113.7",
        "vitest",
        "web",
        options.resume ?? null,
      ],
    );
    return rows[0]!.result;
  });
}

async function seatsLeft(departureId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "select public.departure_seats_left($1) as n",
    [departureId],
  );
  return rows[0]!.n;
}

async function count(table: string, where: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from ${table} where ${where}`,
    params,
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  db = await createDatabase();
  const trip = await db.query<{ id: string }>(
    `insert into trips (slug, title, destination, hero_image_url)
     values ('ladakh-multisport', 'Ladakh Multisport', 'ladakh', 'https://example.com/hero.jpg')
     returning id`,
  );
  tripId = trip.rows[0]!.id;
  const policy = await db.query<{ id: string }>(
    `insert into policy_versions (title, body_md, version, published_at)
     values ('Terms', '## Terms', 1, now()) returning id`,
  );
  policyId = policy.rows[0]!.id;
}, 60_000);

describe("create_booking", () => {
  it("creates a pending booking, its travelers, the acceptance and a 30 minute hold", async () => {
    const departureId = await seedDeparture();
    const result = await book(departureId, 2);
    expect(result.ok).toBe(true);
    expect(result.reference).toMatch(/^AA-[2-9A-HJ-NP-Z]{4}$/);

    const booking = await db.query<Record<string, unknown>>(
      `select b.status, b.traveler_count, b.total_cents, b.paid_cents, b.source,
              t.first_name as lead_first, t.email as lead_email, t.answers as lead_answers
       from bookings b join travelers t on t.id = b.lead_traveler_id
       where b.id = $1`,
      [result.booking_id],
    );
    expect(booking.rows[0]).toEqual({
      status: "pending",
      traveler_count: 2,
      total_cents: 990000,
      paid_cents: 0,
      source: "web",
      lead_first: "Tenzin",
      lead_email: "lead@example.com",
      lead_answers: { q1: "172 cm" },
    });
    expect(await count("travelers", "booking_id = $1", [result.booking_id])).toBe(2);
    // A blank email on an additional traveler is stored as no email.
    expect(await count("travelers", "booking_id = $1 and email is null", [result.booking_id])).toBe(1);

    const acceptance = await db.query<Record<string, unknown>>(
      `select policy_version_id, host(ip) as ip, user_agent from policy_acceptances where booking_id = $1`,
      [result.booking_id],
    );
    expect(acceptance.rows).toEqual([
      { policy_version_id: policyId, ip: "203.0.113.7", user_agent: "vitest" },
    ]);

    const hold = await db.query<{ seats: number; minutes: number }>(
      `select seats, round(extract(epoch from (expires_at - now())) / 60)::int as minutes
       from seat_holds where booking_id = $1`,
      [result.booking_id],
    );
    expect(hold.rows).toEqual([{ seats: 2, minutes: 30 }]);
    expect(await seatsLeft(departureId)).toBe(2);
  });

  it("gives the last seat to exactly one of two bookings made together", async () => {
    const departureId = await seedDeparture({ max_travelers: 1 });
    const results = await Promise.all([book(departureId, 1), book(departureId, 1)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok);
    expect(refused).toMatchObject({ reason: "not_enough_seats", seats_left: 0 });
    expect(await count("seat_holds", "departure_id = $1", [departureId])).toBe(1);
    expect(await count("bookings", "departure_id = $1", [departureId])).toBe(1);
    expect(await seatsLeft(departureId)).toBe(0);
  });

  it("refuses a party larger than the seats left and writes nothing", async () => {
    const departureId = await seedDeparture({ max_travelers: 3 });
    await book(departureId, 2);
    const result = await book(departureId, 2);
    expect(result).toEqual({ ok: false, reason: "not_enough_seats", seats_left: 1 });
    expect(await count("bookings", "departure_id = $1", [departureId])).toBe(1);
  });

  it("frees the seats when a hold expires, without any cleanup job", async () => {
    const departureId = await seedDeparture({ max_travelers: 1 });
    const first = await book(departureId, 1);
    await db.query(
      "update seat_holds set expires_at = now() - interval '1 second' where booking_id = $1",
      [first.booking_id],
    );
    expect(await seatsLeft(departureId)).toBe(1);
    expect((await book(departureId, 1)).ok).toBe(true);
  });

  it("keeps counting a paid booking after its hold has expired", async () => {
    const departureId = await seedDeparture({ max_travelers: 2 });
    const first = await book(departureId, 2);
    await db.query("update bookings set status = 'deposit_paid' where id = $1", [first.booking_id]);
    await db.query(
      "update seat_holds set expires_at = now() - interval '1 hour' where booking_id = $1",
      [first.booking_id],
    );
    expect(await seatsLeft(departureId)).toBe(0);
    expect((await book(departureId, 1)).reason).toBe("not_enough_seats");
  });

  it("does not count a paid booking twice while its hold is still live", async () => {
    const departureId = await seedDeparture({ max_travelers: 4 });
    const first = await book(departureId, 2);
    await db.query("update bookings set status = 'deposit_paid' where id = $1", [first.booking_id]);
    expect(await seatsLeft(departureId)).toBe(2);
  });

  it("frees the seats of a canceled booking", async () => {
    const departureId = await seedDeparture({ max_travelers: 2 });
    const first = await book(departureId, 2);
    await db.query("update bookings set status = 'canceled' where id = $1", [first.booking_id]);
    expect(await seatsLeft(departureId)).toBe(2);
  });
});

describe("resubmitting", () => {
  it("reuses the same pending booking and hold, never a second hold", async () => {
    const departureId = await seedDeparture({ max_travelers: 4 });
    const first = await book(departureId, 2);
    const again = await book(departureId, 3, { resume: first.booking_id });

    expect(again).toMatchObject({
      ok: true,
      resumed: true,
      booking_id: first.booking_id,
      reference: first.reference,
    });
    expect(await count("bookings", "departure_id = $1", [departureId])).toBe(1);
    expect(await count("seat_holds", "departure_id = $1", [departureId])).toBe(1);
    expect(await count("travelers", "booking_id = $1", [first.booking_id])).toBe(3);
    expect(await count("policy_acceptances", "booking_id = $1", [first.booking_id])).toBe(1);
    expect(await count("bookings", "id = $1 and total_cents = 1485000 and lead_traveler_id is not null", [first.booking_id])).toBe(1);
    expect(await seatsLeft(departureId)).toBe(1);
  });

  it("lets a full departure's own holder resubmit, but not grow past capacity", async () => {
    const departureId = await seedDeparture({ max_travelers: 2 });
    const first = await book(departureId, 2);
    expect((await book(departureId, 2, { resume: first.booking_id })).ok).toBe(true);
    expect(await book(departureId, 3, { resume: first.booking_id })).toEqual({
      ok: false,
      reason: "not_enough_seats",
      seats_left: 2,
    });
    // The refusal changed nothing.
    expect(await count("travelers", "booking_id = $1", [first.booking_id])).toBe(2);
  });

  it("ignores a resume id from another departure or a booking that is no longer pending", async () => {
    const one = await seedDeparture();
    const two = await seedDeparture();
    const first = await book(one, 1);
    const other = await book(two, 1, { resume: first.booking_id });
    expect(other.resumed).toBe(false);
    expect(other.booking_id).not.toBe(first.booking_id);

    await db.query("update bookings set status = 'deposit_paid' where id = $1", [first.booking_id]);
    const fresh = await book(one, 1, { resume: first.booking_id });
    expect(fresh.resumed).toBe(false);
    expect(await count("bookings", "departure_id = $1", [one])).toBe(2);
  });
});

describe("refusals", () => {
  it("refuses a departure that is not open, has started, or has no policy", async () => {
    for (const overrides of [
      { status: "full" },
      { status: "closed" },
      { status: "canceled" },
      { start_date: "2020-01-10", end_date: "2020-01-20", balance_due_date: "2019-12-01" },
      { policy_version_id: null },
    ]) {
      const departureId = await seedDeparture(overrides);
      expect(await book(departureId, 1)).toEqual({ ok: false, reason: "closed" });
      expect(await count("bookings", "departure_id = $1", [departureId])).toBe(0);
    }
  });

  it("refuses when the attached policy is not the one the traveler accepted", async () => {
    const departureId = await seedDeparture();
    const other = await db.query<{ id: string }>(
      `insert into policy_versions (title, body_md, version, published_at)
       values ('Terms', '## New terms', 2, now()) returning id`,
    );
    expect(await book(departureId, 1, { policy: other.rows[0]!.id })).toEqual({
      ok: false,
      reason: "policy_changed",
    });
  });

  it("needs the exact key for a private departure", async () => {
    const departureId = await seedDeparture({ visibility: "private", private_token: "right-key" });
    expect((await book(departureId, 1)).reason).toBe("not_found");
    expect((await book(departureId, 1, { key: "wrong-key" })).reason).toBe("not_found");
    expect((await book(departureId, 1, { key: "right-key" })).ok).toBe(true);
  });

  it("refuses an unknown departure and a trip that is switched off", async () => {
    expect((await book("3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b", 1)).reason).toBe("not_found");
    const trip = await db.query<{ id: string }>(
      `insert into trips (slug, title, destination, active) values ('off-trip', 'Off', 'nepal', false)
       returning id`,
    );
    const departureId = await seedDeparture({ trip_id: trip.rows[0]!.id });
    expect((await book(departureId, 1)).reason).toBe("not_found");
  });

  it("rejects a party with no lead or two leads, and writes nothing", async () => {
    const departureId = await seedDeparture();
    await expect(book(departureId, 2, { travelers: [guest(1), guest(2)] })).rejects.toThrow(
      /exactly one lead/,
    );
    await expect(book(departureId, 2, { travelers: [lead(), lead()] })).rejects.toThrow(
      /exactly one lead/,
    );
    await expect(book(departureId, 0, { travelers: [] })).rejects.toThrow(/between 1 and 20/);
    expect(await count("bookings", "departure_id = $1", [departureId])).toBe(0);
  });
});

describe("public reads", () => {
  it("lists only public, future, open or full departures that have a policy", async () => {
    const listed = await seedDeparture({ max_travelers: 6, start_date: "2098-03-01", end_date: "2098-03-09", balance_due_date: "2098-01-01" });
    await book(listed, 2);
    const hidden = [
      await seedDeparture({ visibility: "private", private_token: "list-key" }),
      await seedDeparture({ status: "closed" }),
      await seedDeparture({ policy_version_id: null }),
      await seedDeparture({ start_date: "2020-01-10", end_date: "2020-01-20", balance_due_date: "2019-12-01" }),
    ];
    const { rows } = await db.query<{ departure_id: string; seats_left: number; trip_slug: string }>(
      "select departure_id, seats_left, trip_slug from public.bookable_departures()",
    );
    const ids = rows.map((r) => r.departure_id);
    expect(ids).toContain(listed);
    for (const id of hidden) expect(ids).not.toContain(id);
    expect(rows.find((r) => r.departure_id === listed)).toMatchObject({
      seats_left: 4,
      trip_slug: "ladakh-multisport",
    });
  });

  it("describes a departure for its booking page, and hides a private one without its key", async () => {
    const open = await seedDeparture({ max_travelers: 5 });
    const { rows } = await db.query<{ d: Record<string, unknown> }>(
      "select public.departure_for_booking($1, null) as d",
      [open],
    );
    expect(rows[0]!.d).toMatchObject({
      trip_title: "Ladakh Multisport",
      price_cents: 495000,
      deposit_cents: 75000,
      seats_left: 5,
      is_private: false,
      is_past: false,
      policy: { id: policyId, version: 1, title: "Terms" },
    });

    const hidden = await seedDeparture({ visibility: "private", private_token: "page-key" });
    const page = async (key: string | null) =>
      (await db.query<{ d: unknown }>("select public.departure_for_booking($1, $2) as d", [hidden, key]))
        .rows[0]!.d;
    expect(await page(null)).toBeNull();
    expect(await page("nope")).toBeNull();
    expect(await page("page-key")).toMatchObject({ is_private: true });

    const closed = await seedDeparture({ status: "closed" });
    expect(
      (await db.query<{ d: unknown }>("select public.departure_for_booking($1, null) as d", [closed]))
        .rows[0]!.d,
    ).toBeNull();
  });

  it("shows a traveler their own booking only with the right token hash, and no contact details", async () => {
    const departureId = await seedDeparture();
    const result = await book(departureId, 2);
    const hash = (
      await db.query<{ h: string }>("select access_token_hash as h from bookings where id = $1", [
        result.booking_id,
      ])
    ).rows[0]!.h;
    const summary = async (h: string) =>
      (await db.query<{ s: Record<string, unknown> | null }>(
        "select public.booking_summary($1, $2) as s",
        [result.reference, h],
      )).rows[0]!.s;

    expect(await summary("wrong")).toBeNull();
    const mine = await summary(hash);
    expect(mine).toMatchObject({
      reference: result.reference,
      status: "pending",
      traveler_count: 2,
      total_cents: 990000,
      deposit_due_cents: 150000,
      hold_active: true,
      trip_title: "Ladakh Multisport",
      lead_first_name: "Tenzin",
    });
    expect(JSON.stringify(mine)).not.toMatch(/example\.com|555/);
  });
});

describe("who may call the booking functions", () => {
  const calls = [
    "select public.departure_seats_left('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b')",
    "select * from public.bookable_departures()",
    "select public.departure_for_booking('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', null)",
    "select public.booking_summary('AA-2222', 'x')",
    `select public.create_booking('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', null,
       '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', '[]'::jsonb, 'x', null, 'x', 'web')`,
  ];

  it("refuses the public and signed-in accounts, staff included", async () => {
    await db.exec(
      "insert into staff (email, role) values ('admin@adventure-access.com', 'admin') on conflict do nothing",
    );
    for (const sql of calls) {
      await expect(as(db, { role: "anon" }, () => db.query(sql))).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        as(db, { role: "authenticated", email: "admin@adventure-access.com" }, () => db.query(sql)),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("lets the service role call the read functions", async () => {
    for (const sql of calls.slice(0, 4)) {
      await expect(as(db, { role: "service_role" }, () => db.query(sql))).resolves.toBeDefined();
    }
  });
});
