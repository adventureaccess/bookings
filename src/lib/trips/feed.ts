import { z } from "astro/zod";

/**
 * The trip feed published by the website, and how it maps onto the trips
 * table. The feed carries only what this app shows: slug, title, destination
 * and hero image. Departures, prices and capacity live only here.
 *
 * Expected shape, at the URL in TRIPS_FEED_URL:
 *   { "trips": [ { "slug": "ladakh-multisport", "title": "Ladakh Multisport",
 *                  "destination": "ladakh",
 *                  "heroImage": "https://adventure-access.com/images/….jpg" } ] }
 */

const feedTrip = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().trim().min(1).max(200),
  destination: z.string().trim().min(1).max(80),
  heroImage: z
    .string()
    .max(500)
    .regex(/^https:\/\//, "must be an absolute https URL")
    .nullish(),
});

export const tripFeedSchema = z.object({
  trips: z.array(feedTrip).max(500),
});

export type FeedTrip = z.infer<typeof feedTrip>;

export interface ExistingTrip {
  slug: string;
  title: string;
  destination: string;
  hero_image_url: string | null;
  active: boolean;
}

export interface TripRow {
  slug: string;
  title: string;
  destination: string;
  hero_image_url: string | null;
  active: boolean;
}

export interface TripSyncPlan {
  /** Rows to insert or update, matched on slug. */
  upserts: TripRow[];
  /** Slugs no longer in the feed. They are switched off, never deleted. */
  deactivate: string[];
  added: number;
  updated: number;
  unchanged: number;
}

/**
 * Works out what a sync would change. A trip that left the feed is
 * deactivated, not deleted, because departures and bookings may point at it.
 */
export function planTripSync(existing: ExistingTrip[], feed: FeedTrip[]): TripSyncPlan {
  const bySlug = new Map(existing.map((trip) => [trip.slug, trip]));
  const seen = new Set<string>();
  const plan: TripSyncPlan = {
    upserts: [],
    deactivate: [],
    added: 0,
    updated: 0,
    unchanged: 0,
  };

  for (const trip of feed) {
    if (seen.has(trip.slug)) continue; // a duplicate slug: first one wins
    seen.add(trip.slug);
    const row: TripRow = {
      slug: trip.slug,
      title: trip.title,
      destination: trip.destination,
      hero_image_url: trip.heroImage ?? null,
      active: true,
    };
    const current = bySlug.get(trip.slug);
    if (!current) {
      plan.added += 1;
      plan.upserts.push(row);
    } else if (
      current.title !== row.title ||
      current.destination !== row.destination ||
      current.hero_image_url !== row.hero_image_url ||
      !current.active
    ) {
      plan.updated += 1;
      plan.upserts.push(row);
    } else {
      plan.unchanged += 1;
    }
  }

  for (const trip of existing) {
    if (trip.active && !seen.has(trip.slug)) plan.deactivate.push(trip.slug);
  }
  return plan;
}
