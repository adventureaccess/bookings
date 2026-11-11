import { createServiceClient } from "../supabase/service";
import type { TravelerInput } from "./form";

/**
 * The booking flow's database calls. Each one is a purpose-built SQL function
 * (supabase/migrations, booking_functions) that only the service role may
 * run, so the public pages never query bookings, travelers or holds directly.
 */

/** Seats are held for this long while the traveler pays. */
export const HOLD_MINUTES = 30;

/** Logs the database error code only. Messages can contain row values. */
function logDbError(where: string, error: { code?: string } | null): void {
  console.error(`[booking] ${where} failed`, { code: error?.code ?? "unknown" });
}

export interface ListedDeparture {
  departure_id: string;
  trip_slug: string;
  trip_title: string;
  destination: string;
  hero_image_url: string | null;
  start_date: string;
  end_date: string;
  price_cents: number;
  deposit_cents: number;
  status: "open" | "full";
  seats_left: number;
}

export interface BookingPolicy {
  id: string;
  version: number;
  title: string;
  body_md: string;
}

export interface BookingDeparture {
  id: string;
  trip_slug: string;
  trip_title: string;
  destination: string;
  hero_image_url: string | null;
  start_date: string;
  end_date: string;
  price_cents: number;
  deposit_cents: number;
  balance_due_date: string;
  payment_schedule: unknown;
  custom_questions: unknown;
  status: "open" | "full";
  is_private: boolean;
  is_past: boolean;
  seats_left: number;
  policy: BookingPolicy | null;
}

export type CreateBookingResult =
  | { ok: true; booking_id: string; reference: string; expires_at: string; resumed: boolean }
  | {
      ok: false;
      reason: "not_found" | "closed" | "policy_changed" | "not_enough_seats" | "error";
      seats_left?: number;
    };

export interface BookingSummary {
  booking_id: string;
  reference: string;
  status: "pending" | "deposit_paid" | "paid_in_full" | "canceled" | "refunded";
  traveler_count: number;
  total_cents: number;
  paid_cents: number;
  deposit_due_cents: number;
  hold_expires_at: string | null;
  hold_active: boolean;
  departure_id: string;
  is_private: boolean;
  start_date: string;
  end_date: string;
  trip_slug: string;
  trip_title: string;
  lead_first_name: string | null;
}

/** Public departures that can be shown on the home page, soonest first. */
export async function listBookableDepartures(): Promise<ListedDeparture[]> {
  const { data, error } = await createServiceClient().rpc("bookable_departures");
  if (error) logDbError("listBookableDepartures", error);
  return (data ?? []) as ListedDeparture[];
}

/** One departure for its booking page, or null when this visitor may not see it. */
export async function getDepartureForBooking(
  departureId: string,
  key: string | null,
): Promise<BookingDeparture | null> {
  const { data, error } = await createServiceClient().rpc("departure_for_booking", {
    p_departure_id: departureId,
    p_key: key,
  });
  if (error) logDbError("getDepartureForBooking", error);
  return (data as BookingDeparture | null) ?? null;
}

export interface CreateBookingInput {
  departureId: string;
  key: string | null;
  policyVersionId: string;
  travelers: TravelerInput[];
  accessTokenHash: string;
  ip: string | null;
  userAgent: string;
  source: string;
  resumeBookingId: string | null;
}

/** The booking transaction: pending booking, travelers, acceptance and hold, all or nothing. */
export async function createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
  const { data, error } = await createServiceClient().rpc("create_booking", {
    p_departure_id: input.departureId,
    p_key: input.key,
    p_policy_version_id: input.policyVersionId,
    p_travelers: input.travelers,
    p_access_token_hash: input.accessTokenHash,
    p_ip: input.ip,
    p_user_agent: input.userAgent,
    p_source: input.source,
    p_resume_booking_id: input.resumeBookingId,
    p_hold_minutes: HOLD_MINUTES,
  });
  if (error || !data) {
    logDbError("createBooking", error);
    return { ok: false, reason: "error" };
  }
  return data as CreateBookingResult;
}

/** A traveler's own booking, found by its reference and the hash of their token. */
export async function getBookingSummary(
  reference: string,
  accessTokenHash: string,
): Promise<BookingSummary | null> {
  const { data, error } = await createServiceClient().rpc("booking_summary", {
    p_reference: reference,
    p_access_token_hash: accessTokenHash,
  });
  if (error) logDbError("getBookingSummary", error);
  return (data as BookingSummary | null) ?? null;
}
