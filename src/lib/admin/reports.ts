import { listDocumentsForBookings } from "../documents/db";
import { progressLabel, requiredKinds, staffProgress } from "../documents/progress";
import { createServiceClient } from "../supabase/service";
import type { ExportBooking } from "./export";

/**
 * Data for the bookings export and the activity log. Service role, after the
 * page or route has checked the staff role.
 */

/** Logs the database error code only. Messages can contain row values. */
function logDbError(where: string, error: { code?: string } | null): void {
  console.error(`[admin] ${where} failed`, { code: error?.code ?? "unknown" });
}

interface ExportRow {
  id: string;
  reference: string;
  status: string;
  traveler_count: number;
  total_cents: number;
  discount_cents: number;
  paid_cents: number;
  needs_attention: boolean;
  created_at: string;
  departures: {
    start_date: string;
    end_date: string;
    balance_due_date: string;
    group_name: string | null;
    required_documents: unknown;
    waiver_version_id: string | null;
    trips: { title: string } | null;
  } | null;
  travelers: (ExportBooking["travelers"][number] & { id: string })[];
}

/** Every booking, or one departure's, shaped for the CSV. Oldest first. */
export async function listBookingsForExport(departureId: string | null): Promise<ExportBooking[]> {
  let query = createServiceClient()
    .from("bookings")
    .select(
      `id, reference, status, traveler_count, total_cents, discount_cents, paid_cents,
       needs_attention, created_at,
       departures ( start_date, end_date, balance_due_date, group_name, required_documents,
                    waiver_version_id, trips ( title ) ),
       travelers!travelers_booking_id_fkey ( id, first_name, last_name, email, phone, is_lead, answers )`,
    )
    .order("created_at")
    .limit(5000);
  if (departureId) query = query.eq("departure_id", departureId);

  const { data, error } = await query;
  if (error) logDbError("listBookingsForExport", error);
  const rows = (data ?? []) as unknown as ExportRow[];
  const { documents, signatures } = await listDocumentsForBookings(rows.map((row) => row.id));

  return rows.map((row) => ({
    reference: row.reference,
    status: row.status,
    traveler_count: row.traveler_count,
    total_cents: row.total_cents,
    discount_cents: row.discount_cents,
    paid_cents: row.paid_cents,
    needs_attention: row.needs_attention,
    created_at: row.created_at,
    trip_title: row.departures?.trips?.title ?? "",
    group_name: row.departures?.group_name ?? null,
    start_date: row.departures?.start_date ?? "",
    end_date: row.departures?.end_date ?? "",
    balance_due_date: row.departures?.balance_due_date ?? "",
    documents: progressLabel(
      staffProgress({
        travelerIds: row.travelers.map((t) => t.id),
        required: requiredKinds(row.departures?.required_documents),
        waiverVersionId: row.departures?.waiver_version_id ?? null,
        uploads: documents,
        signatures,
      }),
    ),
    travelers: row.travelers,
  }));
}

export interface ActivityEntry {
  id: string;
  actor: string;
  entity: string;
  entity_id: string | null;
  action: string;
  data: Record<string, unknown>;
  created_at: string;
}

/** The newest activity, optionally for one booking, departure or other record. */
export async function listActivity(options: { entityId?: string | null; limit?: number } = {}): Promise<ActivityEntry[]> {
  let query = createServiceClient()
    .from("activity_log")
    .select("id, actor, entity, entity_id, action, data, created_at")
    .order("created_at", { ascending: false })
    .limit(options.limit ?? 200);
  if (options.entityId) query = query.eq("entity_id", options.entityId);
  const { data, error } = await query;
  if (error) logDbError("listActivity", error);
  return (data ?? []) as ActivityEntry[];
}

const ACTION_LABEL: Record<string, string> = {
  create: "Created",
  update: "Changed",
  delete: "Deleted",
  publish: "Published",
  sync: "Synced from the website",
  retry: "Retried",
  cancel: "Canceled",
  record_offline_payment: "Recorded a payment",
  void_payment: "Voided a payment",
  add_credit: "Added a credit",
  remove_credit: "Took back a credit",
  clear_attention: "Cleared the needs-a-look notice",
  set_card_fee: "Changed the card fee",
  set_hubspot_pipeline: "Chose the HubSpot pipeline",
  copy_itinerary: "Copied an itinerary",
  add_itinerary_item: "Added an itinerary item",
  edit_itinerary_item: "Changed an itinerary item",
  delete_itinerary_item: "Removed an itinerary item",
  document_accepted: "Accepted a document",
  document_rejected: "Rejected a document",
  document_file_deleted: "Recorded a file as deleted",
  send_new_link: "Sent a new booking link",
  delete_draft: "Deleted a draft",
  export_bookings: "Exported bookings",
};

/** "Recorded a payment" for record_offline_payment; the raw action if it is not known. */
export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/_/g, " ");
}

/** The entry's details as short "name: value" pairs. Amounts in cents become dollars. */
export function activityDetails(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === "" || typeof value === "object") continue;
    const name = key.replace(/_cents$/, "").replace(/_/g, " ");
    const shown =
      key.endsWith("_cents") && typeof value === "number" ? `$${(value / 100).toFixed(2)}` : String(value);
    parts.push(`${name}: ${shown.slice(0, 120)}`);
  }
  return parts.join(", ");
}

/** Where an entry's record lives in the admin, if it has a page. */
export function activityLink(entry: Pick<ActivityEntry, "entity" | "entity_id">): string | null {
  if (!entry.entity_id) return null;
  if (entry.entity === "booking") return `/admin/bookings/${entry.entity_id}`;
  if (entry.entity === "departure") return `/admin/departures/${entry.entity_id}`;
  if (entry.entity === "policy") return `/admin/policies/${entry.entity_id}`;
  return null;
}
