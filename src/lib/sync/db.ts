import {
  EMAIL_FROM,
  HUBSPOT_ACCESS_TOKEN,
  RESEND_API_KEY,
  STAFF_NOTIFY_EMAIL,
} from "astro:env/server";
import { createResendSender } from "../email/resend";
import { createHubSpotClient, type HubSpotClient } from "../hubspot/client";
import { readHubSpotConfig, type HubSpotConfig, type SyncResult } from "../hubspot/sync";
import { createServiceClient } from "../supabase/service";
import type { JobKind, SyncJob, WorkerBooking, WorkerDeps } from "./worker";

/**
 * The sync worker's database side and its wiring to HubSpot and email. Used
 * by the cron route and by admin actions after the role check.
 */

/** Logs the database error code only. Messages can contain row values. */
function logDbError(where: string, error: { code?: string } | null): void {
  console.error(`[sync] ${where} failed`, { code: error?.code ?? "unknown" });
}

const STAFF_INBOX = "info@adventure-access.com";

// --- Settings ----------------------------------------------------------------

export async function getHubSpotConfig(): Promise<HubSpotConfig | null> {
  const { data, error } = await createServiceClient()
    .from("settings")
    .select("value")
    .eq("key", "hubspot")
    .maybeSingle();
  if (error) logDbError("getHubSpotConfig", error);
  return readHubSpotConfig(data?.value);
}

export async function setHubSpotConfig(config: HubSpotConfig): Promise<boolean> {
  const { error } = await createServiceClient()
    .from("settings")
    .upsert({ key: "hubspot", value: config }, { onConflict: "key" });
  if (error) logDbError("setHubSpotConfig", error);
  return !error;
}

/** The HubSpot client, or null when no token is set. */
export function hubSpotClient(): HubSpotClient | null {
  return HUBSPOT_ACCESS_TOKEN ? createHubSpotClient(HUBSPOT_ACCESS_TOKEN) : null;
}

/** What is and is not set up, for the admin page. */
export function integrationStatus(): { hubspotToken: boolean; emailKey: boolean; emailFrom: string | null; staffTo: string } {
  return {
    hubspotToken: Boolean(HUBSPOT_ACCESS_TOKEN),
    emailKey: Boolean(RESEND_API_KEY),
    emailFrom: EMAIL_FROM ?? null,
    staffTo: STAFF_NOTIFY_EMAIL ?? STAFF_INBOX,
  };
}

// --- The queue ---------------------------------------------------------------

async function claimJobs(kinds: JobKind[], limit: number): Promise<SyncJob[]> {
  const { data, error } = await createServiceClient().rpc("claim_sync_jobs", {
    p_kinds: kinds,
    p_limit: limit,
  });
  if (error) {
    logDbError("claimJobs", error);
    return [];
  }
  return ((data ?? []) as SyncJob[]).map((job) => ({
    id: job.id,
    kind: job.kind,
    booking_id: job.booking_id,
    payload: job.payload ?? {},
    attempts: job.attempts,
  }));
}

async function completeJob(jobId: string): Promise<void> {
  const { error } = await createServiceClient().rpc("complete_sync_job", { p_job_id: jobId });
  if (error) logDbError("completeJob", error);
}

async function failJob(jobId: string, reason: string, maxAttempts: number): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc("fail_sync_job", {
    p_job_id: jobId,
    p_error: reason,
    p_max_attempts: maxAttempts,
  });
  if (error) logDbError("failJob", error);
  return data === true;
}

export async function retryJob(jobId: string): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc("retry_sync_job", { p_job_id: jobId });
  if (error) logDbError("retryJob", error);
  return data === true;
}

/** Queues the email that carries a traveler's booking link. */
export async function enqueueBookingLinkEmail(
  bookingId: string,
  template: "traveler_registered" | "traveler_new_link",
  url: string,
): Promise<boolean> {
  const { error } = await createServiceClient().rpc("enqueue_booking_link_email", {
    p_booking_id: bookingId,
    p_template: template,
    p_url: url,
  });
  if (error) logDbError("enqueueBookingLinkEmail", error);
  return !error;
}

interface BookingRow {
  id: string;
  reference: string;
  status: WorkerBooking["status"];
  traveler_count: number;
  total_cents: number;
  discount_cents: number;
  paid_cents: number;
  hubspot_deal_id: string | null;
  departures: {
    start_date: string;
    end_date: string;
    balance_due_date: string;
    group_name: string | null;
    trips: { title: string; slug: string } | null;
  } | null;
  travelers: WorkerBooking["travelers"];
}

async function loadBooking(bookingId: string): Promise<WorkerBooking | null> {
  const { data, error } = await createServiceClient()
    .from("bookings")
    .select(
      `id, reference, status, traveler_count, total_cents, discount_cents, paid_cents, hubspot_deal_id,
       departures ( start_date, end_date, balance_due_date, group_name, trips ( title, slug ) ),
       travelers!travelers_booking_id_fkey ( id, first_name, last_name, email, phone, is_lead )`,
    )
    .eq("id", bookingId)
    .maybeSingle();
  if (error) {
    // A failed read must not look like a missing booking, or the job would be dropped.
    logDbError("loadBooking", error);
    throw new Error("booking could not be read");
  }
  const row = data as unknown as BookingRow | null;
  if (!row || !row.departures) return null;
  const lead = row.travelers.find((traveler) => traveler.is_lead) ?? row.travelers[0];
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    traveler_count: row.traveler_count,
    total_cents: row.total_cents,
    discount_cents: row.discount_cents,
    paid_cents: row.paid_cents,
    hubspot_deal_id: row.hubspot_deal_id,
    trip_title: row.departures.trips?.title ?? "Trip",
    trip_slug: row.departures.trips?.slug ?? "",
    start_date: row.departures.start_date,
    end_date: row.departures.end_date,
    balance_due_date: row.departures.balance_due_date,
    group_name: row.departures.group_name,
    lead_first_name: lead?.first_name ?? "traveler",
    lead_name: lead ? `${lead.first_name} ${lead.last_name}` : "Traveler",
    lead_email: lead?.email ?? null,
    travelers: row.travelers,
  };
}

async function saveHubSpotIds(bookingId: string, result: SyncResult): Promise<void> {
  const db = createServiceClient();
  const { error } = await db.from("bookings").update({ hubspot_deal_id: result.dealId }).eq("id", bookingId);
  if (error) {
    logDbError("saveHubSpotIds.deal", error);
    throw new Error("deal id could not be saved");
  }
  for (const [travelerId, contactId] of Object.entries(result.contactIds)) {
    const { error: travelerError } = await db
      .from("travelers")
      .update({ hubspot_contact_id: contactId })
      .eq("id", travelerId);
    if (travelerError) logDbError("saveHubSpotIds.contact", travelerError);
  }
}

/** Everything the worker needs, wired to the real database, HubSpot and Resend. */
export async function workerDeps(origin: string): Promise<WorkerDeps> {
  const client = hubSpotClient();
  const config = client ? await getHubSpotConfig() : null;
  return {
    hubspot: client && config ? { client, config } : null,
    email:
      RESEND_API_KEY && EMAIL_FROM
        ? {
            send: createResendSender(RESEND_API_KEY),
            from: EMAIL_FROM,
            staffTo: STAFF_NOTIFY_EMAIL ?? STAFF_INBOX,
          }
        : null,
    origin,
    claim: claimJobs,
    complete: completeJob,
    fail: failJob,
    loadBooking,
    saveHubSpotIds,
  };
}

// --- For the admin page ------------------------------------------------------

export interface JobListItem {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  next_run_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  created_at: string;
  booking_id: string | null;
  bookings: { reference: string } | null;
}

const JOB_COLUMNS =
  "id, kind, payload, attempts, last_error, next_run_at, completed_at, failed_at, created_at, booking_id, bookings ( reference )";

/** Jobs that need attention first, then the most recent. */
export async function listJobs(): Promise<{ open: JobListItem[]; recent: JobListItem[] }> {
  const db = createServiceClient();
  const [open, recent] = await Promise.all([
    db.from("sync_jobs").select(JOB_COLUMNS).is("completed_at", null).order("created_at").limit(100),
    db
      .from("sync_jobs")
      .select(JOB_COLUMNS)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(25),
  ]);
  if (open.error) logDbError("listJobs.open", open.error);
  if (recent.error) logDbError("listJobs.recent", recent.error);
  return {
    open: (open.data ?? []) as unknown as JobListItem[],
    recent: (recent.data ?? []) as unknown as JobListItem[],
  };
}
