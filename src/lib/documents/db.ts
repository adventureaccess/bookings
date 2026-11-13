import { createHash } from "node:crypto";
import type { StaffSession } from "../auth/staff";
import { logActivity } from "../admin/db";
import { createServiceClient } from "../supabase/service";
import { DOCUMENT_KINDS, type DocumentKind } from "./files";

/**
 * Documents and waivers in the database. Travelers reach their own through
 * purpose-built SQL functions that need the booking's token hash; staff
 * reads and reviews happen after the admin role check.
 */

/** Logs the database error code only. Messages can contain row values. */
function logDbError(where: string, error: { code?: string } | null): void {
  console.error(`[documents] ${where} failed`, { code: error?.code ?? "unknown" });
}

// --- The traveler's side -----------------------------------------------------

export interface DocumentState {
  status: "submitted" | "accepted" | "rejected";
  note: string | null;
  uploaded_at: string;
}

export interface TravelerDocuments {
  id: string;
  first_name: string;
  last_name: string;
  is_lead: boolean;
  documents: Partial<Record<DocumentKind, DocumentState>>;
  waiver_signed_at: string | null;
}

export interface BookingDocuments {
  booking_id: string;
  reference: string;
  status: "pending" | "deposit_paid" | "paid_in_full" | "canceled" | "refunded";
  required: DocumentKind[];
  waiver: { id: string; version: number; title: string } | null;
  travelers: TravelerDocuments[];
}

/** What a booking is asked for and where each item stands. Needs the booking's token hash. */
export async function getBookingDocuments(
  reference: string,
  accessTokenHash: string,
): Promise<BookingDocuments | null> {
  const { data, error } = await createServiceClient().rpc("booking_documents", {
    p_reference: reference,
    p_access_token_hash: accessTokenHash,
  });
  if (error) logDbError("getBookingDocuments", error);
  if (!data) return null;
  const raw = data as BookingDocuments & { required: unknown };
  const required = Array.isArray(raw.required)
    ? DOCUMENT_KINDS.filter((kind) => (raw.required as unknown[]).includes(kind))
    : [];
  return { ...raw, required };
}

export type DocumentWriteResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "closed" | "not_your_traveler" | "not_required" | "waiver_changed" | "error" };

export async function recordDocument(input: {
  reference: string;
  accessTokenHash: string;
  travelerId: string;
  kind: DocumentKind;
  driveFileId: string;
  fileName: string;
}): Promise<DocumentWriteResult> {
  const { data, error } = await createServiceClient().rpc("record_document", {
    p_reference: input.reference,
    p_access_token_hash: input.accessTokenHash,
    p_traveler_id: input.travelerId,
    p_kind: input.kind,
    p_drive_file_id: input.driveFileId,
    p_file_name: input.fileName,
  });
  if (error || !data) {
    logDbError("recordDocument", error);
    return { ok: false, reason: "error" };
  }
  return data as DocumentWriteResult;
}

export async function signWaiver(input: {
  reference: string;
  accessTokenHash: string;
  travelerId: string;
  waiverVersionId: string;
  signedName: string;
  ip: string | null;
  userAgent: string;
}): Promise<DocumentWriteResult> {
  const { data, error } = await createServiceClient().rpc("sign_waiver", {
    p_reference: input.reference,
    p_access_token_hash: input.accessTokenHash,
    p_traveler_id: input.travelerId,
    p_waiver_version_id: input.waiverVersionId,
    p_signed_name: input.signedName,
    p_ip: input.ip,
    p_user_agent: input.userAgent,
  });
  if (error || !data) {
    logDbError("signWaiver", error);
    return { ok: false, reason: "error" };
  }
  return data as DocumentWriteResult;
}

/** A published waiver's PDF, for the page that shows it to travelers. */
export async function getWaiverFile(id: string): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  const { data, error } = await createServiceClient().rpc("waiver_file", { p_waiver_version_id: id });
  if (error) logDbError("getWaiverFile", error);
  const file = data as { file_name: string; file_base64: string } | null;
  if (!file) return null;
  return { fileName: file.file_name, bytes: new Uint8Array(Buffer.from(file.file_base64, "base64")) };
}

// --- Staff: waiver versions --------------------------------------------------

export interface WaiverVersion {
  id: string;
  title: string;
  version: number;
  file_name: string;
  byte_size: number;
  published_at: string | null;
  created_at: string;
}

const WAIVER_COLUMNS = "id, title, version, file_name, byte_size, published_at, created_at";

export async function listWaivers(): Promise<WaiverVersion[]> {
  const { data, error } = await createServiceClient()
    .from("waiver_versions")
    .select(WAIVER_COLUMNS)
    .order("version", { ascending: false });
  if (error) logDbError("listWaivers", error);
  return (data ?? []) as WaiverVersion[];
}

export type StaffResult = { ok: true } | { ok: false; message: string };
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** Saves an uploaded PDF as a new draft version. */
export async function createWaiverDraft(
  input: { title: string; fileName: string; bytes: Uint8Array },
  staff: StaffSession,
): Promise<StaffResult> {
  const db = createServiceClient();
  const { data: latest, error: readError } = await db
    .from("waiver_versions")
    .select("version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readError) {
    logDbError("createWaiverDraft.read", readError);
    return fail("Could not read the existing waivers.");
  }
  const version = ((latest?.version as number | undefined) ?? 0) + 1;
  const { data, error } = await db
    .from("waiver_versions")
    .insert({
      title: input.title,
      version,
      file_name: input.fileName,
      file_base64: Buffer.from(input.bytes).toString("base64"),
      file_sha256: createHash("sha256").update(input.bytes).digest("hex"),
      byte_size: input.bytes.length,
    })
    .select("id")
    .single();
  if (error || !data) {
    logDbError("createWaiverDraft", error);
    return fail("Could not save the waiver. Try again.");
  }
  await logActivity(staff, "waiver", data.id as string, "create", { version, title: input.title });
  return { ok: true };
}

export async function publishWaiver(id: string, staff: StaffSession): Promise<StaffResult> {
  const { data, error } = await createServiceClient()
    .from("waiver_versions")
    .update({ published_at: new Date().toISOString() })
    .eq("id", id)
    .is("published_at", null)
    .select("version")
    .maybeSingle();
  if (error || !data) {
    logDbError("publishWaiver", error);
    return fail("Could not publish that version. It may already be published.");
  }
  await logActivity(staff, "waiver", id, "publish", { version: data.version });
  return { ok: true };
}

export async function deleteWaiverDraft(id: string, staff: StaffSession): Promise<StaffResult> {
  const { data, error } = await createServiceClient()
    .from("waiver_versions")
    .delete()
    .eq("id", id)
    .is("published_at", null)
    .select("version")
    .maybeSingle();
  if (error || !data) {
    logDbError("deleteWaiverDraft", error);
    return fail("Could not delete that draft. A published version cannot be deleted.");
  }
  await logActivity(staff, "waiver", id, "delete_draft", { version: data.version });
  return { ok: true };
}

// --- Staff: reviewing documents ----------------------------------------------

export interface StaffDocument {
  id: string;
  booking_id: string;
  traveler_id: string;
  kind: DocumentKind;
  drive_file_id: string;
  file_name: string;
  status: "submitted" | "accepted" | "rejected";
  note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  file_deleted_at: string | null;
  created_at: string;
}

export interface StaffSignature {
  traveler_id: string;
  waiver_version_id: string;
  signed_name: string;
  accepted_at: string;
}

const DOCUMENT_COLUMNS =
  "id, booking_id, traveler_id, kind, drive_file_id, file_name, status, note, reviewed_by, reviewed_at, file_deleted_at, created_at";

/** Every upload and signature on the given bookings, newest upload first. */
export async function listDocumentsForBookings(
  bookingIds: string[],
): Promise<{ documents: StaffDocument[]; signatures: StaffSignature[] }> {
  if (bookingIds.length === 0) return { documents: [], signatures: [] };
  const db = createServiceClient();
  const [documents, signatures] = await Promise.all([
    db
      .from("traveler_documents")
      .select(DOCUMENT_COLUMNS)
      .in("booking_id", bookingIds)
      .order("created_at", { ascending: false }),
    db
      .from("waiver_acceptances")
      .select("traveler_id, waiver_version_id, signed_name, accepted_at")
      .in("booking_id", bookingIds),
  ]);
  if (documents.error) logDbError("listDocumentsForBookings.documents", documents.error);
  if (signatures.error) logDbError("listDocumentsForBookings.signatures", signatures.error);
  return {
    documents: (documents.data ?? []) as StaffDocument[],
    signatures: (signatures.data ?? []) as StaffSignature[],
  };
}

/** Accepts a document, or rejects it with a note the traveler will see. */
export async function reviewDocument(
  documentId: string,
  decision: "accepted" | "rejected",
  note: string,
  staff: StaffSession,
): Promise<StaffResult> {
  const { data, error } = await createServiceClient()
    .from("traveler_documents")
    .update({
      status: decision,
      note: note || null,
      reviewed_by: staff.email,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", documentId)
    .select("booking_id, kind")
    .maybeSingle();
  if (error || !data) {
    logDbError("reviewDocument", error);
    return fail("Could not save the review. Reload and try again.");
  }
  // The log says what was decided, never what the document contains.
  await logActivity(staff, "booking", data.booking_id as string, `document_${decision}`, {
    kind: data.kind,
  });
  return { ok: true };
}

/** Records that staff deleted the file from the Shared Drive. */
export async function markDocumentFileDeleted(documentId: string, staff: StaffSession): Promise<StaffResult> {
  const { data, error } = await createServiceClient()
    .from("traveler_documents")
    .update({ file_deleted_at: new Date().toISOString() })
    .eq("id", documentId)
    .is("file_deleted_at", null)
    .select("booking_id, kind")
    .maybeSingle();
  if (error || !data) {
    logDbError("markDocumentFileDeleted", error);
    return fail("Could not update that document.");
  }
  await logActivity(staff, "booking", data.booking_id as string, "document_file_deleted", {
    kind: data.kind,
  });
  return { ok: true };
}

export interface RetentionItem {
  departure_id: string;
  trip_title: string;
  end_date: string;
  passport_files: number;
}

/** Departures that ended more than `days` ago and still have passport files in the Drive. */
export async function listPassportRetention(days = 30): Promise<RetentionItem[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await createServiceClient()
    .from("traveler_documents")
    .select("id, bookings!inner ( departures!inner ( id, end_date, trips ( title ) ) )")
    .eq("kind", "passport")
    .is("file_deleted_at", null)
    .lt("bookings.departures.end_date", cutoff);
  if (error) logDbError("listPassportRetention", error);
  const byDeparture = new Map<string, RetentionItem>();
  for (const row of (data ?? []) as unknown as {
    bookings: { departures: { id: string; end_date: string; trips: { title: string } | null } };
  }[]) {
    const departure = row.bookings.departures;
    const item = byDeparture.get(departure.id) ?? {
      departure_id: departure.id,
      trip_title: departure.trips?.title ?? "Trip",
      end_date: departure.end_date,
      passport_files: 0,
    };
    item.passport_files += 1;
    byDeparture.set(departure.id, item);
  }
  return [...byDeparture.values()].sort((a, b) => a.end_date.localeCompare(b.end_date));
}
