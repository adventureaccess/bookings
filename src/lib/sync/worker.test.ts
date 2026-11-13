import { describe, expect, it } from "vitest";
import { createResendSender, EmailError, type OutgoingEmail } from "../email/resend";
import { EMAIL_TEMPLATES, renderEmail, type EmailBooking } from "../email/templates";
import { HubSpotError, type HubSpotClient } from "../hubspot/client";
import type { HubSpotConfig } from "../hubspot/sync";
import { MAX_ATTEMPTS, runSyncJobs, type SyncJob, type WorkerBooking, type WorkerDeps } from "./worker";

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

const booking: WorkerBooking = {
  id: "b-1",
  reference: "AA-7K3Q",
  status: "deposit_paid",
  traveler_count: 1,
  total_cents: 495000,
  discount_cents: 0,
  paid_cents: 75000,
  hubspot_deal_id: null,
  trip_title: "Ladakh Multisport",
  trip_slug: "ladakh-multisport",
  start_date: "2027-07-10",
  end_date: "2027-07-22",
  balance_due_date: "2027-05-11",
  lead_first_name: "Tenzin",
  lead_name: "Tenzin Norbu",
  lead_email: "tenzin@example.com",
  group_name: null,
  travelers: [
    { id: "t-1", first_name: "Tenzin", last_name: "Norbu", email: "tenzin@example.com", phone: null, is_lead: true },
  ],
};

/** A HubSpot that fails its first `failTimes` deal creations. */
function fakeHubSpot(failTimes = 0): { client: HubSpotClient; deals: number; failures: number } {
  const state = { deals: 0, failures: failTimes };
  const client: HubSpotClient = {
    dealPropertyNames: async () => new Set(["dealname", "amount", "pipeline", "dealstage"]),
    dealPipelines: async () => [],
    findContactByEmail: async () => null,
    createContact: async () => "c-1",
    updateContact: async () => {},
    createDeal: async () => {
      if (state.failures > 0) {
        state.failures -= 1;
        throw new HubSpotError(500, null, "creating a deal");
      }
      state.deals += 1;
      return "d-1";
    },
    updateDeal: async () => true,
    associateDealWithContact: async () => {},
  };
  return {
    client,
    get deals() {
      return state.deals;
    },
    get failures() {
      return state.failures;
    },
  };
}

/** An in-memory queue with the same rules as the database one. */
function fakeQueue(initial: Partial<SyncJob>[]) {
  const jobs = initial.map((job, i) => ({
    id: `j-${i + 1}`,
    kind: "hubspot" as const,
    booking_id: "b-1",
    payload: {},
    attempts: 0,
    due: true,
    done: false,
    gaveUp: false,
    error: null as string | null,
    ...job,
  }));
  return {
    jobs,
    /** Makes every unfinished job due again, as time passing would. */
    tick: () => jobs.forEach((j) => (j.due = !j.done && !j.gaveUp)),
    claim: async (kinds: string[], limit: number) => {
      const taken = jobs.filter((j) => j.due && !j.done && !j.gaveUp && kinds.includes(j.kind)).slice(0, limit);
      for (const job of taken) {
        job.attempts += 1;
        job.due = false;
      }
      return taken.map(({ id, kind, booking_id, payload, attempts }) => ({ id, kind, booking_id, payload, attempts }));
    },
    complete: async (id: string) => {
      jobs.find((j) => j.id === id)!.done = true;
    },
    fail: async (id: string, error: string, max: number) => {
      const job = jobs.find((j) => j.id === id)!;
      job.error = error;
      job.gaveUp = job.attempts >= max;
      return job.gaveUp;
    },
  };
}

function deps(overrides: Partial<WorkerDeps>, queue: ReturnType<typeof fakeQueue>): WorkerDeps & { sent: OutgoingEmail[]; saved: string[] } {
  const sent: OutgoingEmail[] = [];
  const saved: string[] = [];
  return {
    hubspot: null,
    email: {
      send: async (email) => {
        sent.push(email);
      },
      from: "Adventure Access <bookings@mail.adventure-access.com>",
      staffTo: "info@adventure-access.com",
    },
    origin: "https://book.adventure-access.com",
    claim: queue.claim,
    complete: queue.complete,
    fail: queue.fail,
    loadBooking: async () => booking,
    saveHubSpotIds: async (_id, result) => {
      saved.push(result.dealId);
    },
    sent,
    saved,
    ...overrides,
  };
}

describe("runSyncJobs", () => {
  it("sends a booking to HubSpot and saves the deal ID", async () => {
    const queue = fakeQueue([{}]);
    const hubspot = fakeHubSpot();
    const d = deps({ hubspot: { client: hubspot.client, config } }, queue);
    const report = await runSyncJobs(d);
    expect(report).toMatchObject({ done: 1, failed: 0, gaveUp: 0, waitingOnSetup: [] });
    expect(d.saved).toEqual(["d-1"]);
    expect(queue.jobs[0]).toMatchObject({ done: true, attempts: 1 });
    // Custom properties this portal lacks are reported, not fatal.
    expect(report.missingProperties).toContain("booking_reference");
  });

  it("a forced HubSpot failure is retried and then succeeds, with one deal", async () => {
    const queue = fakeQueue([{}]);
    const hubspot = fakeHubSpot(2);
    const d = deps({ hubspot: { client: hubspot.client, config } }, queue);

    const first = await runSyncJobs(d);
    expect(first).toMatchObject({ done: 0, failed: 1, gaveUp: 0 });
    expect(queue.jobs[0]).toMatchObject({
      done: false,
      attempts: 1,
      error: "HubSpot creating a deal failed with status 500",
    });

    // Not due yet: running again does nothing.
    expect(await runSyncJobs(d)).toMatchObject({ done: 0, failed: 0 });

    queue.tick();
    expect(await runSyncJobs(d)).toMatchObject({ done: 0, failed: 1 });
    queue.tick();
    expect(await runSyncJobs(d)).toMatchObject({ done: 1, failed: 0 });

    expect(queue.jobs[0]).toMatchObject({ done: true, attempts: 3 });
    expect(hubspot.deals).toBe(1);
    expect(d.saved).toEqual(["d-1"]);
  });

  it("gives up after the last attempt and says so", async () => {
    const queue = fakeQueue([{ attempts: MAX_ATTEMPTS - 1 }]);
    const hubspot = fakeHubSpot(99);
    const report = await runSyncJobs(deps({ hubspot: { client: hubspot.client, config } }, queue));
    expect(report).toMatchObject({ failed: 1, gaveUp: 1 });
    expect(queue.jobs[0]).toMatchObject({ gaveUp: true, done: false });
  });

  it("leaves HubSpot jobs alone until HubSpot is set up, without using up attempts", async () => {
    const queue = fakeQueue([{}, { kind: "email", payload: { template: "staff_new_booking" } }]);
    const d = deps({ hubspot: null }, queue);
    const report = await runSyncJobs(d);
    expect(report.waitingOnSetup).toEqual(["hubspot"]);
    expect(queue.jobs[0]).toMatchObject({ done: false, attempts: 0 });
    expect(queue.jobs[1]).toMatchObject({ done: true });
    expect(d.sent).toHaveLength(1);
  });

  it("does nothing at all when neither is set up", async () => {
    const queue = fakeQueue([{}, { kind: "email", payload: { template: "staff_new_booking" } }]);
    const report = await runSyncJobs(deps({ hubspot: null, email: null }, queue));
    expect(report).toMatchObject({ done: 0, waitingOnSetup: ["hubspot", "email"] });
    expect(queue.jobs.every((j) => j.attempts === 0)).toBe(true);
  });

  it("sends traveler emails to the traveler and staff emails to staff, keyed by job", async () => {
    const queue = fakeQueue([
      { kind: "email", payload: { template: "traveler_payment_received", amount_cents: 75000 } },
      { kind: "email", payload: { template: "staff_payment_received", amount_cents: 75000 } },
    ]);
    const d = deps({}, queue);
    await runSyncJobs(d);
    expect(d.sent.map((e) => [e.to, e.idempotencyKey])).toEqual([
      ["tenzin@example.com", "j-1"],
      ["info@adventure-access.com", "j-2"],
    ]);
    expect(d.sent[0]?.subject).toBe("Payment received: $750 (AA-7K3Q)");
    expect(d.sent[0]?.from).toBe("Adventure Access <bookings@mail.adventure-access.com>");
  });

  it("finishes a job it cannot act on, instead of retrying it forever", async () => {
    const queue = fakeQueue([
      { kind: "email", payload: { template: "no_such_template" } },
      { kind: "email", payload: { template: "traveler_registered" } }, // link missing
      { kind: "email", booking_id: null, payload: { template: "staff_new_booking" } },
    ]);
    const d = deps({}, queue);
    const report = await runSyncJobs(d);
    expect(report).toMatchObject({ done: 3, failed: 0 });
    expect(d.sent).toHaveLength(0);
  });

  it("retries an email that the email service refused", async () => {
    const queue = fakeQueue([{ kind: "email", payload: { template: "staff_new_booking" } }]);
    let refuse = true;
    const d = deps({}, queue);
    d.email = {
      ...d.email!,
      send: async () => {
        if (refuse) throw new EmailError(429);
      },
    };
    expect(await runSyncJobs(d)).toMatchObject({ failed: 1 });
    expect(queue.jobs[0]?.error).toBe("Resend answered with status 429");
    refuse = false;
    queue.tick();
    expect(await runSyncJobs(d)).toMatchObject({ done: 1 });
  });

  it("never stores an unexpected error's own text", async () => {
    const queue = fakeQueue([{ kind: "email", payload: { template: "staff_new_booking" } }]);
    const d = deps({}, queue);
    d.loadBooking = async () => {
      throw new Error("row for tenzin@example.com could not be read");
    };
    await runSyncJobs(d);
    expect(queue.jobs[0]?.error).toBe("Unexpected error");
  });

  it("stops at the job limit and at the time budget", async () => {
    const many = Array.from({ length: 5 }, () => ({ kind: "email" as const, payload: { template: "staff_new_booking" } }));
    const limited = fakeQueue(many);
    expect((await runSyncJobs(deps({}, limited), { maxJobs: 2 })).done).toBe(2);

    const timed = fakeQueue(many);
    let clock = 0;
    const d = deps({ now: () => (clock += 4000) }, timed);
    expect((await runSyncJobs(d, { budgetMs: 7000 })).done).toBe(1);
    // Jobs it did not reach were never claimed.
    expect(timed.jobs.filter((j) => j.attempts === 0)).toHaveLength(4);
  });
});

describe("emails", () => {
  const email: EmailBooking = booking;
  const admin = "https://book.adventure-access.com/admin/bookings/b-1";
  const payloads: Record<string, Record<string, unknown>> = {
    traveler_registered: { url: "https://book.adventure-access.com/booking/AA-7K3Q?t=abc" },
    traveler_new_link: { url: "https://book.adventure-access.com/booking/AA-7K3Q?t=new" },
    traveler_payment_received: { amount_cents: 75000 },
    staff_payment_received: { amount_cents: 75000 },
    staff_document_received: { document_kind: "passport" },
    staff_sync_failed: { failed_kind: "hubspot" },
  };

  it("every template renders, in plain words with no exclamation marks", () => {
    for (const template of EMAIL_TEMPLATES) {
      const message = renderEmail(template, email, payloads[template] ?? {}, admin);
      expect(message, template).not.toBeNull();
      expect(message!.subject.length).toBeGreaterThan(10);
      expect(`${message!.subject}${message!.text}`).not.toContain("!");
      expect(message!.text).not.toMatch(/undefined|null|NaN|\[object/);
      expect(message!.to).toBe(template.startsWith("staff_") ? "staff" : "traveler");
    }
  });

  it("the registration email carries the booking link; later ones do not", () => {
    const registered = renderEmail("traveler_registered", email, payloads.traveler_registered!, admin);
    expect(registered!.text).toContain("https://book.adventure-access.com/booking/AA-7K3Q?t=abc");
    const confirmed = renderEmail("traveler_booking_confirmed", email, {}, admin);
    expect(confirmed!.text).not.toContain("?t=");
    expect(confirmed!.text).toContain("registration email");
  });

  it("traveler emails never link to the admin", () => {
    for (const template of EMAIL_TEMPLATES.filter((t) => t.startsWith("traveler_"))) {
      expect(renderEmail(template, email, payloads[template] ?? {}, admin)!.text).not.toContain("/admin/");
    }
  });

  it("the money lines add up", () => {
    const receipt = renderEmail("traveler_payment_received", email, { amount_cents: 75000 }, admin)!;
    expect(receipt.text).toContain("We received $750 toward Ladakh Multisport, Jul 10 – Jul 22, 2027.");
    expect(receipt.text).toContain("Paid so far: $750");
    expect(receipt.text).toContain("Balance: $4,200");
    const paid = renderEmail("traveler_booking_confirmed", { ...email, paid_cents: 495000 }, {}, admin)!;
    expect(paid.text).toContain("Balance: nothing more to pay");
  });

  it("the document email names the kind and nothing about the file", () => {
    const message = renderEmail("staff_document_received", email, { document_kind: "passport", file_name: "x.pdf" }, admin)!;
    expect(message.text).toContain("handed in a passport copy");
    expect(message.text).toContain(`${admin}#documents`);
    expect(message.text).not.toContain("x.pdf");
  });

  it("the staff inbox sees the group name when there is one", () => {
    const message = renderEmail("staff_new_booking", { ...email, group_name: "Hulsey family" }, {}, admin)!;
    expect(message.subject).toBe("New registration: Tenzin Norbu (Hulsey family), Ladakh Multisport (AA-7K3Q)");
  });

  it("is nothing when a link or an amount is missing", () => {
    expect(renderEmail("traveler_registered", email, {}, admin)).toBeNull();
    expect(renderEmail("traveler_payment_received", email, { amount_cents: 0 }, admin)).toBeNull();
    expect(renderEmail("staff_payment_received", email, { amount_cents: "750" }, admin)).toBeNull();
  });
});

describe("the Resend sender", () => {
  it("posts one plain-text email with the job ID as its idempotency key", async () => {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return Response.json({ id: "email-1" });
    }) as typeof fetch;
    await createResendSender("test-key", fakeFetch)({
      from: "Adventure Access <bookings@mail.adventure-access.com>",
      to: "tenzin@example.com",
      subject: "Hello",
      text: "Body",
      idempotencyKey: "j-1",
    });
    expect(seen!.url).toBe("https://api.resend.com/emails");
    expect(seen!.headers.get("authorization")).toBe("Bearer test-key");
    expect(seen!.headers.get("idempotency-key")).toBe("j-1");
    expect(seen!.body).toEqual({
      from: "Adventure Access <bookings@mail.adventure-access.com>",
      to: ["tenzin@example.com"],
      subject: "Hello",
      text: "Body",
    });
  });

  it("fails with the status only", async () => {
    const fakeFetch = (async () => Response.json({ message: "tenzin@example.com is invalid" }, { status: 422 })) as typeof fetch;
    const error = await createResendSender("k", fakeFetch)({
      from: "a",
      to: "b",
      subject: "c",
      text: "d",
      idempotencyKey: "e",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailError);
    expect((error as Error).message).toBe("Resend answered with status 422");
  });
});
