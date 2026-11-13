import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { as, createDatabase } from "./harness";

/**
 * Traveler documents and the waiver: what a booking is asked for, recording
 * uploads, signing, and who may see or change any of it.
 */

let db: PGlite;
let tripId: string;
let policyId: string;
let waiverId: string;

const SHA = "a".repeat(64);

async function seedWaiver(version: number, published = true): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into waiver_versions (title, version, file_name, file_base64, file_sha256, byte_size, published_at)
     values ('Travel Consent', $1, 'consent.pdf', 'JVBERi0=', $2, 6, $3) returning id`,
    [version, SHA, published ? new Date().toISOString() : null],
  );
  return rows[0]!.id;
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
    waiver_version_id: waiverId,
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

interface Booked {
  bookingId: string;
  reference: string;
  hash: string;
  travelers: string[];
}

async function book(departureId: string, size = 1): Promise<Booked> {
  const hash = "hash-" + Math.random().toString(36).slice(2);
  const travelers = Array.from({ length: size }, (_, i) => ({
    first_name: i === 0 ? "Tenzin" : `Child${i}`,
    last_name: "Norbu",
    email: i === 0 ? "tenzin@example.com" : "",
    phone: i === 0 ? "+1 555 0100" : "",
    is_lead: i === 0,
    answers: {},
  }));
  const { rows } = await db.query<{ r: { booking_id: string; reference: string } }>(
    `select public.create_booking($1, null, $2, $3::jsonb, $4, null, 'vitest', 'web') as r`,
    [departureId, policyId, JSON.stringify(travelers), hash],
  );
  const bookingId = rows[0]!.r.booking_id;
  const ids = await db.query<{ id: string }>(
    "select id from travelers where booking_id = $1 order by is_lead desc, created_at, id",
    [bookingId],
  );
  return { bookingId, reference: rows[0]!.r.reference, hash, travelers: ids.rows.map((r) => r.id) };
}

async function call<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await db.query<{ r: T }>(`select ${sql} as r`, params);
  return rows[0]!.r;
}

type Result = { ok: boolean; reason?: string; document_id?: string; signed_at?: string };

const record = (b: Booked, travelerId: string, kind: string, fileId = "drive-file-1") =>
  call<Result>("public.record_document($1, $2, $3, $4::public.document_kind, $5, $6)", [
    b.reference,
    b.hash,
    travelerId,
    kind,
    fileId,
    "AA-TEST_passport.pdf",
  ]);
const sign = (b: Booked, travelerId: string, waiver = waiverId, name = "Tenzin Norbu") =>
  call<Result>("public.sign_waiver($1, $2, $3, $4, $5, $6::inet, $7)", [
    b.reference,
    b.hash,
    travelerId,
    waiver,
    name,
    "203.0.113.7",
    "vitest",
  ]);

interface Docs {
  required: string[];
  waiver: { id: string; version: number; title: string } | null;
  travelers: {
    id: string;
    first_name: string;
    is_lead: boolean;
    documents: Record<string, { status: string; note: string | null }>;
    waiver_signed_at: string | null;
  }[];
}
const docs = (b: Booked, hash = b.hash) =>
  call<Docs | null>("public.booking_documents($1, $2)", [b.reference, hash]);

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
  waiverId = await seedWaiver(1);
  await db.exec("insert into staff (email, role) values ('admin@adventure-access.com', 'admin')");
}, 60_000);

describe("what a booking is asked for", () => {
  it("asks for insurance and a passport by default, plus the attached waiver", async () => {
    const b = await book(await seedDeparture(), 2);
    const result = await docs(b);
    expect(result).toMatchObject({
      required: ["insurance", "passport"],
      waiver: { id: waiverId, version: 1, title: "Travel Consent" },
    });
    expect(result!.travelers).toHaveLength(2);
    expect(result!.travelers[0]).toMatchObject({
      first_name: "Tenzin",
      is_lead: true,
      documents: {},
      waiver_signed_at: null,
    });
  });

  it("shows no waiver when none is attached or it is still a draft", async () => {
    const none = await book(await seedDeparture({ waiver_version_id: null }));
    expect((await docs(none))!.waiver).toBeNull();
    const draft = await seedWaiver(50, false);
    const withDraft = await book(await seedDeparture({ waiver_version_id: draft }));
    expect((await docs(withDraft))!.waiver).toBeNull();
  });

  it("needs the booking's own token hash", async () => {
    const b = await book(await seedDeparture());
    expect(await docs(b, "wrong")).toBeNull();
  });

  it("never returns a file or where it is kept", async () => {
    const b = await book(await seedDeparture());
    await record(b, b.travelers[0]!, "passport", "secret-drive-id");
    const text = JSON.stringify(await docs(b));
    expect(text).not.toContain("secret-drive-id");
    expect(text).not.toContain("AA-TEST_passport.pdf");
    expect(text).not.toMatch(/example\.com|555/);
  });
});

describe("recording an upload", () => {
  it("records it as submitted and shows it on the booking", async () => {
    const b = await book(await seedDeparture());
    const result = await record(b, b.travelers[0]!, "insurance");
    expect(result.ok).toBe(true);
    expect((await docs(b))!.travelers[0]!.documents).toMatchObject({
      insurance: { status: "submitted", note: null },
    });
  });

  it("the newest upload of a kind is the one that counts", async () => {
    const b = await book(await seedDeparture());
    const first = await record(b, b.travelers[0]!, "passport", "file-old");
    await db.query(
      `update traveler_documents set status = 'rejected', note = 'Too blurry', reviewed_by = 'staff@adventure-access.com',
       reviewed_at = now(), created_at = now() - interval '1 hour' where id = $1`,
      [first.document_id],
    );
    expect((await docs(b))!.travelers[0]!.documents.passport).toMatchObject({
      status: "rejected",
      note: "Too blurry",
    });
    await record(b, b.travelers[0]!, "passport", "file-new");
    expect((await docs(b))!.travelers[0]!.documents.passport!.status).toBe("submitted");
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from traveler_documents where traveler_id = $1",
      [b.travelers[0]],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it("keeps each traveler's documents separate", async () => {
    const b = await book(await seedDeparture(), 2);
    await record(b, b.travelers[1]!, "passport");
    const result = await docs(b);
    expect(result!.travelers[0]!.documents).toEqual({});
    expect(result!.travelers[1]!.documents.passport!.status).toBe("submitted");
  });

  it("refuses another booking's traveler, a wrong token, a kind not asked for and a canceled booking", async () => {
    const departureId = await seedDeparture({ required_documents: JSON.stringify(["insurance"]) });
    const mine = await book(departureId);
    const theirs = await book(departureId);

    expect(await record(mine, theirs.travelers[0]!, "insurance")).toEqual({
      ok: false,
      reason: "not_your_traveler",
    });
    expect(await record({ ...mine, hash: "wrong" }, mine.travelers[0]!, "insurance")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await record(mine, mine.travelers[0]!, "passport")).toEqual({
      ok: false,
      reason: "not_required",
    });
    await db.query("update bookings set status = 'canceled' where id = $1", [mine.bookingId]);
    expect(await record(mine, mine.travelers[0]!, "insurance")).toEqual({ ok: false, reason: "closed" });

    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from traveler_documents where booking_id in ($1, $2)",
      [mine.bookingId, theirs.bookingId],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("requires a reviewer once a document is accepted or rejected", async () => {
    const b = await book(await seedDeparture());
    const result = await record(b, b.travelers[0]!, "insurance");
    await expect(
      db.query("update traveler_documents set status = 'accepted' where id = $1", [result.document_id]),
    ).rejects.toThrow(/traveler_documents_reviewed/);
  });
});

describe("signing the waiver", () => {
  it("records the typed name, the time and where it came from", async () => {
    const b = await book(await seedDeparture());
    const result = await sign(b, b.travelers[0]!);
    expect(result.ok).toBe(true);
    const { rows } = await db.query(
      `select signed_name, host(ip) as ip, user_agent, waiver_version_id from waiver_acceptances where traveler_id = $1`,
      [b.travelers[0]],
    );
    expect(rows).toEqual([
      { signed_name: "Tenzin Norbu", ip: "203.0.113.7", user_agent: "vitest", waiver_version_id: waiverId },
    ]);
    expect((await docs(b))!.travelers[0]!.waiver_signed_at).not.toBeNull();
  });

  it("keeps the first signature when signed again", async () => {
    const b = await book(await seedDeparture());
    const first = await sign(b, b.travelers[0]!, waiverId, "Tenzin Norbu");
    const again = await sign(b, b.travelers[0]!, waiverId, "Someone Else");
    expect(again).toEqual({ ok: true, signed_at: first.signed_at });
    const { rows } = await db.query<{ signed_name: string }>(
      "select signed_name from waiver_acceptances where traveler_id = $1",
      [b.travelers[0]],
    );
    expect(rows).toEqual([{ signed_name: "Tenzin Norbu" }]);
  });

  it("is per traveler: a parent signs for each child separately", async () => {
    const b = await book(await seedDeparture(), 3);
    await sign(b, b.travelers[0]!);
    await sign(b, b.travelers[2]!, waiverId, "Tenzin Norbu, parent");
    const result = await docs(b);
    expect(result!.travelers.map((t) => t.waiver_signed_at !== null)).toEqual([true, false, true]);
  });

  it("refuses a waiver that is not the one attached, a draft, another booking's traveler and a short name", async () => {
    const other = await seedWaiver(2);
    const b = await book(await seedDeparture());
    const stranger = await book(await seedDeparture());

    expect(await sign(b, b.travelers[0]!, other)).toEqual({ ok: false, reason: "waiver_changed" });
    expect(await sign(b, stranger.travelers[0]!)).toEqual({ ok: false, reason: "not_your_traveler" });
    expect(await sign({ ...b, hash: "wrong" }, b.travelers[0]!)).toEqual({ ok: false, reason: "not_found" });
    await expect(sign(b, b.travelers[0]!, waiverId, "T")).rejects.toThrow(/waiver_acceptances_name_length/);

    const draft = await seedWaiver(51, false);
    const onDraft = await book(await seedDeparture({ waiver_version_id: draft }));
    expect(await sign(onDraft, onDraft.travelers[0]!, draft)).toEqual({
      ok: false,
      reason: "waiver_changed",
    });
  });

  it("asks for a new signature when the departure moves to a new waiver version", async () => {
    const departureId = await seedDeparture();
    const b = await book(departureId);
    await sign(b, b.travelers[0]!);
    const next = await seedWaiver(3);
    await db.query("update departures set waiver_version_id = $1 where id = $2", [next, departureId]);
    expect((await docs(b))!.travelers[0]!.waiver_signed_at).toBeNull();
    expect((await sign(b, b.travelers[0]!, next)).ok).toBe(true);
    expect((await docs(b))!.travelers[0]!.waiver_signed_at).not.toBeNull();
  });
});

describe("waiver versions", () => {
  it("cannot be changed or deleted once published", async () => {
    await expect(
      db.query("update waiver_versions set title = 'Edited' where id = $1", [waiverId]),
    ).rejects.toThrow(/published and cannot be changed/);
    await expect(db.query("delete from waiver_versions where id = $1", [waiverId])).rejects.toThrow(
      /published and cannot be changed/,
    );
  });

  it("can be changed and deleted while a draft", async () => {
    const draft = await seedWaiver(60, false);
    await db.query("update waiver_versions set title = 'Edited' where id = $1", [draft]);
    await db.query("delete from waiver_versions where id = $1", [draft]);
  });

  it("serves the file of a published version only", async () => {
    expect(await call("public.waiver_file($1)", [waiverId])).toEqual({
      file_name: "consent.pdf",
      file_base64: "JVBERi0=",
    });
    const draft = await seedWaiver(61, false);
    expect(await call("public.waiver_file($1)", [draft])).toBeNull();
  });

  it("checks the stored hash and size", async () => {
    await expect(
      db.query(
        `insert into waiver_versions (title, version, file_name, file_base64, file_sha256, byte_size)
         values ('x', 70, 'x.pdf', 'JVBERi0=', 'nothex', 6)`,
      ),
    ).rejects.toThrow(/waiver_versions_sha256/);
    await expect(
      db.query(
        `insert into waiver_versions (title, version, file_name, file_base64, file_sha256, byte_size)
         values ('x', 71, 'x.pdf', 'JVBERi0=', $1, 0)`,
        [SHA],
      ),
    ).rejects.toThrow(/waiver_versions_size/);
  });
});

describe("who may see or change documents", () => {
  const calls = [
    "select public.booking_documents('AA-2222', 'x')",
    "select public.record_document('AA-2222', 'x', '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'passport', 'f', 'n')",
    "select public.sign_waiver('AA-2222', 'x', '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'A B', null, 'x')",
    "select public.waiver_file('3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b')",
  ];

  it("refuses the public and signed-in accounts on every function", async () => {
    for (const sql of calls) {
      await expect(as(db, { role: "anon" }, () => db.query(sql))).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        as(db, { role: "authenticated", email: "admin@adventure-access.com" }, () => db.query(sql)),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("lets staff read the tables but not write them; others see nothing", async () => {
    const b = await book(await seedDeparture());
    await record(b, b.travelers[0]!, "passport");
    await sign(b, b.travelers[0]!);

    for (const table of ["traveler_documents", "waiver_acceptances", "waiver_versions"]) {
      await expect(
        as(db, { role: "anon" }, () => db.query(`select 1 from ${table}`)),
      ).rejects.toThrow(/permission denied/);
      const stranger = await as(db, { role: "authenticated", email: "someone@gmail.com" }, () =>
        db.query(`select 1 from ${table}`),
      );
      expect(stranger.rows).toHaveLength(0);
      const staff = await as(db, { role: "authenticated", email: "admin@adventure-access.com" }, () =>
        db.query(`select 1 from ${table}`),
      );
      expect(staff.rows.length).toBeGreaterThan(0);
      await expect(
        as(db, { role: "authenticated", email: "admin@adventure-access.com" }, () =>
          db.query(`delete from ${table}`),
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
