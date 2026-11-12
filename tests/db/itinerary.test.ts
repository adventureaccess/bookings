import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { as, createDatabase } from "./harness";

/** A group's itinerary: replaced in one step, shown through the booking page function only. */

let db: PGlite;
let tripId: string;
let policyId: string;

const ITEMS = [
  { kind: "day", day_label: "Days 1–2", title: "Nimmu", body_md: "Settle in.", image_url: "https://example.com/a.jpg" },
  { kind: "day", day_label: "Day 3", title: "Zangla", body_md: "", image_url: null },
  { kind: "highlight", day_label: "", title: "Khar Kongma Palace", body_md: "A palace.", image_url: "" },
];

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

const replace = (departureId: string, items: unknown) =>
  db.query<{ n: number }>("select public.replace_itinerary($1, $2::jsonb) as n", [
    departureId,
    JSON.stringify(items),
  ]);

async function pageItinerary(departureId: string, key: string | null = null) {
  const { rows } = await db.query<{ d: { itinerary: Record<string, unknown>[] } | null }>(
    "select public.departure_for_booking($1, $2) as d",
    [departureId, key],
  );
  return rows[0]!.d?.itinerary;
}

beforeAll(async () => {
  db = await createDatabase();
  const trip = await db.query<{ id: string }>(
    `insert into trips (slug, title, destination) values ('ladakh-multisport', 'Ladakh Multisport', 'ladakh')
     returning id`,
  );
  tripId = trip.rows[0]!.id;
  const policy = await db.query<{ id: string }>(
    `insert into policy_versions (title, body_md, version, published_at)
     values ('Terms', '## Terms', 1, now()) returning id`,
  );
  policyId = policy.rows[0]!.id;
  await db.exec("insert into staff (email, role) values ('admin@adventure-access.com', 'admin')");
}, 60_000);

describe("replace_itinerary", () => {
  it("stores the items in the order given and shows them on the booking page", async () => {
    const departureId = await seedDeparture();
    expect((await replace(departureId, ITEMS)).rows[0]!.n).toBe(3);
    expect(await pageItinerary(departureId)).toEqual([
      { kind: "day", day_label: "Days 1–2", title: "Nimmu", body_md: "Settle in.", image_url: "https://example.com/a.jpg" },
      { kind: "day", day_label: "Day 3", title: "Zangla", body_md: "", image_url: null },
      { kind: "highlight", day_label: "", title: "Khar Kongma Palace", body_md: "A palace.", image_url: null },
    ]);
  });

  it("replaces what was there, and an empty list clears it", async () => {
    const departureId = await seedDeparture();
    await replace(departureId, ITEMS);
    await replace(departureId, [{ title: "Only day" }]);
    expect(await pageItinerary(departureId)).toEqual([
      { kind: "day", day_label: "", title: "Only day", body_md: "", image_url: null },
    ]);
    await replace(departureId, []);
    expect(await pageItinerary(departureId)).toEqual([]);
  });

  it("does not touch another departure's itinerary", async () => {
    const one = await seedDeparture();
    const two = await seedDeparture();
    await replace(one, ITEMS);
    await replace(two, [{ title: "Other group" }]);
    expect(await pageItinerary(one)).toHaveLength(3);
    expect(await pageItinerary(two)).toHaveLength(1);
  });

  it("refuses bad input and leaves the old itinerary in place", async () => {
    const departureId = await seedDeparture();
    await replace(departureId, ITEMS);
    await expect(replace(departureId, [{ title: "" }])).rejects.toThrow(/itinerary_items_title_length/);
    await expect(
      replace(departureId, [{ title: "x", image_url: "http://insecure.example/a.jpg" }]),
    ).rejects.toThrow(/itinerary_items_image_absolute/);
    await expect(replace(departureId, [{ title: "x", kind: "note" }])).rejects.toThrow();
    await expect(replace(departureId, { title: "not a list" })).rejects.toThrow(/must be a list/);
    await expect(
      replace(departureId, Array.from({ length: 61 }, (_, i) => ({ title: `Day ${i}` }))),
    ).rejects.toThrow(/at most 60/);
    await expect(replace("3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b", [])).rejects.toThrow(/not found/);
    expect(await pageItinerary(departureId)).toHaveLength(3);
  });

  it("goes away with its departure", async () => {
    const departureId = await seedDeparture();
    await replace(departureId, ITEMS);
    await db.query("delete from departures where id = $1", [departureId]);
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from itinerary_items where departure_id = $1",
      [departureId],
    );
    expect(rows[0]!.n).toBe(0);
  });
});

describe("who can see an itinerary", () => {
  it("is shown for a private departure only with its key", async () => {
    const departureId = await seedDeparture({ visibility: "private", private_token: "group-key" });
    await replace(departureId, ITEMS);
    expect(await pageItinerary(departureId)).toBeUndefined();
    expect(await pageItinerary(departureId, "wrong")).toBeUndefined();
    expect(await pageItinerary(departureId, "group-key")).toHaveLength(3);
  });

  it("cannot be read or changed directly by the public or a signed-in account", async () => {
    const departureId = await seedDeparture();
    await replace(departureId, ITEMS);
    await expect(
      as(db, { role: "anon" }, () => db.query("select * from itinerary_items")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, { role: "anon" }, () => db.query("select public.replace_itinerary($1, '[]'::jsonb)", [departureId])),
    ).rejects.toThrow(/permission denied/);

    const staff = { role: "authenticated" as const, email: "admin@adventure-access.com" };
    const read = await as(db, staff, () =>
      db.query("select title from itinerary_items where departure_id = $1 order by position", [departureId]),
    );
    expect(read.rows).toHaveLength(3);
    await expect(
      as(db, staff, () => db.query("delete from itinerary_items where departure_id = $1", [departureId])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, staff, () => db.query("select public.replace_itinerary($1, '[]'::jsonb)", [departureId])),
    ).rejects.toThrow(/permission denied/);

    const stranger = { role: "authenticated" as const, email: "someone@gmail.com" };
    const hidden = await as(db, stranger, () => db.query("select title from itinerary_items"));
    expect(hidden.rows).toHaveLength(0);
  });
});

describe("tours and groups", () => {
  it("keeps a template itinerary on the tour and a staff label on the departure", async () => {
    await db.query("update trips set itinerary = $1::jsonb where id = $2", [JSON.stringify(ITEMS), tripId]);
    await expect(
      db.query("update trips set itinerary = '{}'::jsonb where id = $1", [tripId]),
    ).rejects.toThrow(/trips_itinerary_array/);

    const departureId = await seedDeparture({ group_name: "Hulsey family" });
    await expect(
      db.query("update departures set group_name = '' where id = $1", [departureId]),
    ).rejects.toThrow(/departures_group_name_length/);
    // The label is for staff. The booking page does not carry it.
    const { rows } = await db.query<{ d: Record<string, unknown> }>(
      "select public.departure_for_booking($1, null) as d",
      [departureId],
    );
    expect(JSON.stringify(rows[0]!.d)).not.toContain("Hulsey");
  });
});
