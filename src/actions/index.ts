import { ActionError, defineAction } from "astro:actions";
import { TRIPS_FEED_URL, TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY } from "astro:env/server";
import {
  deleteDeparture,
  publishPolicy,
  saveDeparture,
  savePolicy,
  syncTrips,
  type TripSyncSummary,
} from "../lib/admin/db";
import { requireWriter, UUID } from "./guards";
import { documentActions } from "./documents";
import { itineraryActions } from "./itinerary";
import { paymentActions } from "./payments";
import { syncActions } from "./sync";
import {
  createBooking,
  getBookingSummary,
  getDepartureForBooking,
  type CreateBookingResult,
} from "../lib/bookings/db";
import {
  parseBookingForm,
  readQuestions,
  type BookingFormErrors,
  type BookingFormValues,
} from "../lib/bookings/form";
import { recallBooking, rememberBooking } from "../lib/bookings/session";
import { getLeadEmail } from "../lib/payments/db";
import { allowRequest, callerAddress } from "../lib/rate-limit";
import { TOO_MANY } from "../lib/rate-limit-rules";
import { enqueueBookingLinkEmail } from "../lib/sync/db";
import { TURNSTILE_FIELD, verifyTurnstile } from "../lib/turnstile";
import { hashAccessToken, newAccessToken } from "../lib/bookings/token";
import {
  parseDepartureForm,
  readDepartureValues,
  type DepartureFormErrors,
  type DepartureFormValues,
} from "../lib/departures/form";
import {
  parsePolicyForm,
  type PolicyFormErrors,
  type PolicyFormValues,
} from "../lib/policies/form";

/**
 * Admin actions. Each one is reachable directly at /_actions/<name> as well
 * as through its form, so each one checks the staff role itself. The
 * middleware has already resolved who is signed in.
 */


/** An optional record id from a hidden form field. "" means a new record. */
function readId(form: FormData): string | null {
  const raw = form.get("id");
  if (typeof raw !== "string" || raw === "") return null;
  if (!UUID.test(raw)) {
    throw new ActionError({ code: "BAD_REQUEST", message: "That record id is not valid." });
  }
  return raw;
}

function requireId(form: FormData): string {
  const id = readId(form);
  if (!id) throw new ActionError({ code: "BAD_REQUEST", message: "Missing record id." });
  return id;
}

export type DepartureActionResult =
  | { ok: true; id: string }
  | {
      ok: false;
      message?: string;
      errors: DepartureFormErrors;
      values: DepartureFormValues;
    };

export type PolicyActionResult =
  | { ok: true; id: string }
  | { ok: false; message?: string; errors: PolicyFormErrors; values: PolicyFormValues };

export type SimpleActionResult = { ok: true } | { ok: false; message: string };

export type SyncActionResult =
  | { ok: true; summary: TripSyncSummary }
  | { ok: false; message: string };

export type BookingActionResult =
  | { ok: true; reference: string; token: string }
  | { ok: false; message?: string; errors: BookingFormErrors; values: BookingFormValues };

function bookingRefusal(result: Extract<CreateBookingResult, { ok: false }>): string {
  switch (result.reason) {
    case "not_enough_seats":
      if (!result.seats_left) return "This departure just filled up. No seats are left.";
      return result.seats_left === 1
        ? "Only 1 seat is left on this departure. Change the number of travelers and try again."
        : `Only ${result.seats_left} seats are left on this departure. Change the number of travelers and try again.`;
    case "policy_changed":
      return "The booking terms changed while you were filling in the form. Reload the page, read them again and resubmit.";
    case "closed":
    case "not_found":
      return "This departure is no longer open for booking.";
    default:
      return "We could not take your booking just now. Nothing was held. Try again in a moment.";
  }
}

export const server = {
  ...paymentActions,
  ...itineraryActions,
  ...documentActions,
  ...syncActions,

  /**
   * The public booking form. No sign-in: anyone who can see the departure may
   * book it. The browser sends names and answers only; every amount comes
   * from the departure in the database.
   */
  createBooking: defineAction({
    accept: "form",
    handler: async (form, context): Promise<BookingActionResult> => {
      if (!(await allowRequest("booking_form", callerAddress(context)))) {
        return { ok: false, message: TOO_MANY, errors: {}, values: {} };
      }
      const departureId = form.get("departure_id");
      const rawKey = form.get("key");
      if (typeof departureId !== "string" || !UUID.test(departureId)) {
        throw new ActionError({ code: "BAD_REQUEST", message: "That departure is not valid." });
      }
      const key = typeof rawKey === "string" && rawKey !== "" ? rawKey.slice(0, 64) : null;

      const departure = await getDepartureForBooking(departureId, key);
      if (!departure) {
        throw new ActionError({ code: "NOT_FOUND", message: "That departure was not found." });
      }

      const parsed = parseBookingForm(form, {
        questions: readQuestions(departure.custom_questions),
      });
      if (!parsed.ok) {
        if (parsed.spam) {
          return { ok: false, message: bookingRefusal({ ok: false, reason: "error" }), errors: {}, values: {} };
        }
        return { ok: false, errors: parsed.errors, values: parsed.values };
      }

      // Is this a person? Checked once the form itself is in order, because a
      // Turnstile token can be used only once. Skipped until the keys are set.
      if (TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY) {
        const raw = form.get(TURNSTILE_FIELD);
        const human = await verifyTurnstile(
          typeof raw === "string" ? raw : "",
          TURNSTILE_SECRET_KEY,
          callerAddress(context),
        );
        if (!human) {
          return {
            ok: false,
            message:
              "We could not confirm you are a person. Wait for the check above the button to finish, then try again.",
            errors: {},
            values: parsed.values,
          };
        }
      }

      // Coming back to change details: reuse the pending booking and its hold.
      // Only for the same person, matched on email. Two people registering
      // one after the other on a shared computer each get their own booking.
      const remembered = recallBooking(context.cookies);
      const rememberedHash = remembered ? hashAccessToken(remembered.token) : "";
      const existing = remembered ? await getBookingSummary(remembered.reference, rememberedHash) : null;
      const samePerson =
        remembered && existing?.status === "pending" && existing.departure_id === departureId
          ? (await getLeadEmail(remembered.reference, rememberedHash)) ===
            parsed.data.travelers[0]?.email
          : false;
      const resume =
        remembered && existing && samePerson
          ? { id: existing.booking_id, token: remembered.token }
          : null;

      const token = resume?.token ?? newAccessToken();
      const result = await createBooking({
        departureId,
        key,
        policyVersionId: parsed.data.policy_version_id,
        travelers: parsed.data.travelers,
        accessTokenHash: hashAccessToken(token),
        ip: callerAddress(context),
        userAgent: (context.request.headers.get("user-agent") ?? "").slice(0, 500),
        source: "web",
        resumeBookingId: resume?.id ?? null,
      });
      if (!result.ok) {
        return { ok: false, message: bookingRefusal(result), errors: {}, values: parsed.values };
      }
      // A resumed booking keeps the token it already had; see `token` above.
      const pointer = { reference: result.reference, token };
      rememberBooking(context.cookies, pointer);
      // A new registration gets an email with the link to its booking page.
      // If queueing fails the traveler still has the page in front of them.
      if (!result.resumed) {
        await enqueueBookingLinkEmail(
          result.booking_id,
          "traveler_registered",
          `${context.url.origin}/booking/${result.reference}?t=${token}`,
        );
      }
      return { ok: true, ...pointer };
    },
  }),

  saveDeparture: defineAction({
    accept: "form",
    handler: async (form, context): Promise<DepartureActionResult> => {
      const staff = requireWriter(context);
      const id = readId(form);
      const parsed = parseDepartureForm(form);
      if (!parsed.ok) return parsed;
      const saved = await saveDeparture(id, parsed.data, staff);
      if (!saved.ok) {
        return {
          ok: false,
          message: saved.message,
          errors: {},
          values: readDepartureValues(form),
        };
      }
      return { ok: true, id: saved.value };
    },
  }),

  deleteDeparture: defineAction({
    accept: "form",
    handler: async (form, context): Promise<SimpleActionResult> => {
      const staff = requireWriter(context);
      const result = await deleteDeparture(requireId(form), staff);
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
  }),

  savePolicy: defineAction({
    accept: "form",
    handler: async (form, context): Promise<PolicyActionResult> => {
      const staff = requireWriter(context);
      const id = readId(form);
      const parsed = parsePolicyForm(form);
      if (!parsed.ok) return parsed;
      const saved = await savePolicy(id, parsed.data, staff);
      if (!saved.ok) {
        return { ok: false, message: saved.message, errors: {}, values: parsed.data };
      }
      return { ok: true, id: saved.value };
    },
  }),

  publishPolicy: defineAction({
    accept: "form",
    handler: async (form, context): Promise<SimpleActionResult> => {
      const staff = requireWriter(context);
      const result = await publishPolicy(requireId(form), staff);
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
  }),

  syncTrips: defineAction({
    accept: "form",
    handler: async (_form, context): Promise<SyncActionResult> => {
      const staff = requireWriter(context);
      const result = await syncTrips(TRIPS_FEED_URL, staff);
      return result.ok
        ? { ok: true, summary: result.value }
        : { ok: false, message: result.message };
    },
  }),
};
