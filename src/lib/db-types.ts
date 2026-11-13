/**
 * Row shapes for the tables the admin reads. Kept by hand and small on
 * purpose; the source of truth is supabase/migrations.
 */
import type { DepartureStatus, DepartureVisibility } from "./departures/form";

export interface Trip {
  id: string;
  slug: string;
  title: string;
  destination: string;
  hero_image_url: string | null;
  active: boolean;
  updated_at: string;
}

export interface ItineraryRow {
  id: string;
  departure_id: string;
  position: number;
  kind: "day" | "highlight";
  day_label: string;
  title: string;
  body_md: string;
  image_url: string | null;
}

/** One booking on a departure's roster. */
export interface RosterBooking {
  id: string;
  reference: string;
  status: "pending" | "deposit_paid" | "paid_in_full" | "canceled" | "refunded";
  traveler_count: number;
  total_cents: number;
  discount_cents: number;
  paid_cents: number;
  needs_attention: boolean;
  created_at: string;
  travelers: { id: string; first_name: string; last_name: string; email: string | null; is_lead: boolean }[];
}

export interface Departure {
  id: string;
  trip_id: string;
  start_date: string;
  end_date: string;
  price_cents: number;
  deposit_cents: number;
  currency: string;
  balance_due_date: string;
  min_travelers: number;
  max_travelers: number;
  status: DepartureStatus;
  visibility: DepartureVisibility;
  private_token: string | null;
  policy_version_id: string | null;
  custom_questions: unknown;
  payment_schedule: unknown;
  group_name: string | null;
  waiver_version_id: string | null;
  required_documents: unknown;
  updated_at: string;
}

export interface DepartureWithTrip extends Departure {
  trips: Pick<Trip, "title" | "slug"> | null;
}

export interface PolicyVersion {
  id: string;
  title: string;
  body_md: string;
  version: number;
  published_at: string | null;
  updated_at: string;
}

export interface BookingListItem {
  id: string;
  reference: string;
  status: "pending" | "deposit_paid" | "paid_in_full" | "canceled" | "refunded";
  traveler_count: number;
  total_cents: number;
  paid_cents: number;
  created_at: string;
  departures: {
    start_date: string;
    end_date: string;
    trips: Pick<Trip, "title"> | null;
  } | null;
  seat_holds: { seats: number; expires_at: string } | null;
  travelers: { first_name: string; last_name: string; email: string | null; is_lead: boolean }[];
}

export type BookingStatus = BookingListItem["status"];
export type PaymentMethod = "card" | "wire" | "ach" | "check" | "cash" | "other";

export interface BookingDetail {
  id: string;
  reference: string;
  status: BookingStatus;
  traveler_count: number;
  total_cents: number;
  discount_cents: number;
  paid_cents: number;
  needs_attention: boolean;
  source: string | null;
  created_at: string;
  departures: {
    id: string;
    start_date: string;
    end_date: string;
    price_cents: number;
    deposit_cents: number;
    balance_due_date: string;
    payment_schedule: unknown;
    visibility: DepartureVisibility;
    required_documents: unknown;
    waiver_version_id: string | null;
    trips: Pick<Trip, "title" | "slug"> | null;
  } | null;
  seat_holds: { seats: number; expires_at: string } | null;
  travelers: {
    id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
    is_lead: boolean;
    answers: unknown;
  }[];
  payments: {
    id: string;
    kind: "deposit" | "balance" | "refund";
    method: PaymentMethod;
    status: "pending" | "succeeded" | "failed";
    amount_cents: number;
    fee_cents: number;
    received_on: string | null;
    note: string | null;
    recorded_by: string | null;
    voided_at: string | null;
    void_reason: string | null;
    stripe_payment_intent_id: string | null;
    created_at: string;
  }[];
  booking_adjustments: {
    id: string;
    amount_cents: number;
    reason: string;
    created_by: string;
    created_at: string;
  }[];
}
