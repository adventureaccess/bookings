import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { as, createDatabase } from "./harness";

/**
 * The sync queue: which changes add a job, and how the worker claims,
 * finishes, fails and retries them.
 */

let db: PGlite;
let tripId: string;
let policyId: string;

interface Job {
  id: string;
  kind: string;
  template: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  waiting: boolean;
  done: boolean;
  given_up: boolean;
  last_error: string | null;
  minutes: number | null;
}

async function seedDeparture(overrides: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    trip_id: tripId,
    start_date: "2099-07-10",
    end_date: "2099-07-22",
    price_cents: 495000,
    deposit_cents: 75000,
    balance_due_date: "2099-05-11",
    max_travelers: 6,
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

async function book(departureId: string, resume: string | null = null) {
  const hash = "hash-" + Math.random().toString(36).slice(2);
  const travelers = [
    { first_name: "Tenzin", last_name: "Norbu", email: "tenzin@example.com", phone: "+1 555 0100", is_lead: true, answers: {} },
  ];
  const { rows } = await db.query<{ r: { booking_id: string; reference: string } }>(
    `select public.create_booking($1, null, $2, $3::jsonb, $4, null, 'vitest', 'web', $5) as r`,
    [departureId, policyId, JSON.stringify(travelers), hash, resume],
  );
  return { bookingId: rows[0]!.r.booking_id, reference: rows[0]!.r.reference, hash };
}

async function jobs(bookingId: string): Promise<Job[]> {
  const { rows } = await db.query<Job>(
    `select id, kind, payload ->> 'template' as template, payload, attempts,
            (completed_at is null and failed_at is null) as waiting,
            completed_at is not null as done,
            failed_at is not null as given_up,
            last_error,
            round(extract(epoch from (next_run_at - now())) / 60)::int as minutes
     from sync_jobs where booking_id = $1 order by created_at, id`,
    [bookingId],
  );
  return rows;
}

const summary = (list: Job[]) => list.map((j) => (j.kind === "hubspot" ? "hubspot" : j.template)).sort();

/** Marks every job on a booking as done, to start a test from a quiet queue. */
const settle = (bookingId: string) =>
  db.query("update sync_jobs set completed_at = now(), next_run_at = null where booking_id = $1", [bookingId]);

async function claim(kinds: string[], limit = 10): Promise<{ id: string; attempts: number }[]> {
  const { rows } = await db.query<{ id: string; attempts: number }>(
    "select id, attempts from public.claim_sync_jobs($1::public.sync_job_kind[], $2)",
    [`{${kinds.join(",")}}`, limit],
  );
  return rows;
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

describe("what adds a job", () => {
  it("a new booking: one HubSpot sync and a note to staff", async () => {
    const { bookingId } = await book(await seedDeparture());
    const list = await jobs(bookingId);
    expect(summary(list)).toEqual(["hubspot", "staff_new_booking"]);
    expect(list.every((j) => j.waiting && j.attempts === 0)).toBe(true);
  });

  it("several changes before the worker runs still mean one HubSpot sync", async () => {
    const { bookingId } = await book(await seedDeparture());
    await db.query("select public.record_offline_payment($1, 'wire', 10000, null, null, 'staff@adventure-access.com')", [bookingId]);
    await db.query("select public.add_booking_adjustment($1, 5000, 'Credit', 'staff@adventure-access.com')", [bookingId]);
    expect((await jobs(bookingId)).filter((j) => j.kind === "hubspot")).toHaveLength(1);
  });

  it("a deposit: thanks the traveler, tells staff, confirms the place and syncs HubSpot", async () => {
    const { bookingId } = await book(await seedDeparture());
    await settle(bookingId);
    await db.query("select public.record_card_payment($1, 'cs_sync_1', 'pi_sync_1', 75000, 2250)", [bookingId]);
    const added = (await jobs(bookingId)).filter((j) => j.waiting);
    expect(summary(added)).toEqual([
      "hubspot",
      "staff_payment_received",
      "traveler_booking_confirmed",
      "traveler_payment_received",
    ]);
    // The amount is what the trip received, without the card fee.
    expect(added.find((j) => j.template === "traveler_payment_received")?.payload.amount_cents).toBe(75000);
  });

  it("a later payment: a receipt and a note, but no second confirmation", async () => {
    const { bookingId } = await book(await seedDeparture());
    await db.query("select public.record_offline_payment($1, 'wire', 75000, null, null, 'staff@adventure-access.com')", [bookingId]);
    await settle(bookingId);
    await db.query("select public.record_offline_payment($1, 'wire', 100000, null, null, 'staff@adventure-access.com')", [bookingId]);
    const added = (await jobs(bookingId)).filter((j) => j.waiting);
    expect(summary(added)).toEqual(["hubspot", "staff_payment_received", "traveler_payment_received"]);
    expect(added.find((j) => j.template === "staff_payment_received")?.payload.amount_cents).toBe(100000);
  });

  it("a replayed card payment adds nothing", async () => {
    const { bookingId } = await book(await seedDeparture());
    await db.query("select public.record_card_payment($1, 'cs_sync_replay', 'pi_r', 75000, 0)", [bookingId]);
    await settle(bookingId);
    await db.query("select public.record_card_payment($1, 'cs_sync_replay', 'pi_r', 75000, 0)", [bookingId]);
    expect((await jobs(bookingId)).filter((j) => j.waiting)).toHaveLength(0);
  });

  it("a voided payment syncs HubSpot but sends no receipt", async () => {
    const { bookingId } = await book(await seedDeparture());
    const paid = await db.query<{ r: { payment_id: string } }>(
      "select public.record_offline_payment($1, 'wire', 75000, null, null, 'staff@adventure-access.com') as r",
      [bookingId],
    );
    await settle(bookingId);
    await db.query("select public.void_payment($1, 'Mistake')", [paid.rows[0]!.r.payment_id]);
    expect(summary((await jobs(bookingId)).filter((j) => j.waiting))).toEqual(["hubspot"]);
  });

  it("a credit syncs HubSpot only", async () => {
    const { bookingId } = await book(await seedDeparture());
    await settle(bookingId);
    await db.query("select public.add_booking_adjustment($1, 5000, 'Credit', 'staff@adventure-access.com')", [bookingId]);
    expect(summary((await jobs(bookingId)).filter((j) => j.waiting))).toEqual(["hubspot"]);
  });

  it("resubmitting the form syncs HubSpot again, for the changed travelers", async () => {
    const departureId = await seedDeparture();
    const { bookingId } = await book(departureId);
    await settle(bookingId);
    await book(departureId, bookingId);
    expect(summary((await jobs(bookingId)).filter((j) => j.waiting))).toEqual(["hubspot"]);
  });

  it("writing the HubSpot deal ID back does not start another sync", async () => {
    const { bookingId } = await book(await seedDeparture());
    await settle(bookingId);
    await db.query("update bookings set hubspot_deal_id = '12345' where id = $1", [bookingId]);
    await db.query("update bookings set needs_attention = true where id = $1", [bookingId]);
    expect((await jobs(bookingId)).filter((j) => j.waiting)).toHaveLength(0);
  });

  it("a document handed in tells staff which kind, and nothing about the file", async () => {
    const { bookingId, reference, hash } = await book(await seedDeparture());
    await settle(bookingId);
    const traveler = await db.query<{ id: string }>("select id from travelers where booking_id = $1", [bookingId]);
    await db.query(
      "select public.record_document($1, $2, $3, 'passport', 'drive-secret-id', 'AA-X_passport.pdf')",
      [reference, hash, traveler.rows[0]!.id],
    );
    const added = (await jobs(bookingId)).filter((j) => j.waiting);
    expect(added.map((j) => j.payload)).toEqual([
      { template: "staff_document_received", document_kind: "passport" },
    ]);
  });

  it("a booking link email carries its link, for two templates only", async () => {
    const { bookingId } = await book(await seedDeparture());
    await settle(bookingId);
    await db.query("select public.enqueue_booking_link_email($1, 'traveler_registered', 'https://book.example/booking/AA-2222?t=secret')", [bookingId]);
    const added = (await jobs(bookingId)).filter((j) => j.waiting);
    expect(added[0]?.payload).toEqual({
      template: "traveler_registered",
      url: "https://book.example/booking/AA-2222?t=secret",
    });
    await expect(
      db.query("select public.enqueue_booking_link_email($1, 'staff_new_booking', 'https://x.example')", [bookingId]),
    ).rejects.toThrow(/unknown link template/);
  });
});

describe("the worker", () => {
  it("claims waiting jobs of the kinds asked for, counts the attempt and pushes the next run out", async () => {
    const { bookingId } = await book(await seedDeparture());
    const before = await jobs(bookingId);
    const hubspot = before.find((j) => j.kind === "hubspot")!;

    const claimed = await claim(["hubspot"]);
    expect(claimed.map((j) => j.id)).toContain(hubspot.id);
    const after = (await jobs(bookingId)).find((j) => j.id === hubspot.id)!;
    expect(after).toMatchObject({ attempts: 1, waiting: true, minutes: 2 });
    // The email job was not asked for, so it was left alone.
    expect((await jobs(bookingId)).find((j) => j.kind === "email")).toMatchObject({ attempts: 0 });
    // Claimed and not yet due again: a second worker gets nothing.
    expect((await claim(["hubspot"])).map((j) => j.id)).not.toContain(hubspot.id);
  });

  it("respects the limit", async () => {
    await db.query("update sync_jobs set completed_at = now(), next_run_at = null");
    for (let i = 0; i < 3; i++) await book(await seedDeparture());
    expect(await claim(["hubspot", "email"], 2)).toHaveLength(2);
    expect(await claim(["hubspot", "email"], 0)).toHaveLength(0);
  });

  it("finishing a job removes the booking link from it", async () => {
    const { bookingId } = await book(await seedDeparture());
    await settle(bookingId);
    await db.query("select public.enqueue_booking_link_email($1, 'traveler_registered', 'https://book.example/booking/AA-2222?t=secret')", [bookingId]);
    const job = (await jobs(bookingId)).find((j) => j.waiting && j.template === "traveler_registered");
    expect((await claim(["email"], 100)).map((j) => j.id)).toContain(job!.id);
    await db.query("select public.complete_sync_job($1)", [job!.id]);
    const done = (await jobs(bookingId)).find((j) => j.id === job!.id)!;
    expect(done).toMatchObject({ done: true, waiting: false, minutes: null });
    expect(done.payload).toEqual({ template: "traveler_registered" });
    expect(JSON.stringify(done)).not.toContain("secret");
  });

  it("a failed job waits longer each time, then is given up and staff are told once", async () => {
    const { bookingId } = await book(await seedDeparture());
    await db.query("delete from sync_jobs where booking_id = $1 and kind = 'email'", [bookingId]);
    const id = (await jobs(bookingId))[0]!.id;
    const waits: (number | null)[] = [];
    let gaveUp = false;

    for (let attempt = 1; attempt <= 6; attempt++) {
      await db.query("update sync_jobs set next_run_at = now() where id = $1", [id]);
      const claimed = await claim(["hubspot"]);
      expect(claimed.find((j) => j.id === id)?.attempts).toBe(attempt);
      waits.push((await jobs(bookingId)).find((j) => j.id === id)!.minutes);
      const { rows } = await db.query<{ gave_up: boolean }>(
        "select public.fail_sync_job($1, $2, 6) as gave_up",
        [id, `HubSpot answered 500 (attempt ${attempt})`],
      );
      gaveUp = rows[0]!.gave_up;
      if (attempt < 6) expect(gaveUp).toBe(false);
    }

    expect(waits).toEqual([2, 10, 30, 120, 360, 720]);
    expect(gaveUp).toBe(true);
    const list = await jobs(bookingId);
    expect(list.find((j) => j.id === id)).toMatchObject({
      given_up: true,
      waiting: false,
      attempts: 6,
      last_error: "HubSpot answered 500 (attempt 6)",
    });
    expect(list.filter((j) => j.template === "staff_sync_failed").map((j) => j.payload)).toEqual([
      { template: "staff_sync_failed", failed_kind: "hubspot", failed_template: null },
    ]);
    // A given-up job is not claimed again.
    expect((await claim(["hubspot"])).map((j) => j.id)).not.toContain(id);
  });

  it("does not send a failure notice about a failure notice", async () => {
    const { bookingId } = await book(await seedDeparture());
    await db.query("delete from sync_jobs where booking_id = $1", [bookingId]);
    const inserted = await db.query<{ id: string }>(
      `insert into sync_jobs (kind, booking_id, payload, attempts)
       values ('email', $1, '{"template": "staff_sync_failed"}', 6) returning id`,
      [bookingId],
    );
    await db.query("select public.fail_sync_job($1, 'Resend answered 500', 6)", [inserted.rows[0]!.id]);
    expect(await jobs(bookingId)).toHaveLength(1);
  });

  it("a retry by staff starts a given-up job again from zero", async () => {
    const { bookingId } = await book(await seedDeparture());
    const id = (await jobs(bookingId)).find((j) => j.kind === "hubspot")!.id;
    await db.query("update sync_jobs set attempts = 6, failed_at = now(), next_run_at = null where id = $1", [id]);
    const { rows } = await db.query<{ ok: boolean }>("select public.retry_sync_job($1) as ok", [id]);
    expect(rows[0]!.ok).toBe(true);
    expect((await jobs(bookingId)).find((j) => j.id === id)).toMatchObject({
      attempts: 0,
      waiting: true,
      given_up: false,
    });
    expect((await claim(["hubspot"])).map((j) => j.id)).toContain(id);

    // A finished job cannot be retried.
    await db.query("select public.complete_sync_job($1)", [id]);
    expect((await db.query<{ ok: boolean }>("select public.retry_sync_job($1) as ok", [id])).rows[0]!.ok).toBe(false);
  });

  it("keeps an error message short", async () => {
    const { bookingId } = await book(await seedDeparture());
    const id = (await jobs(bookingId))[0]!.id;
    await db.query("select public.fail_sync_job($1, $2, 6)", [id, "x".repeat(1000)]);
    expect((await jobs(bookingId)).find((j) => j.id === id)!.last_error).toHaveLength(300);
  });
});

describe("who may touch the queue", () => {
  const calls = [
    "select public.enqueue_sync_job('hubspot', null, '{}'::jsonb)",
    "select public.enqueue_booking_link_email('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'traveler_registered', 'https://x.example')",
    "select * from public.claim_sync_jobs('{hubspot}'::public.sync_job_kind[], 1)",
    "select public.complete_sync_job('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b')",
    "select public.fail_sync_job('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'x', 6)",
    "select public.retry_sync_job('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b')",
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

  it("works for the service role, triggers included", async () => {
    const departureId = await seedDeparture();
    const result = await as(db, { role: "service_role" }, async () => {
      const { rows } = await db.query<{ r: { ok: boolean; booking_id: string } }>(
        `select public.create_booking($1, null, $2, $3::jsonb, 'hash-service', null, 'vitest', 'web') as r`,
        [
          departureId,
          policyId,
          JSON.stringify([
            { first_name: "Pema", last_name: "Lhamo", email: "pema@example.com", phone: "+1 555 0199", is_lead: true, answers: {} },
          ]),
        ],
      );
      await db.query("select * from public.claim_sync_jobs('{hubspot,email}'::public.sync_job_kind[], 1)");
      return rows[0]!.r;
    });
    expect(result.ok).toBe(true);
    expect((await jobs(result.booking_id)).length).toBe(2);
  });
});
