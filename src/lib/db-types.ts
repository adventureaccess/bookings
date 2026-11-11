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
