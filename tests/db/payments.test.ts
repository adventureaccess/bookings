import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { as, createDatabase } from "./harness";

/**
 * Money: card payments from the webhook, offline payments from staff,
 * credits, voids and refunds, and how they move a booking's status.
 * Departure: $4,950 per person, $750 deposit.
 */

let db: PGlite;
let policyId: string;
let tripId: string;

interface Money {
  status: string;
  paid_cents: number;
  discount_cents: number;
  balance_cents: number;
  needs_attention: boolean;
  confirmed_now?: boolean;
  recorded?: boolean;
  ok?: boolean;
  reason?: string;
  payment_id?: string;
}

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

async function book(departureId: string, size = 1): Promise<string> {
  const travelers = Array.from({ length: size }, (_, i) => ({
    first_name: i === 0 ? "Tenzin" : `Guest${i}`,
    last_name: "Norbu",
    email: i === 0 ? "tenzin@example.com" : "",
    phone: i === 0 ? "+1 555 0100" : "",
    is_lead: i === 0,
    answers: {},
  }));
  const { rows } = await db.query<{ r: { ok: boolean; booking_id: string } }>(
    `select public.create_booking($1, null, $2, $3::jsonb, $4, null, 'vitest', 'web') as r`,
    [departureId, policyId, JSON.stringify(travelers), "hash-" + Math.random().toString(36).slice(2)],
  );
  if (!rows[0]!.r.ok) throw new Error("booking refused");
  return rows[0]!.r.booking_id;
}

async function call<T = Money>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await db.query<{ r: T }>(`select ${sql} as r`, params);
  return rows[0]!.r;
}

let sessionCounter = 0;
const card = (bookingId: string, amount: number, fee = 0, session?: string) =>
  call("public.record_card_payment($1, $2, $3, $4, $5)", [
    bookingId,
    session ?? `cs_test_${++sessionCounter}`,
    `pi_test_${sessionCounter}`,
    amount,
    fee,
  ]);
const offline = (bookingId: string, amount: number, method = "wire") =>
  call("public.record_offline_payment($1, $2::public.payment_method, $3, $4, $5, $6)", [
    bookingId,
    method,
    amount,
    "2099-01-15",
    "Reference 123",
    "staff@adventure-access.com",
  ]);
const credit = (bookingId: string, amount: number, reason = "Returning traveler") =>
  call("public.add_booking_adjustment($1, $2, $3, $4)", [
    bookingId,
    amount,
    reason,
    "staff@adventure-access.com",
  ]);
const expireHold = (bookingId: string) =>
  db.query("update seat_holds set expires_at = now() - interval '1 minute' where booking_id = $1", [
    bookingId,
  ]);

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
    `insert into trips (slug, title, destination) values ('ladakh-multisport', 'Ladakh Multisport', 'ladakh')
     returning id`,
  );
  tripId = trip.rows[0]!.id;
  const policy = await db.query<{ id: string }>(
    `insert into policy_versions (title, body_md, version, published_at)
     values ('Terms', '## Terms', 1, now()) returning id`,
  );
  policyId = policy.rows[0]!.id;
}, 60_000);

describe("card payments", () => {
  it("records the deposit and confirms the booking", async () => {
    const bookingId = await book(await seedDeparture());
    const result = await card(bookingId, 75000, 2250);
    expect(result).toMatchObject({
      recorded: true,
      status: "deposit_paid",
      paid_cents: 75000,
      balance_cents: 420000,
      confirmed_now: true,
      needs_attention: false,
    });
    const { rows } = await db.query(
      "select kind, method, amount_cents, fee_cents, status from payments where booking_id = $1",
      [bookingId],
    );
    expect(rows).toEqual([
      { kind: "deposit", method: "card", amount_cents: 75000, fee_cents: 2250, status: "succeeded" },
    ]);
  });

  it("keeps the card fee out of what the trip has been paid", async () => {
    const bookingId = await book(await seedDeparture());
    const result = await card(bookingId, 495000, 14850);
    expect(result).toMatchObject({ status: "paid_in_full", paid_cents: 495000, balance_cents: 0 });
  });

  it("changes nothing when the same Checkout Session arrives twice", async () => {
    const bookingId = await book(await seedDeparture());
    const first = await card(bookingId, 75000, 2250, "cs_test_replay");
    const again = await card(bookingId, 75000, 2250, "cs_test_replay");
    expect(first.recorded).toBe(true);
    expect(again).toMatchObject({ recorded: false, status: "deposit_paid", paid_cents: 75000 });
    expect(await count("payments", "booking_id = $1", [bookingId])).toBe(1);
  });

  it("records a later payment as balance and reaches paid in full", async () => {
    const bookingId = await book(await seedDeparture());
    await card(bookingId, 75000);
    const result = await card(bookingId, 420000);
    expect(result).toMatchObject({ status: "paid_in_full", paid_cents: 495000, balance_cents: 0 });
    expect(await count("payments", "booking_id = $1 and kind = 'balance'", [bookingId])).toBe(1);
  });

  it("stays pending when less than the deposit has arrived", async () => {
    const bookingId = await book(await seedDeparture());
    expect(await card(bookingId, 50000)).toMatchObject({ status: "pending", paid_cents: 50000 });
    expect(await card(bookingId, 25000)).toMatchObject({ status: "deposit_paid", paid_cents: 75000 });
  });

  it("scales the deposit with the number of travelers", async () => {
    const bookingId = await book(await seedDeparture(), 2);
    expect((await card(bookingId, 75000)).status).toBe("pending");
    expect((await card(bookingId, 75000)).status).toBe("deposit_paid");
  });

  it("refuses a payment with no amount or an unknown booking", async () => {
    const bookingId = await book(await seedDeparture());
    await expect(card(bookingId, 0)).rejects.toThrow(/session and an amount/);
    await expect(card("3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b", 100)).rejects.toThrow(/not found/);
  });
});

describe("a payment that arrives after the hold ran out", () => {
  it("still confirms while the seat is free", async () => {
    const bookingId = await book(await seedDeparture({ max_travelers: 1 }));
    await expireHold(bookingId);
    expect(await card(bookingId, 75000)).toMatchObject({
      status: "deposit_paid",
      confirmed_now: true,
      needs_attention: false,
    });
  });

  it("records the money but does not confirm when the seat has gone, and flags it", async () => {
    const departureId = await seedDeparture({ max_travelers: 1 });
    const late = await book(departureId);
    await expireHold(late);
    const other = await book(departureId);
    await card(other, 75000);

    const result = await card(late, 75000);
    expect(result).toMatchObject({
      recorded: true,
      status: "pending",
      paid_cents: 75000,
      needs_attention: true,
      confirmed_now: false,
    });
    // Nothing was refunded or removed, and the departure is not oversold.
    expect(await count("payments", "booking_id = $1", [late])).toBe(1);
    expect(
      (await db.query<{ n: number }>("select public.departure_seats_left($1) as n", [departureId]))
        .rows[0]!.n,
    ).toBe(0);
  });
});

describe("offline payments", () => {
  it("records a wire and confirms the booking, with who recorded it", async () => {
    const bookingId = await book(await seedDeparture());
    const result = await offline(bookingId, 75000);
    expect(result).toMatchObject({ status: "deposit_paid", paid_cents: 75000 });
    const { rows } = await db.query(
      `select method, kind, amount_cents, fee_cents, received_on::text as received_on, note, recorded_by
       from payments where id = $1`,
      [result.payment_id],
    );
    expect(rows).toEqual([
      {
        method: "wire",
        kind: "deposit",
        amount_cents: 75000,
        fee_cents: 0,
        received_on: "2099-01-15",
        note: "Reference 123",
        recorded_by: "staff@adventure-access.com",
      },
    ]);
  });

  it("adds irregular installments up to paid in full", async () => {
    const bookingId = await book(await seedDeparture());
    await offline(bookingId, 75000, "ach");
    for (let i = 0; i < 8; i++) await offline(bookingId, 50000, "check");
    expect(await offline(bookingId, 20000, "cash")).toMatchObject({
      status: "paid_in_full",
      paid_cents: 495000,
      balance_cents: 0,
    });
  });

  it("mixes with card payments", async () => {
    const bookingId = await book(await seedDeparture());
    await card(bookingId, 75000, 2250);
    expect(await offline(bookingId, 420000)).toMatchObject({ status: "paid_in_full" });
  });

  it("refuses card as an offline method, a zero amount and a missing recorder", async () => {
    const bookingId = await book(await seedDeparture());
    await expect(offline(bookingId, 100, "card")).rejects.toThrow(/Stripe webhook only/);
    await expect(offline(bookingId, 0)).rejects.toThrow(/more than zero/);
    await expect(
      call("public.record_offline_payment($1, 'wire', 100, null, null, '')", [bookingId]),
    ).rejects.toThrow(/who recorded/);
  });
});

describe("voiding", () => {
  it("takes an offline payment back, keeps the row, and drops paid in full to deposit paid", async () => {
    const bookingId = await book(await seedDeparture());
    await offline(bookingId, 75000);
    const balance = await offline(bookingId, 420000);
    const result = await call("public.void_payment($1, $2)", [balance.payment_id, "Wire bounced"]);
    expect(result).toMatchObject({
      ok: true,
      status: "deposit_paid",
      paid_cents: 75000,
      balance_cents: 420000,
      needs_attention: false,
    });
    expect(
      await count("payments", "id = $1 and voided_at is not null and void_reason = 'Wire bounced'", [
        balance.payment_id,
      ]),
    ).toBe(1);
  });

  it("never drops a confirmed booking back to pending; it flags it for staff", async () => {
    const departureId = await seedDeparture({ max_travelers: 1 });
    const bookingId = await book(departureId);
    const deposit = await offline(bookingId, 75000);
    const result = await call("public.void_payment($1, $2)", [deposit.payment_id, "Entered twice"]);
    expect(result).toMatchObject({ status: "deposit_paid", paid_cents: 0, needs_attention: true });
    // The seat is still theirs until staff decide.
    expect(
      (await db.query<{ n: number }>("select public.departure_seats_left($1) as n", [departureId]))
        .rows[0]!.n,
    ).toBe(0);
  });

  it("cannot void a card payment, void twice, or void without a reason", async () => {
    const bookingId = await book(await seedDeparture());
    await card(bookingId, 75000);
    const cardPayment = await db.query<{ id: string }>(
      "select id from payments where booking_id = $1",
      [bookingId],
    );
    expect(await call("public.void_payment($1, $2)", [cardPayment.rows[0]!.id, "x"])).toEqual({
      ok: false,
      reason: "not_voidable",
    });

    const wire = await offline(bookingId, 1000);
    await expect(call("public.void_payment($1, $2)", [wire.payment_id, "  "])).rejects.toThrow(
      /reason is required/,
    );
    expect((await call("public.void_payment($1, $2)", [wire.payment_id, "Mistake"])).ok).toBe(true);
    expect((await call("public.void_payment($1, $2)", [wire.payment_id, "Again"])).ok).toBe(false);
  });
});

describe("credits", () => {
  it("reduce what is owed, so a smaller payment reaches paid in full", async () => {
    const bookingId = await book(await seedDeparture());
    expect(await credit(bookingId, 249900)).toMatchObject({
      ok: true,
      status: "pending",
      discount_cents: 249900,
      balance_cents: 245100,
    });
    await offline(bookingId, 75000);
    expect(await offline(bookingId, 170100)).toMatchObject({
      status: "paid_in_full",
      paid_cents: 245100,
      discount_cents: 249900,
      balance_cents: 0,
    });
  });

  it("the acceptance case: a wire and a credit leave the right balance", async () => {
    const bookingId = await book(await seedDeparture());
    await offline(bookingId, 200000);
    const result = await credit(bookingId, 50000, "Referral credit");
    // 4,950 - 500 credit - 2,000 wire = 2,450
    expect(result).toMatchObject({ status: "deposit_paid", balance_cents: 245000 });
    const { rows } = await db.query(
      "select total_cents, discount_cents, paid_cents from bookings where id = $1",
      [bookingId],
    );
    expect(rows).toEqual([{ total_cents: 495000, discount_cents: 50000, paid_cents: 200000 }]);
  });

  it("can be taken back with a negative amount, but never below zero or above the total", async () => {
    const bookingId = await book(await seedDeparture());
    await credit(bookingId, 50000);
    expect(await credit(bookingId, -60000)).toEqual({
      ok: false,
      reason: "out_of_range",
      credits_cents: 50000,
    });
    expect(await credit(bookingId, 500000)).toMatchObject({ ok: false, reason: "out_of_range" });
    expect(await credit(bookingId, -50000)).toMatchObject({ ok: true, discount_cents: 0 });
    expect(await count("booking_adjustments", "booking_id = $1", [bookingId])).toBe(2);
  });

  it("needs a reason and a non-zero amount", async () => {
    const bookingId = await book(await seedDeparture());
    await expect(credit(bookingId, 1000, "   ")).rejects.toThrow(/booking_adjustments_reason/);
    await expect(credit(bookingId, 0)).rejects.toThrow(/booking_adjustments_not_zero/);
  });

  it("a credit for the whole trip confirms the booking as paid in full", async () => {
    const bookingId = await book(await seedDeparture());
    expect(await credit(bookingId, 495000, "Guide, traveling free")).toMatchObject({
      status: "paid_in_full",
      balance_cents: 0,
    });
  });
});

describe("refunds from Stripe", () => {
  it("records the refund once, however many times it is reported", async () => {
    const bookingId = await book(await seedDeparture());
    await card(bookingId, 75000, 0, "cs_test_refund_a");
    await db.query("update payments set stripe_payment_intent_id = 'pi_refund_a' where booking_id = $1", [
      bookingId,
    ]);
    await card(bookingId, 420000, 0, "cs_test_refund_b");

    const first = await call("public.record_card_refund($1, $2, $3)", ["pi_refund_a", "re_1", 25000]);
    expect(first).toMatchObject({ recorded: true, paid_cents: 470000, status: "deposit_paid" });
    const replay = await call("public.record_card_refund($1, $2, $3)", ["pi_refund_a", "re_1", 25000]);
    expect(replay).toMatchObject({ recorded: false, paid_cents: 470000 });

    // A second partial refund: Stripe reports the running total.
    const second = await call("public.record_card_refund($1, $2, $3)", ["pi_refund_a", "re_2", 75000]);
    expect(second).toMatchObject({ recorded: true, paid_cents: 420000 });
    expect(await count("payments", "booking_id = $1 and kind = 'refund'", [bookingId])).toBe(2);
  });

  it("ignores a refund for a payment it does not know", async () => {
    expect(await call("public.record_card_refund($1, $2, $3)", ["pi_unknown", "re_x", 100])).toEqual({
      recorded: false,
      reason: "unknown_payment",
    });
  });
});

describe("canceled bookings", () => {
  it("record money that arrives but stay canceled and get flagged", async () => {
    const bookingId = await book(await seedDeparture());
    await db.query("update bookings set status = 'canceled' where id = $1", [bookingId]);
    expect(await offline(bookingId, 75000)).toMatchObject({
      status: "canceled",
      paid_cents: 75000,
      needs_attention: true,
    });
  });
});

describe("prepare_payment", () => {
  it("stretches a live hold to cover the payment session", async () => {
    const bookingId = await book(await seedDeparture());
    const result = await call<{ ok: boolean }>("public.prepare_payment($1, 31)", [bookingId]);
    expect(result.ok).toBe(true);
    const { rows } = await db.query<{ minutes: number }>(
      `select round(extract(epoch from (expires_at - now())) / 60)::int as minutes
       from seat_holds where booking_id = $1`,
      [bookingId],
    );
    expect(rows).toEqual([{ minutes: 31 }]);
    expect(await count("seat_holds", "booking_id = $1", [bookingId])).toBe(1);
  });

  it("takes the seat again after the hold ran out, if it is still free", async () => {
    const departureId = await seedDeparture({ max_travelers: 1 });
    const bookingId = await book(departureId);
    await expireHold(bookingId);
    expect((await call<{ ok: boolean }>("public.prepare_payment($1, 31)", [bookingId])).ok).toBe(true);
    expect(
      (await db.query<{ n: number }>("select public.departure_seats_left($1) as n", [departureId]))
        .rows[0]!.n,
    ).toBe(0);
  });

  it("refuses when the seat went to someone else, or the booking or departure is closed", async () => {
    const departureId = await seedDeparture({ max_travelers: 1 });
    const late = await book(departureId);
    await expireHold(late);
    await book(departureId);
    expect(await call("public.prepare_payment($1, 31)", [late])).toEqual({
      ok: false,
      reason: "not_enough_seats",
    });

    const closedDeparture = await seedDeparture();
    const onClosed = await book(closedDeparture);
    await db.query("update departures set status = 'canceled' where id = $1", [closedDeparture]);
    expect(await call("public.prepare_payment($1, 31)", [onClosed])).toEqual({
      ok: false,
      reason: "closed",
    });

    const canceled = await book(await seedDeparture());
    await db.query("update bookings set status = 'canceled' where id = $1", [canceled]);
    expect(await call("public.prepare_payment($1, 31)", [canceled])).toEqual({
      ok: false,
      reason: "closed",
    });
  });

  it("needs no hold for a booking that is already confirmed", async () => {
    const bookingId = await book(await seedDeparture());
    await card(bookingId, 75000);
    expect(await call("public.prepare_payment($1, 31)", [bookingId])).toEqual({
      ok: true,
      hold_expires_at: null,
    });
  });
});

describe("the traveler's booking page", () => {
  it("shows the money, the card fee and the payments, with no contact details", async () => {
    const departureId = await seedDeparture({
      payment_schedule: JSON.stringify([
        { id: "p1", label: "Second payment", due_date: "2099-02-01", amount_cents: 150000 },
      ]),
    });
    const bookingId = await book(departureId);
    await card(bookingId, 75000, 2250);
    const voided = await offline(bookingId, 999);
    await call("public.void_payment($1, $2)", [voided.payment_id, "Mistake"]);
    await credit(bookingId, 10000);

    const { rows } = await db.query<{ reference: string; hash: string }>(
      "select reference, access_token_hash as hash from bookings where id = $1",
      [bookingId],
    );
    const summary = await call<Record<string, unknown>>("public.booking_summary($1, $2)", [
      rows[0]!.reference,
      rows[0]!.hash,
    ]);
    expect(summary).toMatchObject({
      status: "deposit_paid",
      total_cents: 495000,
      discount_cents: 10000,
      paid_cents: 75000,
      price_cents: 495000,
      deposit_cents: 75000,
      balance_due_date: "2099-05-11",
      card_fee_bps: 300,
      departure_open: true,
      payment_schedule: [{ label: "Second payment", amount_cents: 150000 }],
      payments: [{ kind: "deposit", method: "card", amount_cents: 75000, fee_cents: 2250 }],
    });
    expect(JSON.stringify(summary)).not.toMatch(/example\.com|555|staff@/);

    expect(await call("public.booking_lead_email($1, $2)", [rows[0]!.reference, rows[0]!.hash])).toBe(
      "tenzin@example.com",
    );
    expect(await call("public.booking_lead_email($1, $2)", [rows[0]!.reference, "wrong"])).toBeNull();
  });
});

describe("housekeeping and settings", () => {
  it("deletes only holds that expired more than an hour ago", async () => {
    const departureId = await seedDeparture();
    const live = await book(departureId);
    const recent = await book(departureId);
    const old = await book(departureId);
    await expireHold(recent);
    await db.query("update seat_holds set expires_at = now() - interval '2 hours' where booking_id = $1", [
      old,
    ]);
    const before = await count("seat_holds", "departure_id = $1", [departureId]);
    await call<number>("public.delete_expired_holds()", []);
    expect(before).toBe(3);
    expect(await count("seat_holds", "booking_id = $1", [live])).toBe(1);
    expect(await count("seat_holds", "booking_id = $1", [recent])).toBe(1);
    expect(await count("seat_holds", "booking_id = $1", [old])).toBe(0);
  });

  it("starts the card fee at 3 percent", async () => {
    const { rows } = await db.query("select value from settings where key = 'card_fee_bps'");
    expect(rows).toEqual([{ value: 300 }]);
  });
});

describe("who may touch money", () => {
  const calls = [
    "select public.apply_booking_money('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b')",
    "select public.record_card_payment('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'cs', 'pi', 100, 0)",
    "select public.record_card_refund('pi', 're', 100)",
    "select public.record_offline_payment('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'wire', 100, null, null, 'x')",
    "select public.void_payment('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'x')",
    "select public.add_booking_adjustment('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 100, 'x', 'x')",
    "select public.prepare_payment('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 31)",
    "select public.delete_expired_holds()",
    "select public.booking_lead_email('AA-2222', 'x')",
  ];

  it("refuses the public and signed-in accounts, staff included, on every money function", async () => {
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

  it("lets staff read settings and credits but never write them; the public sees nothing", async () => {
    await expect(
      as(db, { role: "anon" }, () => db.query("select * from settings")),
    ).rejects.toThrow(/permission denied/);
    const staff = { role: "authenticated" as const, email: "admin@adventure-access.com" };
    const read = await as(db, staff, () => db.query("select key from settings"));
    expect(read.rows).toEqual([{ key: "card_fee_bps" }]);
    await expect(
      as(db, staff, () => db.query("update settings set value = '0' where key = 'card_fee_bps'")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, staff, () =>
        db.query(
          "insert into booking_adjustments (booking_id, amount_cents, reason, created_by) values (gen_random_uuid(), 1, 'x', 'x')",
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
