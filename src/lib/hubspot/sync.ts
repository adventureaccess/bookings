import { formatDate } from "../dates";
import type { HubSpotClient } from "./client";

/**
 * Sends one booking to HubSpot: a contact per traveler, one deal, and the
 * links between them. It always sends the booking as it is now, so running
 * it twice is harmless.
 */

export const BOOKING_STATUSES = ["pending", "deposit_paid", "paid_in_full", "canceled", "refunded"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Which pipeline bookings go into, and which stage each booking status means. */
export interface HubSpotConfig {
  pipeline_id: string;
  stages: Record<BookingStatus, string>;
}

/** Reads the stored setting. Null unless a pipeline and all five stages are chosen. */
export function readHubSpotConfig(raw: unknown): HubSpotConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const { pipeline_id, stages } = raw as Record<string, unknown>;
  if (typeof pipeline_id !== "string" || pipeline_id === "" || !stages || typeof stages !== "object") {
    return null;
  }
  const chosen = {} as Record<BookingStatus, string>;
  for (const status of BOOKING_STATUSES) {
    const stage = (stages as Record<string, unknown>)[status];
    if (typeof stage !== "string" || stage === "") return null;
    chosen[status] = stage;
  }
  return { pipeline_id, stages: chosen };
}

/**
 * The custom deal properties this app fills in when they exist in HubSpot.
 * It never creates them: a property that is missing is left out and
 * reported, so the sync works before and after staff add them.
 */
export const CUSTOM_DEAL_PROPERTIES = [
  { name: "booking_reference", label: "Booking reference", type: "Single-line text" },
  { name: "trip_slug", label: "Trip", type: "Single-line text" },
  { name: "departure_date", label: "Departure date", type: "Date picker" },
  { name: "travelers", label: "Travelers", type: "Number" },
  { name: "amount_paid", label: "Amount paid", type: "Number (currency)" },
  { name: "booking_app_url", label: "Booking in the app", type: "Single-line text" },
] as const;

export interface SyncTraveler {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  is_lead: boolean;
}

export interface SyncBooking {
  id: string;
  reference: string;
  status: BookingStatus;
  traveler_count: number;
  total_cents: number;
  discount_cents: number;
  paid_cents: number;
  hubspot_deal_id: string | null;
  trip_title: string;
  trip_slug: string;
  start_date: string;
  travelers: SyncTraveler[];
}

export interface SyncResult {
  dealId: string;
  /** Traveler ID to HubSpot contact ID, for the travelers that got a contact. */
  contactIds: Record<string, string>;
  /** Custom deal properties that do not exist in HubSpot yet and were left out. */
  missingProperties: string[];
}

const dollars = (cents: number): string => (cents / 100).toFixed(2);

/**
 * The travelers who get a contact: the lead, and any other traveler with an
 * email of their own. Someone with no email, or the same email as a traveler
 * already taken, is skipped.
 */
export function travelersWithContacts(travelers: SyncTraveler[]): SyncTraveler[] {
  const seen = new Set<string>();
  const chosen: SyncTraveler[] = [];
  const leadFirst = [...travelers].sort((a, b) => Number(b.is_lead) - Number(a.is_lead));
  for (const traveler of leadFirst) {
    const email = traveler.email?.trim().toLowerCase() ?? "";
    if (email === "" || seen.has(email)) continue;
    seen.add(email);
    chosen.push(traveler);
  }
  return chosen;
}

/** The deal's properties, leaving out custom ones the portal does not have. */
export function dealProperties(
  booking: SyncBooking,
  config: HubSpotConfig,
  existing: Set<string>,
  bookingAdminUrl: string,
): { properties: Record<string, string>; missing: string[] } {
  const lead = booking.travelers.find((t) => t.is_lead);
  const who = lead ? `${lead.first_name} ${lead.last_name}` : "Traveler";
  const properties: Record<string, string> = {
    dealname: `${booking.trip_title}, ${formatDate(booking.start_date)}: ${who} (${booking.reference})`,
    amount: dollars(Math.max(booking.total_cents - booking.discount_cents, 0)),
    pipeline: config.pipeline_id,
    dealstage: config.stages[booking.status],
  };
  const custom: Record<string, string> = {
    booking_reference: booking.reference,
    trip_slug: booking.trip_slug,
    departure_date: booking.start_date,
    travelers: String(booking.traveler_count),
    amount_paid: dollars(booking.paid_cents),
    booking_app_url: bookingAdminUrl,
  };
  const missing: string[] = [];
  for (const [name, value] of Object.entries(custom)) {
    if (existing.has(name)) properties[name] = value;
    else missing.push(name);
  }
  return { properties, missing };
}

/** Finds or creates the contact for one traveler and returns its ID. */
async function upsertContact(client: HubSpotClient, traveler: SyncTraveler): Promise<string> {
  const email = (traveler.email ?? "").trim().toLowerCase();
  const found = await client.findContactByEmail(email);
  if (!found) {
    // Nothing about marketing status is set: a contact created here is not
    // marked as a marketing contact by this app.
    return client.createContact({
      email,
      firstname: traveler.first_name,
      lastname: traveler.last_name,
      ...(traveler.phone ? { phone: traveler.phone } : {}),
    });
  }
  // Fill in what HubSpot does not have. Never overwrite what staff or the
  // contact themselves already entered, and never send a blank.
  const fill: Record<string, string> = {};
  const offered: Record<string, string | null> = {
    firstname: traveler.first_name,
    lastname: traveler.last_name,
    phone: traveler.phone,
  };
  for (const [name, value] of Object.entries(offered)) {
    if (value && !(found.properties[name] ?? "").trim()) fill[name] = value;
  }
  if (Object.keys(fill).length > 0) await client.updateContact(found.id, fill);
  return found.id;
}

export async function syncBookingToHubSpot(
  client: HubSpotClient,
  config: HubSpotConfig,
  booking: SyncBooking,
  bookingAdminUrl: string,
): Promise<SyncResult> {
  const contactIds: Record<string, string> = {};
  for (const traveler of travelersWithContacts(booking.travelers)) {
    contactIds[traveler.id] = await upsertContact(client, traveler);
  }

  const existing = await client.dealPropertyNames();
  const { properties, missing } = dealProperties(booking, config, existing, bookingAdminUrl);

  let dealId = booking.hubspot_deal_id;
  if (dealId && !(await client.updateDeal(dealId, properties))) dealId = null; // deleted in HubSpot
  if (!dealId) dealId = await client.createDeal(properties);

  for (const contactId of new Set(Object.values(contactIds))) {
    await client.associateDealWithContact(dealId, contactId);
  }
  return { dealId, contactIds, missingProperties: missing };
}
