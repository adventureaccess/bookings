import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import type { OutgoingEmail } from "../../src/lib/email/resend";
import { HubSpotError, type HubSpotClient } from "../../src/lib/hubspot/client";
import type { HubSpotConfig, SyncResult } from "../../src/lib/hubspot/sync";
import {
  MAX_ATTEMPTS,
  runSyncJobs,
  type JobKind,
  type SyncJob,
  type WorkerBooking,
  type WorkerDeps,
} from "../../src/lib/sync/worker";
import { createDatabase } from "./harness";

/**
 * The real worker on the real queue: jobs are added by the database
 * triggers, claimed and finished through the SQL functions, and sent to a
 * stand-in HubSpot and a stand-in email service. This is the milestone's
 * acceptance test in miniature: a booking becomes a deal with its travelers
 * linked, and a forced HubSpot failure is retried and then succeeds.
 */

let db: PGlite;
let tripId: string;
let policyId: string;

const config: HubSpotConfig = {
  pipeline_id: "default",
  stages: {
    pending: "contractsent",
    deposit_paid: "closedwon",
    paid_in_full: "closedwon",
    canceled: "closedlost",
    refunded: "closedlost",
  },
};

/** A HubSpot kept in memory, which can be told to fail. */
function standInHubSpot() {
  const state = {
    failNext: 0,
    contacts: new Map<string, Record<string, string>>(),
    deals: new Map<string, Record<string, string>>(),
    links: new Set<string>(),
    next: 1,
  };
  const client: HubSpotClient = {
    dealPropertyNames: async () => new Set(["dealname", "amount", "pipeline", "dealstage", "booking_reference", "amount_paid"]),
    dealPipelines: async () => [],
    findContactByEmail: async (email) => {
      for (const [id, properties] of state.contacts) {
        if (properties.email === email) return { id, properties };
      }
      return null;
    },
    createContact: async (properties) => {
      const id = `c${state.next++}`;
      state.contacts.set(id, properties);
      return id;
    },
    updateContact: async (id, properties) => {
      state.contacts.set(id, { ...state.contacts.get(id), ...properties });
    },
    createDeal: async (properties) => {
      if (state.failNext > 0) {
        state.failNext -= 1;
        throw new HubSpotError(502, null, "creating a deal");
      }
      const id = `d${state.next++}`;
      state.deals.set(id, properties);
      return id;
    },
    updateDeal: async (id, properties) => {
      if (!state.deals.has(id)) return false;
      state.deals.set(id, properties);
      return true;
    },
    associateDealWithContact: async (dealId, contactId) => {
      state.links.add(`${dealId}:${contactId}`);
    },
  };
  return { client, state };
}

/** Worker dependencies backed by the test database's own queue functions. */
function deps(hubspot: HubSpotClient | null, sent: OutgoingEmail[]): WorkerDeps {
  return {
    hubspot: hubspot ? { client: hubspot, config } : null,
    email: {
      send: async (email) => {
        sent.push(email);
      },
      from: "Adventure Access <bookings@mail.adventure-access.com>",
      staffTo: "info@adventure-access.com",
    },
    origin: "https://book.adventure-access.com",
    claim: async (kinds: JobKind[], limit: number) => {
      const { rows } = await db.query<SyncJob>(
        "select id, kind, booking_id, payload, attempts from public.claim_sync_jobs($1::public.sync_job_kind[], $2)",
        [`{${kinds.join(",")}}`, limit],
      );
      return rows;
    },
    complete: async (jobId) => {
      await db.query("select public.complete_sync_job($1)", [jobId]);
    },
    fail: async (jobId, error, max) => {
      const { rows } = await db.query<{ gave_up: boolean }>(
        "select public.fail_sync_job($1, $2, $3) as gave_up",
        [jobId, error, max],
      );
      return rows[0]!.gave_up;
    },
    loadBooking: async (bookingId): Promise<WorkerBooking | null> => {
      const { rows } = await db.query<Omit<WorkerBooking, "travelers">>(
        `select b.id, b.reference, b.status, b.traveler_count, b.total_cents, b.discount_cents, b.paid_cents,
                b.hubspot_deal_id, t.title as trip_title, t.slug as trip_slug,
                d.start_date::text as start_date, d.end_date::text as end_date,
                d.balance_due_date::text as balance_due_date, d.group_name,
                lead.first_name as lead_first_name,
                lead.first_name || ' ' || lead.last_name as lead_name, lead.email as lead_email
         from bookings b
         join departures d on d.id = b.departure_id
         join trips t on t.id = d.trip_id
         join travelers lead on lead.id = b.lead_traveler_id
         where b.id = $1`,
        [bookingId],
      );
      if (!rows[0]) return null;
      const travelers = await db.query<WorkerBooking["travelers"][number]>(
        "select id, first_name, last_name, email, phone, is_lead from travelers where booking_id = $1",
        [bookingId],
      );
      return { ...rows[0], travelers: travelers.rows };
    },
    saveHubSpotIds: async (bookingId, result: SyncResult) => {
      await db.query("update bookings set hubspot_deal_id = $1 where id = $2", [result.dealId, bookingId]);
      for (const [travelerId, contactId] of Object.entries(result.contactIds)) {
        await db.query("update travelers set hubspot_contact_id = $1 where id = $2", [contactId, travelerId]);
      }
    },
  };
}

async function bookFamily(): Promise<{ bookingId: string; reference: string }> {
  const departure = await db.query<{ id: string }>(
    `insert into departures (trip_id, start_date, end_date, price_cents, deposit_cents, balance_due_date, max_travelers, policy_version_id)
     values ($1, '2099-07-10', '2099-07-22', 495000, 75000, '2099-05-11', 6, $2) returning id`,
    [tripId, policyId],
  );
  const travelers = [
    { first_name: "Tenzin", last_name: "Norbu", email: "tenzin@example.com", phone: "+1 555 0100", is_lead: true, answers: {} },
    { first_name: "Pema", last_name: "Norbu", email: "pema@example.com", phone: "", is_lead: false, answers: {} },
    { first_name: "Dawa", last_name: "Norbu", email: "", phone: "", is_lead: false, answers: {} },
  ];
  const { rows } = await db.query<{ r: { booking_id: string; reference: string } }>(
    `select public.create_booking($1, null, $2, $3::jsonb, $4, null, 'vitest', 'web') as r`,
    [departure.rows[0]!.id, policyId, JSON.stringify(travelers), "hash-" + Math.random().toString(36).slice(2)],
  );
  return { bookingId: rows[0]!.r.booking_id, reference: rows[0]!.r.reference };
}

const makeDue = () => db.query("update sync_jobs set next_run_at = now() where completed_at is null and failed_at is null");
const openJobs = async () =>
  (await db.query<{ n: number }>("select count(*)::int as n from sync_jobs where completed_at is null and failed_at is null")).rows[0]!.n;

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

describe("a booking reaching HubSpot and the inbox", () => {
  it("appears as one deal with every traveler who has an email linked to it", async () => {
    const hubspot = standInHubSpot();
    const sent: OutgoingEmail[] = [];
    const { bookingId, reference } = await bookFamily();

    const report = await runSyncJobs(deps(hubspot.client, sent));
    expect(report).toMatchObject({ failed: 0, gaveUp: 0 });
    expect(await openJobs()).toBe(0);

    expect(hubspot.state.deals.size).toBe(1);
    const [dealId, deal] = [...hubspot.state.deals.entries()][0]!;
    expect(deal).toMatchObject({
      amount: "14850.00",
      pipeline: "default",
      dealstage: "contractsent",
      booking_reference: reference,
      amount_paid: "0.00",
    });
    // Tenzin and Pema have emails and are linked. Dawa has none and is skipped.
    expect([...hubspot.state.contacts.values()].map((c) => c.email).sort()).toEqual([
      "pema@example.com",
      "tenzin@example.com",
    ]);
    expect(hubspot.state.links.size).toBe(2);
    expect([...hubspot.state.links].every((link) => link.startsWith(`${dealId}:`))).toBe(true);

    const saved = await db.query<{ hubspot_deal_id: string; contacts: number }>(
      `select b.hubspot_deal_id,
              (select count(*)::int from travelers t where t.booking_id = b.id and t.hubspot_contact_id is not null) as contacts
       from bookings b where b.id = $1`,
      [bookingId],
    );
    expect(saved.rows[0]).toEqual({ hubspot_deal_id: dealId, contacts: 2 });

    // Saving the deal ID did not queue another sync.
    expect(await openJobs()).toBe(0);
    expect(sent.map((e) => e.to)).toEqual(["info@adventure-access.com"]);
    expect(sent[0]?.subject).toContain(`New registration: Tenzin Norbu`);
  });

  it("a forced HubSpot failure is retried and then succeeds, leaving one deal", async () => {
    const hubspot = standInHubSpot();
    hubspot.state.failNext = 2;
    const sent: OutgoingEmail[] = [];
    const { bookingId } = await bookFamily();
    const d = deps(hubspot.client, sent);

    const first = await runSyncJobs(d);
    expect(first.failed).toBe(1);
    const afterFirst = await db.query<{ attempts: number; last_error: string; minutes: number }>(
      `select attempts, last_error, round(extract(epoch from (next_run_at - now())) / 60)::int as minutes
       from sync_jobs where booking_id = $1 and kind = 'hubspot'`,
      [bookingId],
    );
    expect(afterFirst.rows[0]).toEqual({
      attempts: 1,
      last_error: "HubSpot creating a deal failed with status 502",
      minutes: 2,
    });
    expect(hubspot.state.deals.size).toBe(0);

    // Before its next run is due, nothing happens.
    expect((await runSyncJobs(d)).failed).toBe(0);

    await makeDue();
    expect((await runSyncJobs(d)).failed).toBe(1);
    await makeDue();
    const third = await runSyncJobs(d);
    expect(third).toMatchObject({ done: 1, failed: 0, gaveUp: 0 });

    expect(hubspot.state.deals.size).toBe(1);
    // The contacts made on the failed tries were found again, not doubled.
    expect(hubspot.state.contacts.size).toBe(2);
    const job = await db.query<{ attempts: number; done: boolean; last_error: string | null }>(
      `select attempts, completed_at is not null as done, last_error
       from sync_jobs where booking_id = $1 and kind = 'hubspot'`,
      [bookingId],
    );
    expect(job.rows[0]).toEqual({ attempts: 3, done: true, last_error: null });
  });

  it("a later payment moves the same deal to its new stage and amount", async () => {
    const hubspot = standInHubSpot();
    const sent: OutgoingEmail[] = [];
    const { bookingId } = await bookFamily();
    const d = deps(hubspot.client, sent);
    await runSyncJobs(d);
    sent.length = 0;

    await db.query("select public.record_card_payment($1, $2, 'pi_w', 225000, 6750)", [bookingId, `cs_${bookingId}`]);
    await runSyncJobs(d);

    expect(hubspot.state.deals.size).toBe(1);
    expect([...hubspot.state.deals.values()][0]).toMatchObject({
      dealstage: "closedwon",
      amount_paid: "2250.00",
    });
    expect(sent.map((e) => [e.to, e.subject.split(":")[0]]).sort()).toEqual([
      ["info@adventure-access.com", "Payment"],
      ["tenzin@example.com", "Payment received"],
      ["tenzin@example.com", "Your place is confirmed"],
    ]);
  });

  it("gives up after the last try, tells staff once, and a staff retry gets it through", async () => {
    const hubspot = standInHubSpot();
    hubspot.state.failNext = 999;
    const sent: OutgoingEmail[] = [];
    const { bookingId, reference } = await bookFamily();
    const d = deps(hubspot.client, sent);

    let gaveUp = 0;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await makeDue();
      gaveUp += (await runSyncJobs(d)).gaveUp;
    }
    expect(gaveUp).toBe(1);
    await makeDue();
    await runSyncJobs(d); // sends the notice queued when the job was given up

    const notices = sent.filter((e) => e.subject.startsWith("Needs a look"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.subject).toBe(`Needs a look: sync failed for ${reference}`);
    expect(notices[0]?.to).toBe("info@adventure-access.com");

    hubspot.state.failNext = 0;
    const job = await db.query<{ id: string }>(
      "select id from sync_jobs where booking_id = $1 and kind = 'hubspot'",
      [bookingId],
    );
    await db.query("select public.retry_sync_job($1)", [job.rows[0]!.id]);
    expect((await runSyncJobs(d)).done).toBe(1);
    expect(hubspot.state.deals.size).toBe(1);
  });

  it("the booking link is sent once and then removed from the stored job", async () => {
    const sent: OutgoingEmail[] = [];
    const { bookingId, reference } = await bookFamily();
    const url = `https://book.adventure-access.com/booking/${reference}?t=the-secret-token`;
    await db.query("select public.enqueue_booking_link_email($1, 'traveler_registered', $2)", [bookingId, url]);

    await runSyncJobs(deps(null, sent));
    const email = sent.find((e) => e.to === "tenzin@example.com");
    expect(email?.text).toContain(url);

    const stored = await db.query<{ payload: unknown }>(
      "select payload from sync_jobs where booking_id = $1 and payload ->> 'template' = 'traveler_registered'",
      [bookingId],
    );
    expect(stored.rows[0]?.payload).toEqual({ template: "traveler_registered" });
    const anywhere = await db.query<{ n: number }>(
      "select count(*)::int as n from sync_jobs where payload::text like '%the-secret-token%'",
    );
    expect(anywhere.rows[0]!.n).toBe(0);
  });

  it("HubSpot jobs wait, untouched, while HubSpot is not set up", async () => {
    const sent: OutgoingEmail[] = [];
    const { bookingId } = await bookFamily();
    const report = await runSyncJobs(deps(null, sent));
    expect(report.waitingOnSetup).toEqual(["hubspot"]);
    const job = await db.query<{ attempts: number; waiting: boolean }>(
      `select attempts, (completed_at is null and failed_at is null) as waiting
       from sync_jobs where booking_id = $1 and kind = 'hubspot'`,
      [bookingId],
    );
    expect(job.rows[0]).toEqual({ attempts: 0, waiting: true });
  });
});
