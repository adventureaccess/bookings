import { isIP } from "node:net";
import { ActionError, defineAction, type ActionAPIContext } from "astro:actions";
import { hashAccessToken, isAccessToken } from "../lib/bookings/token";
import {
  createWaiverDraft,
  deleteWaiverDraft,
  getBookingDocuments,
  markDocumentFileDeleted,
  publishWaiver,
  recordDocument,
  reviewDocument,
  signWaiver,
} from "../lib/documents/db";
import { checkUpload, documentFileName, DOCUMENT_KINDS, KIND_LABEL } from "../lib/documents/files";
import { documentStore } from "../lib/documents/store";
import { bookingReference } from "../lib/schemas";
import { formText, formUuid, requireAdmin, requireWriter } from "./guards";

/**
 * Document actions. Two are public, for a traveler on their own booking:
 * uploading a file and signing the waiver. The rest are for staff.
 */

export type DocumentActionResult =
  | { ok: true }
  | { ok: false; message: string; travelerId?: string };

const failed = (message: string, travelerId?: string): DocumentActionResult => ({
  ok: false,
  message,
  ...(travelerId ? { travelerId } : {}),
});

function clientIp(context: ActionAPIContext): string | null {
  try {
    return isIP(context.clientAddress) ? context.clientAddress : null;
  } catch {
    return null;
  }
}

/** The booking named by the form's reference and token, or a not-found error. */
async function ownBooking(form: FormData) {
  const reference = formText(form, "reference", 20);
  const token = formText(form, "token", 64);
  if (!bookingReference.safeParse(reference).success || !isAccessToken(token)) {
    throw new ActionError({ code: "NOT_FOUND", message: "That booking was not found." });
  }
  const accessTokenHash = hashAccessToken(token);
  const docs = await getBookingDocuments(reference, accessTokenHash);
  if (!docs) throw new ActionError({ code: "NOT_FOUND", message: "That booking was not found." });
  return { reference, accessTokenHash, docs };
}

const REFUSAL: Record<string, string> = {
  closed: "This booking is canceled, so nothing more can be added to it.",
  not_your_traveler: "That traveler is not on this booking.",
  not_required: "That document is not needed for this trip.",
  waiver_changed: "The waiver was updated. Reload the page, read it again and sign.",
};

export const documentActions = {
  /**
   * A traveler uploads their insurance proof or passport copy. The file is
   * checked, sent straight to the Shared Drive, and only its ID is kept.
   */
  uploadDocument: defineAction({
    accept: "form",
    handler: async (form): Promise<DocumentActionResult> => {
      const { reference, accessTokenHash, docs } = await ownBooking(form);
      const travelerId = formUuid(form, "traveler_id");
      const kind = DOCUMENT_KINDS.find((k) => k === formText(form, "kind", 20));

      const traveler = docs.travelers.find((t) => t.id === travelerId);
      if (!traveler) return failed(REFUSAL.not_your_traveler as string);
      if (!kind || !docs.required.includes(kind)) return failed(REFUSAL.not_required as string, travelerId);
      if (docs.status === "canceled" || docs.status === "refunded") {
        return failed(REFUSAL.closed as string, travelerId);
      }

      const checked = await checkUpload(form.get("file"));
      if (!checked.ok) return failed(checked.message, travelerId);

      const store = documentStore();
      if (!store) {
        return failed(
          "Uploads are not switched on yet. Write to info@adventure-access.com and we will tell you how to send it.",
          travelerId,
        );
      }

      const fileName = documentFileName({
        reference,
        firstName: traveler.first_name,
        lastName: traveler.last_name,
        kind,
        extension: checked.type.extension,
        date: new Date().toISOString().slice(0, 10),
      });

      let fileId: string;
      try {
        fileId = (await store.upload({ name: fileName, mime: checked.type.mime, bytes: checked.bytes })).id;
      } catch (error) {
        console.error("[documents] upload failed", {
          store: store.name,
          status: (error as { status?: number }).status ?? "unknown",
        });
        return failed("We could not store that file just now. Nothing was saved. Try again in a moment.", travelerId);
      }

      const recorded = await recordDocument({
        reference,
        accessTokenHash,
        travelerId,
        kind,
        driveFileId: fileId,
        fileName,
      });
      if (!recorded.ok) {
        return failed(
          REFUSAL[recorded.reason] ?? `We could not record your ${KIND_LABEL[kind].toLowerCase()}. Try again.`,
          travelerId,
        );
      }
      return { ok: true };
    },
  }),

  /** A traveler signs the waiver by typing their full name. */
  signWaiver: defineAction({
    accept: "form",
    handler: async (form, context): Promise<DocumentActionResult> => {
      const { reference, accessTokenHash, docs } = await ownBooking(form);
      const travelerId = formUuid(form, "traveler_id");
      const waiverVersionId = formUuid(form, "waiver_version_id");
      const signedName = formText(form, "signed_name", 200);

      if (!docs.travelers.some((t) => t.id === travelerId)) {
        return failed(REFUSAL.not_your_traveler as string);
      }
      if (formText(form, "agree", 5) !== "yes") {
        return failed("Tick the box to confirm you have read and agree to the waiver.", travelerId);
      }
      if (signedName.length < 2 || signedName.length > 160 || !/\s/.test(signedName)) {
        return failed("Type your full name, first and last, to sign.", travelerId);
      }

      const result = await signWaiver({
        reference,
        accessTokenHash,
        travelerId,
        waiverVersionId,
        signedName,
        ip: clientIp(context),
        userAgent: (context.request.headers.get("user-agent") ?? "").slice(0, 500),
      });
      if (!result.ok) {
        return failed(REFUSAL[result.reason] ?? "We could not record your signature. Try again.", travelerId);
      }
      return { ok: true };
    },
  }),

  /** Staff accept a document, or reject it with a note the traveler will see. */
  reviewDocument: defineAction({
    accept: "form",
    handler: async (form, context): Promise<DocumentActionResult> => {
      const staff = requireWriter(context);
      const documentId = formUuid(form, "document_id");
      const decision = formText(form, "decision", 10);
      const note = formText(form, "note", 500);
      if (decision !== "accepted" && decision !== "rejected") {
        return failed("Choose accept or reject.");
      }
      if (decision === "rejected" && note === "") {
        return failed("Say what is wrong, so the traveler knows what to send instead.");
      }
      const result = await reviewDocument(documentId, decision, note, staff);
      return result.ok ? { ok: true } : failed(result.message);
    },
  }),

  /** Staff record that a file has been deleted from the Shared Drive. */
  markDocumentDeleted: defineAction({
    accept: "form",
    handler: async (form, context): Promise<DocumentActionResult> => {
      const staff = requireWriter(context);
      const result = await markDocumentFileDeleted(formUuid(form, "document_id"), staff);
      return result.ok ? { ok: true } : failed(result.message);
    },
  }),

  /** An admin uploads a waiver PDF as a new draft version. */
  uploadWaiver: defineAction({
    accept: "form",
    handler: async (form, context): Promise<DocumentActionResult> => {
      const staff = requireAdmin(context);
      const title = formText(form, "title", 200);
      if (title === "") return failed("Give the waiver a title.");
      const checked = await checkUpload(form.get("file"), ["application/pdf"]);
      if (!checked.ok) return failed(checked.message);
      const raw = form.get("file");
      const fileName = raw instanceof File && raw.name ? raw.name.slice(0, 200) : "waiver.pdf";
      const result = await createWaiverDraft({ title, fileName, bytes: checked.bytes }, staff);
      return result.ok ? { ok: true } : failed(result.message);
    },
  }),

  /** An admin publishes a waiver version. It can never change afterward. */
  publishWaiver: defineAction({
    accept: "form",
    handler: async (form, context): Promise<DocumentActionResult> => {
      const staff = requireAdmin(context);
      const result = await publishWaiver(formUuid(form, "id"), staff);
      return result.ok ? { ok: true } : failed(result.message);
    },
  }),

  deleteWaiverDraft: defineAction({
    accept: "form",
    handler: async (form, context): Promise<DocumentActionResult> => {
      const staff = requireAdmin(context);
      const result = await deleteWaiverDraft(formUuid(form, "id"), staff);
      return result.ok ? { ok: true } : failed(result.message);
    },
  }),
};
