import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { as, createDatabase } from "./harness";

const EXPECTED_TABLES = [
  "activity_log",
  "bookings",
  "departures",
  "payments",
  "policy_acceptances",
  "policy_versions",
  "rate_limits",
  "seat_holds",
  "staff",
  "sync_jobs",
  "travelers",
  "trips",
  "webhook_events",
];

let db: PGlite;

async function seedDeparture(overrides: Record<string, unknown> = {}) {
  const trip = await db.query<{ id: string }>(
    `insert into trips (slug, title, destination)
     values ('t-' || substr(gen_random_uuid()::text, 1, 8), 'Ladakh Multisport', 'Ladakh')
     returning id`,
  );
  const row = {
    trip_id: trip.rows[0]!.id,
    start_date: "2027-07-10",
    end_date: "2027-07-22",
    price_cents: 495000,
    deposit_cents: 75000,
    balance_due_date: "2027-05-11",
    max_travelers: 10,
    ...overrides,
  };
  const keys = Object.keys(row);
  const result = await db.query<{ id: string }>(
    `insert into departures (${keys.join(", ")})
     values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return { tripId: row.trip_id, departureId: result.rows[0]!.id };
}

beforeAll(async () => {
  db = await createDatabase();
  await db.exec(`
    insert into staff (email, role) values
      ('admin@adventure-access.com', 'admin'),
      ('guide@adventure-access.com', 'staff'),
      ('viewer@adventure-access.com', 'read_only');
  `);
}, 60_000);

describe("schema", () => {
  it("creates exactly the tables in the data model", async () => {
    const { rows } = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by 1",
    );
    expect(rows.map((r) => r.tablename)).toEqual(EXPECTED_TABLES);
  });

  it("has RLS enabled and forced on every public table", async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
         and not (c.relrowsecurity and c.relforcerowsecurity)`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("gives every table id, created_at and updated_at", async () => {
    const { rows } = await db.query<{ table_name: string; n: number }>(
      `select table_name, count(*)::int as n from information_schema.columns
       where table_schema = 'public'
         and column_name in ('id', 'created_at', 'updated_at')
       group by table_name`,
    );
    expect(rows).toHaveLength(EXPECTED_TABLES.length);
    expect(rows.filter((r) => r.n !== 3)).toEqual([]);
  });

  it("bumps updated_at on update", async () => {
    const { tripId } = await seedDeparture();
    await db.query(
      "update trips set updated_at = '2000-01-01', title = 'x' where id = $1",
      [tripId],
    );
    const { rows } = await db.query<{ fresh: boolean }>(
      "select updated_at > '2020-01-01' as fresh from trips where id = $1",
      [tripId],
    );
    expect(rows[0]!.fresh).toBe(true);
  });
});

describe("constraints", () => {
  it("rejects negative cents", async () => {
    await expect(seedDeparture({ price_cents: -1 })).rejects.toThrow(/departures_/);
    await expect(seedDeparture({ deposit_cents: -1 })).rejects.toThrow(/departures_/);
  });

  it("rejects a deposit larger than the price", async () => {
    await expect(
      seedDeparture({ price_cents: 1000, deposit_cents: 2000 }),
    ).rejects.toThrow(/departures_deposit_within_price/);
  });

  it("rejects min_travelers above max_travelers", async () => {
    await expect(
      seedDeparture({ min_travelers: 12, max_travelers: 10 }),
    ).rejects.toThrow(/departures_capacity/);
  });

  it("rejects an end date before the start date", async () => {
    await expect(seedDeparture({ end_date: "2027-07-01" })).rejects.toThrow(
      /departures_dates/,
    );
  });

  it("rejects any currency but usd", async () => {
    await expect(seedDeparture({ currency: "eur" })).rejects.toThrow(
      /departures_currency_usd/,
    );
  });

  it("requires a token on a private departure", async () => {
    await expect(seedDeparture({ visibility: "private" })).rejects.toThrow(
      /departures_private_needs_token/,
    );
  });

  it("requires an email for the lead traveler only", async () => {
    const { departureId } = await seedDeparture();
    const booking = await db.query<{ id: string }>(
      `insert into bookings (departure_id, reference, access_token_hash, traveler_count, total_cents)
       values ($1, 'AA-7K3Q', 'hash', 2, 990000) returning id`,
      [departureId],
    );
    const bookingId = booking.rows[0]!.id;
    await expect(
      db.query(
        "insert into travelers (booking_id, first_name, last_name, is_lead) values ($1, 'A', 'B', true)",
        [bookingId],
      ),
    ).rejects.toThrow(/travelers_lead_has_email/);
    await db.query(
      "insert into travelers (booking_id, first_name, last_name, is_lead) values ($1, 'C', 'D', false)",
      [bookingId],
    );
    await db.query(
      "insert into travelers (booking_id, first_name, last_name, email, is_lead) values ($1, 'A', 'B', 'a@example.com', true)",
      [bookingId],
    );
    await expect(
      db.query(
        "insert into travelers (booking_id, first_name, last_name, email, is_lead) values ($1, 'E', 'F', 'e@example.com', true)",
        [bookingId],
      ),
    ).rejects.toThrow(/travelers_one_lead_per_booking/);

    // One hold per booking, ever.
    const hold =
      "insert into seat_holds (departure_id, booking_id, seats, expires_at) values ($1, $2, 2, now() + interval '30 minutes')";
    await db.query(hold, [departureId, bookingId]);
    await expect(db.query(hold, [departureId, bookingId])).rejects.toThrow(
      /seat_holds_booking_id_key/,
    );
  });

  it("stores a Stripe event ID only once", async () => {
    const insert =
      "insert into webhook_events (stripe_event_id, type) values ('evt_test_1', 'checkout.session.completed')";
    await db.query(insert);
    await expect(db.query(insert)).rejects.toThrow(/webhook_events_stripe_event_id_key/);
  });

  it("blocks edits and deletes of a published policy version", async () => {
    const { rows } = await db.query<{ id: string }>(
      "insert into policy_versions (title, body_md, version) values ('Terms', 'Draft', 1) returning id",
    );
    const id = rows[0]!.id;
    await db.query("update policy_versions set body_md = 'Final' where id = $1", [id]);
    await db.query("update policy_versions set published_at = now() where id = $1", [id]);
    await expect(
      db.query("update policy_versions set body_md = 'Changed' where id = $1", [id]),
    ).rejects.toThrow(/published and cannot be changed/);
    await expect(
      db.query("delete from policy_versions where id = $1", [id]),
    ).rejects.toThrow(/published and cannot be changed/);
  });
});

describe("row-level security", () => {
  let publicDeparture: string;
  let hiddenTrip: string;

  beforeAll(async () => {
    publicDeparture = (await seedDeparture()).departureId;
    await seedDeparture({ visibility: "private", private_token: "tok-private" });
    await seedDeparture({ status: "closed" });
    hiddenTrip = (await seedDeparture({ status: "canceled" })).tripId;
    await db.query("update trips set active = false where id = $1", [hiddenTrip]);
    await db.exec(
      "insert into policy_versions (title, body_md, version) values ('Draft terms', 'x', 2)",
    );
  });

  const count = async (table: string) =>
    (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;

  it("lets the public read only active trips, bookable public departures and published policies", async () => {
    await as(db, { role: "anon" }, async () => {
      const trips = await db.query<{ active: boolean }>("select active from trips");
      expect(trips.rows.length).toBeGreaterThan(0);
      expect(trips.rows.every((r) => r.active)).toBe(true);

      const departures = await db.query<{ visibility: string; status: string }>(
        "select visibility, status from departures",
      );
      expect(departures.rows.length).toBeGreaterThan(0);
      for (const d of departures.rows) {
        expect(d.visibility).toBe("public");
        expect(["open", "full"]).toContain(d.status);
      }

      const policies = await db.query<{ published_at: string | null }>(
        "select published_at from policy_versions",
      );
      expect(policies.rows.every((r) => r.published_at !== null)).toBe(true);
    });
  });

  it("gives the public no access to any other table and no writes", async () => {
    await as(db, { role: "anon" }, async () => {
      for (const table of EXPECTED_TABLES) {
        if (["trips", "departures", "policy_versions"].includes(table)) continue;
        await expect(db.query(`select 1 from ${table}`)).rejects.toThrow(
          /permission denied/,
        );
      }
      await expect(
        db.query("insert into trips (slug, title, destination) values ('x', 'x', 'x')"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("update departures set price_cents = 1 where id = $1", [publicDeparture]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("treats a signed-in non-staff account like the public", async () => {
    await as(db, { role: "authenticated", email: "stranger@gmail.com" }, async () => {
      expect(await count("bookings")).toBe(0);
      expect(await count("staff")).toBe(0);
      expect(await count("travelers")).toBe(0);
      const trips = await db.query<{ active: boolean }>("select active from trips");
      expect(trips.rows.every((r) => r.active)).toBe(true);
      await expect(
        db.query("update departures set price_cents = 1 where id = $1", [publicDeparture]),
      ).resolves.toMatchObject({ affectedRows: 0 });
      await expect(seedDepartureAsCaller()).rejects.toThrow(/row-level security/);
    });
  });

  it("lets staff read everything, whatever the email's case", async () => {
    await as(db, { role: "authenticated", email: "Viewer@Adventure-Access.com" }, async () => {
      expect(await count("bookings")).toBeGreaterThan(0);
      expect(await count("staff")).toBe(3);
      const trips = await db.query<{ active: boolean }>("select active from trips");
      expect(trips.rows.some((r) => !r.active)).toBe(true);
      const departures = await db.query<{ visibility: string }>(
        "select visibility from departures",
      );
      expect(departures.rows.some((r) => r.visibility === "private")).toBe(true);
    });
  });

  it("keeps read_only staff from writing", async () => {
    await as(db, { role: "authenticated", email: "viewer@adventure-access.com" }, async () => {
      await expect(
        db.query("update departures set price_cents = 1 where id = $1", [publicDeparture]),
      ).resolves.toMatchObject({ affectedRows: 0 });
      await expect(seedDepartureAsCaller()).rejects.toThrow(/row-level security/);
    });
  });

  it("lets admin and staff roles write departures and policy versions, nothing else", async () => {
    for (const email of ["admin@adventure-access.com", "guide@adventure-access.com"]) {
      await as(db, { role: "authenticated", email }, async () => {
        await expect(
          db.query("update departures set max_travelers = 12 where id = $1", [publicDeparture]),
        ).resolves.toMatchObject({ affectedRows: 1 });
        await expect(seedDepartureAsCaller()).resolves.toBeDefined();
        await expect(
          db.query("update bookings set paid_cents = 1"),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.query("insert into staff (email, role) values ('x@adventure-access.com', 'admin')"),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.query("update trips set title = 'x'"),
        ).rejects.toThrow(/permission denied/);
      });
    }
  });

  it("lets the service role write the server-only tables", async () => {
    await as(db, { role: "service_role" }, async () => {
      await db.query(
        "insert into sync_jobs (kind, payload) values ('hubspot', '{}'::jsonb)",
      );
      await db.query(
        "insert into rate_limits (key, window_start, count) values ('form:test', now(), 1)",
      );
      expect(await count("sync_jobs")).toBe(1);
    });
  });

  async function seedDepartureAsCaller() {
    const trip = await db.query<{ id: string }>("select id from trips limit 1");
    return db.query(
      `insert into departures (trip_id, start_date, end_date, price_cents, deposit_cents, balance_due_date, max_travelers)
       values ($1, '2027-09-01', '2027-09-12', 495000, 75000, '2027-07-03', 8)`,
      [trip.rows[0]!.id],
    );
  }
});
