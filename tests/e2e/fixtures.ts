import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Test data for the browser tests: private throwaway departures in the dev
 * project, removed again afterward. Private departures never appear in the
 * public list, so real visitors cannot stumble on them.
 */

function readEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1]) values[match[1]] = (match[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return values;
}

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;
  const env = { ...readEnvFile(".env.local"), ...process.env };
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local first.");
  }
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export interface TestDeparture {
  id: string;
  key: string;
  slug: string;
  /** The booking page, with the private key. */
  path: string;
  /** The tour's title, as the booking page shows it. */
  title: string;
  /** True when a published waiver exists and is attached. */
  hasWaiver: boolean;
}

export async function createTestDeparture(seats: number): Promise<TestDeparture> {
  const trip = await db().from("trips").select("id, slug, title").eq("active", true).order("slug").limit(1).maybeSingle();
  const policy = await db()
    .from("policy_versions")
    .select("id")
    .not("published_at", "is", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  // The newest published waiver, if there is one. Publishing cannot be
  // undone, so the tests use what exists and never publish their own.
  const waiver = await db()
    .from("waiver_versions")
    .select("id")
    .not("published_at", "is", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!trip.data) throw new Error("No active trip in the dev project.");
  if (!policy.data) throw new Error("No published policy version in the dev project.");

  const key = randomBytes(24).toString("base64url");
  const created = await db()
    .from("departures")
    .insert({
      trip_id: trip.data.id,
      start_date: "2099-07-10",
      end_date: "2099-07-22",
      price_cents: 495000,
      deposit_cents: 75000,
      balance_due_date: "2099-05-11",
      max_travelers: seats,
      visibility: "private",
      private_token: key,
      policy_version_id: policy.data.id,
      waiver_version_id: waiver.data?.id ?? null,
      custom_questions: [
        { id: "q1", label: "What is your height, for bike sizing?", type: "text", required: false },
      ],
      payment_schedule: [
        { id: "p1", label: "Second payment", due_date: "2099-02-01", amount_cents: 150000 },
      ],
    })
    .select("id")
    .single();
  if (created.error) throw new Error(`Could not create a test departure (${created.error.code}).`);

  const id = created.data.id as string;
  const slug = trip.data.slug as string;

  // The group's own itinerary: two days and a highlight.
  const itinerary = await db().rpc("replace_itinerary", {
    p_departure_id: id,
    p_items: [
      { kind: "day", day_label: "Days 1–2", title: "Test valley arrival", body_md: "Settle in.\n\n- Day 1: Fly in.\n- Day 2: Walk.", image_url: null },
      { kind: "day", day_label: "Day 3", title: "Test pass crossing", body_md: "A long day on foot.", image_url: null },
      { kind: "highlight", day_label: "", title: "Test palace visit", body_md: "A palace above the village.", image_url: null },
    ],
  });
  if (itinerary.error) throw new Error(`Could not add a test itinerary (${itinerary.error.code}).`);
  return {
    id,
    key,
    slug,
    title: trip.data.title as string,
    path: `/${slug}/${id}?key=${key}`,
    hasWaiver: Boolean(waiver.data),
  };
}

export async function removeTestDeparture(id: string): Promise<void> {
  // The bookings queued HubSpot and email jobs. Remove those first, so a
  // test booking is never sent anywhere.
  const bookings = await db().from("bookings").select("id").eq("departure_id", id);
  const ids = (bookings.data ?? []).map((b) => b.id as string);
  if (ids.length > 0) await db().from("sync_jobs").delete().in("booking_id", ids);
  await db().from("bookings").delete().eq("departure_id", id);
  await db().from("departures").delete().eq("id", id);
}

export interface BookingState {
  bookings: { id: string; status: string; traveler_count: number; total_cents: number }[];
  holds: { seats: number; expires_at: string }[];
  travelers: { first_name: string; email: string | null; is_lead: boolean; answers: unknown }[];
}

/** What the database holds for a test departure. */
export async function bookingState(departureId: string): Promise<BookingState> {
  const bookings = await db()
    .from("bookings")
    .select("id, status, traveler_count, total_cents")
    .eq("departure_id", departureId);
  const holds = await db().from("seat_holds").select("seats, expires_at").eq("departure_id", departureId);
  const ids = (bookings.data ?? []).map((b) => b.id as string);
  const travelers = ids.length
    ? await db()
        .from("travelers")
        .select("first_name, email, is_lead, answers")
        .in("booking_id", ids)
        .order("is_lead", { ascending: false })
    : { data: [] };
  return {
    bookings: (bookings.data ?? []) as BookingState["bookings"],
    holds: (holds.data ?? []) as BookingState["holds"],
    travelers: (travelers.data ?? []) as BookingState["travelers"],
  };
}

export interface DocumentState {
  uploads: { kind: string; status: string; drive_file_id: string; file_name: string }[];
  signatures: { signed_name: string }[];
}

/** The uploads and waiver signatures recorded for a test departure's bookings. */
export async function documentState(departureId: string): Promise<DocumentState> {
  const bookings = await db().from("bookings").select("id").eq("departure_id", departureId);
  const ids = (bookings.data ?? []).map((b) => b.id as string);
  if (ids.length === 0) return { uploads: [], signatures: [] };
  const uploads = await db()
    .from("traveler_documents")
    .select("kind, status, drive_file_id, file_name")
    .in("booking_id", ids)
    .order("created_at");
  const signatures = await db().from("waiver_acceptances").select("signed_name").in("booking_id", ids);
  return {
    uploads: (uploads.data ?? []) as DocumentState["uploads"],
    signatures: (signatures.data ?? []) as DocumentState["signatures"],
  };
}
