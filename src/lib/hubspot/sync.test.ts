import { describe, expect, it } from "vitest";
import { createHubSpotClient, HubSpotError, type HubSpotClient, type HubSpotContact } from "./client";
import {
  dealProperties,
  readHubSpotConfig,
  syncBookingToHubSpot,
  travelersWithContacts,
  type HubSpotConfig,
  type SyncBooking,
  type SyncTraveler,
} from "./sync";

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

const traveler = (overrides: Partial<SyncTraveler> = {}): SyncTraveler => ({
  id: "t-lead",
  first_name: "Tenzin",
  last_name: "Norbu",
  email: "tenzin@example.com",
  phone: "+1 555 0100",
  is_lead: true,
  ...overrides,
});

const booking = (overrides: Partial<SyncBooking> = {}): SyncBooking => ({
  id: "b-1",
  reference: "AA-7K3Q",
  status: "deposit_paid",
  traveler_count: 3,
  total_cents: 1485000,
  discount_cents: 50000,
  paid_cents: 225000,
  hubspot_deal_id: null,
  trip_title: "Ladakh Multisport",
  trip_slug: "ladakh-multisport",
  start_date: "2027-07-10",
  travelers: [
    traveler(),
    traveler({ id: "t-2", first_name: "Pema", email: "pema@example.com", phone: null, is_lead: false }),
    traveler({ id: "t-3", first_name: "Child", email: null, phone: null, is_lead: false }),
  ],
  ...overrides,
});

const ALL_PROPERTIES = new Set([
  "dealname",
  "amount",
  "pipeline",
  "dealstage",
  "booking_reference",
  "trip_slug",
  "departure_date",
  "travelers",
  "amount_paid",
  "booking_app_url",
]);

/** An in-memory HubSpot that records every call. */
function fakeHubSpot(options: { contacts?: HubSpotContact[]; properties?: Set<string>; failTimes?: number } = {}) {
  const calls: string[] = [];
  const contacts = [...(options.contacts ?? [])];
  const deals = new Map<string, Record<string, string>>();
  const links: string[] = [];
  let failures = options.failTimes ?? 0;
  let next = 100;
  const maybeFail = (what: string) => {
    if (failures > 0) {
      failures -= 1;
      throw new HubSpotError(503, "RATE_LIMITS", what);
    }
  };
  const client: HubSpotClient = {
    async dealPropertyNames() {
      calls.push("properties");
      return options.properties ?? ALL_PROPERTIES;
    },
    async dealPipelines() {
      return [];
    },
    async findContactByEmail(email) {
      calls.push(`find ${email}`);
      maybeFail("finding a contact");
      return contacts.find((c) => c.properties.email === email) ?? null;
    },
    async createContact(properties) {
      const id = String(next++);
      calls.push(`create contact ${properties.email}`);
      contacts.push({ id, properties });
      return id;
    },
    async updateContact(id, properties) {
      calls.push(`update contact ${id} ${Object.keys(properties).sort().join(",")}`);
      const contact = contacts.find((c) => c.id === id);
      if (contact) Object.assign(contact.properties, properties);
    },
    async createDeal(properties) {
      const id = String(next++);
      calls.push("create deal");
      deals.set(id, properties);
      return id;
    },
    async updateDeal(id, properties) {
      calls.push(`update deal ${id}`);
      if (!deals.has(id)) return false;
      deals.set(id, properties);
      return true;
    },
    async associateDealWithContact(dealId, contactId) {
      calls.push(`link ${dealId} ${contactId}`);
      links.push(`${dealId}:${contactId}`);
    },
  };
  return { client, calls, contacts, deals, links };
}

const URL = "https://book.adventure-access.com/admin/bookings/b-1";

describe("travelersWithContacts", () => {
  it("takes the lead and anyone else with their own email", () => {
    expect(travelersWithContacts(booking().travelers).map((t) => t.id)).toEqual(["t-lead", "t-2"]);
  });

  it("skips a traveler with no email or the same email as another, keeping the lead", () => {
    const travelers = [
      traveler({ id: "t-spouse", email: "Tenzin@Example.com", is_lead: false }),
      traveler(),
      traveler({ id: "t-blank", email: "  ", is_lead: false }),
    ];
    expect(travelersWithContacts(travelers).map((t) => t.id)).toEqual(["t-lead"]);
  });
});

describe("dealProperties", () => {
  it("names the deal, nets off credits, and maps the status to its stage", () => {
    const { properties, missing } = dealProperties(booking(), config, ALL_PROPERTIES, URL);
    expect(properties).toEqual({
      dealname: "Ladakh Multisport, Jul 10, 2027: Tenzin Norbu (AA-7K3Q)",
      amount: "14350.00",
      pipeline: "default",
      dealstage: "closedwon",
      booking_reference: "AA-7K3Q",
      trip_slug: "ladakh-multisport",
      departure_date: "2027-07-10",
      travelers: "3",
      amount_paid: "2250.00",
      booking_app_url: URL,
    });
    expect(missing).toEqual([]);
  });

  it("leaves out custom properties HubSpot does not have, and says which", () => {
    const standard = new Set(["dealname", "amount", "pipeline", "dealstage", "booking_reference"]);
    const { properties, missing } = dealProperties(booking(), config, standard, URL);
    expect(Object.keys(properties).sort()).toEqual([
      "amount",
      "booking_reference",
      "dealname",
      "dealstage",
      "pipeline",
    ]);
    expect(missing).toEqual(["trip_slug", "departure_date", "travelers", "amount_paid", "booking_app_url"]);
  });

  it("uses each status's own stage", () => {
    const stage = (status: SyncBooking["status"]) =>
      dealProperties(booking({ status }), config, ALL_PROPERTIES, URL).properties.dealstage;
    expect(stage("pending")).toBe("contractsent");
    expect(stage("paid_in_full")).toBe("closedwon");
    expect(stage("canceled")).toBe("closedlost");
  });
});

describe("syncBookingToHubSpot", () => {
  it("creates contacts and a deal, and links every contact to the deal", async () => {
    const hubspot = fakeHubSpot();
    const result = await syncBookingToHubSpot(hubspot.client, config, booking(), URL);

    expect(hubspot.contacts.map((c) => c.properties.email)).toEqual(["tenzin@example.com", "pema@example.com"]);
    expect(hubspot.deals.size).toBe(1);
    expect(Object.keys(result.contactIds).sort()).toEqual(["t-2", "t-lead"]);
    expect(hubspot.links.sort()).toEqual(
      Object.values(result.contactIds).map((contactId) => `${result.dealId}:${contactId}`).sort(),
    );
    // The child with no email got no contact.
    expect(result.contactIds["t-3"]).toBeUndefined();
  });

  it("never sets a marketing status and never sends a blank", async () => {
    const hubspot = fakeHubSpot();
    await syncBookingToHubSpot(hubspot.client, config, booking(), URL);
    for (const contact of hubspot.contacts) {
      expect(Object.keys(contact.properties).some((name) => /market/i.test(name))).toBe(false);
      expect(Object.values(contact.properties).every((value) => value !== "" && value !== null)).toBe(true);
    }
    // Pema gave no phone, so none was sent.
    expect(hubspot.contacts[1]?.properties).toEqual({
      email: "pema@example.com",
      firstname: "Pema",
      lastname: "Norbu",
    });
  });

  it("fills only the blanks on a contact that already exists", async () => {
    const hubspot = fakeHubSpot({
      contacts: [
        { id: "7", properties: { email: "tenzin@example.com", firstname: "Tenzing", lastname: "", phone: null } },
      ],
    });
    await syncBookingToHubSpot(hubspot.client, config, booking(), URL);
    expect(hubspot.contacts[0]?.properties).toEqual({
      email: "tenzin@example.com",
      firstname: "Tenzing", // kept: HubSpot already had a name
      lastname: "Norbu",
      phone: "+1 555 0100",
    });
    expect(hubspot.calls).toContain("update contact 7 lastname,phone");
  });

  it("leaves a complete existing contact untouched", async () => {
    const hubspot = fakeHubSpot({
      contacts: [
        { id: "7", properties: { email: "tenzin@example.com", firstname: "T", lastname: "N", phone: "1" } },
      ],
    });
    await syncBookingToHubSpot(hubspot.client, config, booking({ travelers: [traveler()] }), URL);
    expect(hubspot.calls.some((call) => call.startsWith("update contact"))).toBe(false);
  });

  it("updates the same deal on a second run and makes no duplicates", async () => {
    const hubspot = fakeHubSpot();
    const first = await syncBookingToHubSpot(hubspot.client, config, booking(), URL);
    const again = await syncBookingToHubSpot(
      hubspot.client,
      config,
      booking({ hubspot_deal_id: first.dealId, status: "paid_in_full", paid_cents: 1435000 }),
      URL,
    );
    expect(again.dealId).toBe(first.dealId);
    expect(hubspot.deals.size).toBe(1);
    expect(hubspot.contacts).toHaveLength(2);
    expect(hubspot.deals.get(first.dealId)?.amount_paid).toBe("14350.00");
  });

  it("creates a fresh deal when the old one was deleted in HubSpot", async () => {
    const hubspot = fakeHubSpot();
    const result = await syncBookingToHubSpot(hubspot.client, config, booking({ hubspot_deal_id: "gone" }), URL);
    expect(result.dealId).not.toBe("gone");
    expect(hubspot.calls).toContain("update deal gone");
    expect(hubspot.calls).toContain("create deal");
  });

  it("reports missing custom properties without failing", async () => {
    const hubspot = fakeHubSpot({ properties: new Set(["dealname", "amount", "pipeline", "dealstage"]) });
    const result = await syncBookingToHubSpot(hubspot.client, config, booking(), URL);
    expect(result.missingProperties).toHaveLength(6);
    expect(hubspot.deals.size).toBe(1);
  });

  it("a forced failure throws, and the next run succeeds with nothing doubled", async () => {
    const hubspot = fakeHubSpot({ failTimes: 1 });
    await expect(syncBookingToHubSpot(hubspot.client, config, booking(), URL)).rejects.toMatchObject({
      name: "HubSpotError",
      status: 503,
    });
    expect(hubspot.deals.size).toBe(0);

    const result = await syncBookingToHubSpot(hubspot.client, config, booking(), URL);
    expect(hubspot.deals.size).toBe(1);
    expect(hubspot.contacts).toHaveLength(2);
    expect(hubspot.links).toHaveLength(2);
    expect(result.dealId).toBeDefined();
  });
});

describe("readHubSpotConfig", () => {
  it("needs a pipeline and a stage for every status", () => {
    expect(readHubSpotConfig(config)).toEqual(config);
    expect(readHubSpotConfig(null)).toBeNull();
    expect(readHubSpotConfig({ pipeline_id: "default" })).toBeNull();
    expect(readHubSpotConfig({ ...config, stages: { ...config.stages, refunded: "" } })).toBeNull();
    expect(readHubSpotConfig({ ...config, pipeline_id: "" })).toBeNull();
  });
});

describe("the HubSpot client", () => {
  it("sends the token, and reports failures by status and category only", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return Response.json(
        { category: "VALIDATION_ERROR", message: "Property values were not valid: tenzin@example.com" },
        { status: 400 },
      );
    }) as typeof fetch;
    const client = createHubSpotClient("test-token", fakeFetch);

    const error = await client.createContact({ email: "tenzin@example.com" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HubSpotError);
    expect((error as HubSpotError).message).toBe(
      "HubSpot creating a contact failed with status 400 (VALIDATION_ERROR)",
    );
    expect((error as HubSpotError).message).not.toContain("example.com");
    expect(seen[0]).toEqual({
      url: "https://api.hubapi.com/crm/v3/objects/contacts",
      auth: "Bearer test-token",
    });
  });

  it("treats a missing deal as gone, not as an error", async () => {
    const fakeFetch = (async () => Response.json({ category: "OBJECT_NOT_FOUND" }, { status: 404 })) as typeof fetch;
    expect(await createHubSpotClient("t", fakeFetch).updateDeal("123", { amount: "1" })).toBe(false);
  });

  it("finds a contact by exact email and links with the default association", async () => {
    const bodies: unknown[] = [];
    const urls: string[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(`${init?.method} ${String(url)}`);
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return Response.json({ results: [{ id: "9", properties: { email: "a@b.co" } }] });
    }) as typeof fetch;
    const client = createHubSpotClient("t", fakeFetch);

    expect((await client.findContactByEmail("a@b.co"))?.id).toBe("9");
    expect(bodies[0]).toMatchObject({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: "a@b.co" }] }],
      limit: 1,
    });
    await client.associateDealWithContact("55", "9");
    expect(urls[1]).toBe(
      "PUT https://api.hubapi.com/crm/v4/objects/deals/55/associations/default/contacts/9",
    );
  });
});
