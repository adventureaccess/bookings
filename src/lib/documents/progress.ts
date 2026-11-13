import type { BookingDocuments } from "./db";
import { DOCUMENT_KINDS, type DocumentKind } from "./files";

/**
 * Where a booking's documents stand, for staff: counted from the raw upload
 * and signature rows. The newest upload of each kind is the one that counts.
 */

export interface UploadRow {
  traveler_id: string;
  kind: DocumentKind;
  status: "submitted" | "accepted" | "rejected";
  created_at: string;
}

export interface SignatureRow {
  traveler_id: string;
  waiver_version_id: string;
}

export interface StaffProgress {
  /** Every item asked of every traveler: files plus the waiver. */
  total: number;
  /** Accepted files and signed waivers. */
  done: number;
  /** Uploaded and waiting for staff to look. */
  toReview: number;
  /** Not sent, not signed, or rejected and not sent again. */
  missing: number;
}

/** The documents a departure asks for, read from its stored list. */
export function requiredKinds(raw: unknown): DocumentKind[] {
  return Array.isArray(raw) ? DOCUMENT_KINDS.filter((kind) => (raw as unknown[]).includes(kind)) : [];
}

/** The newest upload for one traveler and kind, or undefined. */
export function latestUpload<T extends UploadRow>(
  uploads: T[],
  travelerId: string,
  kind: DocumentKind,
): T | undefined {
  let latest: T | undefined;
  for (const upload of uploads) {
    if (upload.traveler_id !== travelerId || upload.kind !== kind) continue;
    if (!latest || upload.created_at > latest.created_at) latest = upload;
  }
  return latest;
}

export function staffProgress(input: {
  travelerIds: string[];
  required: DocumentKind[];
  waiverVersionId: string | null;
  uploads: UploadRow[];
  signatures: SignatureRow[];
}): StaffProgress {
  const progress: StaffProgress = { total: 0, done: 0, toReview: 0, missing: 0 };
  for (const travelerId of input.travelerIds) {
    for (const kind of input.required) {
      progress.total += 1;
      const upload = latestUpload(input.uploads, travelerId, kind);
      if (!upload || upload.status === "rejected") progress.missing += 1;
      else if (upload.status === "accepted") progress.done += 1;
      else progress.toReview += 1;
    }
    if (input.waiverVersionId) {
      progress.total += 1;
      const signed = input.signatures.some(
        (s) => s.traveler_id === travelerId && s.waiver_version_id === input.waiverVersionId,
      );
      if (signed) progress.done += 1;
      else progress.missing += 1;
    }
  }
  return progress;
}

/** "All 3 in", "1 of 3 in, 1 to review", "Nothing asked for". */
export function progressLabel(progress: StaffProgress): string {
  if (progress.total === 0) return "Nothing asked for";
  if (progress.done === progress.total) return `All ${progress.total} in`;
  const parts = [`${progress.done} of ${progress.total} in`];
  if (progress.toReview > 0) parts.push(`${progress.toReview} to review`);
  return parts.join(", ");
}

/** How many of a booking's document tasks are done, for a one-line summary. */
export function documentProgress(docs: Pick<BookingDocuments, "required" | "waiver" | "travelers">): {
  total: number;
  handedIn: number;
  accepted: number;
  needsAction: number;
} {
  let total = 0;
  let handedIn = 0;
  let accepted = 0;
  let needsAction = 0;
  for (const traveler of docs.travelers) {
    for (const kind of docs.required) {
      total += 1;
      const state = traveler.documents[kind];
      if (!state || state.status === "rejected") needsAction += 1;
      else handedIn += 1;
      if (state?.status === "accepted") accepted += 1;
    }
    if (docs.waiver) {
      total += 1;
      if (traveler.waiver_signed_at) {
        handedIn += 1;
        accepted += 1;
      } else needsAction += 1;
    }
  }
  return { total, handedIn, accepted, needsAction };
}
