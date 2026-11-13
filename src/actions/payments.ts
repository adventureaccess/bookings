import { ActionError, defineAction } from "astro:actions";
import { cancelBooking, clearBookingAttention, logActivity } from "../lib/admin/db";
import { getBookingSummary } from "../lib/bookings/db";
import { rememberBooking } from "../lib/bookings/session";
import { hashAccessToken, isAccessToken } from "../lib/bookings/token";
import { isIsoDate } from "../lib/dates";
import { parseDollarsToCents } from "../lib/money";
import { checkoutParams, PAYMENT_HOLD_MINUTES } from "../lib/payments/checkout";
import {
  addAdjustment,
  getLeadEmail,
  OFFLINE_METHODS,
  preparePayment,
  recordOfflinePayment,
  setCardFeeBps,
  voidPayment,
} from "../lib/payments/db";
import { formatFeePercent, parseFeePercent, payOptions } from "../lib/payments/due";
import { allowRequest, callerAddress } from "../lib/rate-limit";
import { TOO_MANY } from "../lib/rate-limit-rules";
import { bookingReference } from "../lib/schemas";
import { stripeClient, StripeNotConfigured } from "../lib/stripe/client";
import { formText, formUuid, requireAdmin, requireWriter } from "./guards";

/**
 * Money actions. One is public: a traveler starting a card payment on their
 * own booking. The rest are for staff and check the role themselves.
 */

export type StartPaymentResult = { ok: true; url: string } | { ok: false; message: string };
export type MoneyFormResult = { ok: true } | { ok: false; message: string };

const failed = (message: string): { ok: false; message: string } => ({ ok: false, message });

export const paymentActions = {
  /**
   * A traveler pays by card. The form says which booking (reference plus
   * token) and which option; the amount is worked out here from the database
   * and the card fee from settings. The browser never sends an amount.
   */
  startPayment: defineAction({
    accept: "form",
    handler: async (form, context): Promise<StartPaymentResult> => {
      if (!(await allowRequest("payment_start", callerAddress(context)))) return failed(TOO_MANY);
      const reference = formText(form, "reference", 20);
      const token = formText(form, "token", 64);
      const choice = formText(form, "option", 20);
      if (!bookingReference.safeParse(reference).success || !isAccessToken(token)) {
        throw new ActionError({ code: "NOT_FOUND", message: "That booking was not found." });
      }

      const booking = await getBookingSummary(reference, hashAccessToken(token));
      if (!booking) {
        throw new ActionError({ code: "NOT_FOUND", message: "That booking was not found." });
      }
      if (booking.status === "canceled" || booking.status === "refunded") {
        return failed("This booking is canceled, so it cannot be paid.");
      }

      const option = payOptions(booking).find((o) => o.key === choice);
      if (!option) {
        return failed("That payment is no longer due. The amounts below are up to date.");
      }

      // A pending booking must hold its seats for as long as the card page is open.
      const prepared = await preparePayment(booking.booking_id, PAYMENT_HOLD_MINUTES);
      if (!prepared.ok) {
        return failed(
          prepared.reason === "not_enough_seats"
            ? "Your hold ran out and the seats have been taken. Nothing was charged. Write to info@adventure-access.com and we will help."
            : prepared.reason === "closed"
              ? "This departure is no longer open for payment. Write to info@adventure-access.com."
              : "We could not start the payment just now. Nothing was charged. Try again in a moment.",
        );
      }

      const email = await getLeadEmail(reference, hashAccessToken(token));
      let url: string | null;
      try {
        const session = await stripeClient().checkout.sessions.create(
          checkoutParams({
            bookingId: booking.booking_id,
            reference: booking.reference,
            tripTitle: booking.trip_title,
            startDate: booking.start_date,
            endDate: booking.end_date,
            option,
            feeBps: booking.card_fee_bps,
            email,
            origin: context.url.origin,
          }),
        );
        url = session.url;
      } catch (error) {
        if (error instanceof StripeNotConfigured) {
          return failed(
            "Card payment is not switched on yet. To pay, write to info@adventure-access.com with your booking reference.",
          );
        }
        console.error("[payments] could not create a checkout session", {
          type: error instanceof Error ? error.name : "unknown",
        });
        url = null;
      }
      if (!url) {
        return failed("We could not reach the card page just now. Nothing was charged. Try again in a moment.");
      }

      // So the return page can bring them back here without Stripe ever
      // seeing the token.
      rememberBooking(context.cookies, { reference, token });
      return { ok: true, url };
    },
  }),

  /** The system-wide card fee. Admins only. */
  saveCardFee: defineAction({
    accept: "form",
    handler: async (form, context): Promise<MoneyFormResult> => {
      const staff = requireAdmin(context);
      const bps = parseFeePercent(formText(form, "card_fee", 10));
      if (bps === null) return failed("Enter a percentage from 0 to 10, like 3 or 2.9.");
      if (!(await setCardFeeBps(bps))) return failed("Could not save the card fee. Try again.");
      await logActivity(staff, "settings", null, "set_card_fee", {
        card_fee_percent: formatFeePercent(bps),
      });
      return { ok: true };
    },
  }),

  /** A wire, ACH, check or cash payment, entered by staff. */
  recordOfflinePayment: defineAction({
    accept: "form",
    handler: async (form, context): Promise<MoneyFormResult> => {
      const staff = requireWriter(context);
      const bookingId = formUuid(form, "booking_id");
      const method = OFFLINE_METHODS.find((m) => m === formText(form, "method", 10));
      const amount = parseDollarsToCents(formText(form, "amount", 20));
      const receivedOn = formText(form, "received_on", 10);
      const note = formText(form, "note", 500);

      if (!method) return failed("Choose how the money arrived.");
      if (amount === null || amount <= 0) return failed("Enter the amount in dollars, like 750.");
      if (!isIsoDate(receivedOn)) return failed("Enter the date the money was received.");
      if (receivedOn > new Date().toISOString().slice(0, 10)) {
        return failed("The date received cannot be in the future.");
      }

      const result = await recordOfflinePayment({
        bookingId,
        method,
        amountCents: amount,
        receivedOn,
        note,
        recordedBy: staff.email,
      });
      if (!result.ok) return failed("Could not record the payment. Nothing was saved.");
      await logActivity(staff, "booking", bookingId, "record_offline_payment", {
        method,
        amount_cents: amount,
        received_on: receivedOn,
        status_after: result.money.status,
      });
      return { ok: true };
    },
  }),

  /** Takes an offline payment back. The row stays, marked voided. */
  voidPayment: defineAction({
    accept: "form",
    handler: async (form, context): Promise<MoneyFormResult> => {
      const staff = requireWriter(context);
      const paymentId = formUuid(form, "payment_id");
      const reason = formText(form, "reason", 500);
      if (reason === "") return failed("Say why this payment is being voided.");

      const result = await voidPayment(paymentId, reason);
      if (!result.ok) {
        return failed(
          result.reason === "not_voidable"
            ? "That payment cannot be voided. Card payments are refunded in Stripe, and a payment can only be voided once."
            : "Could not void the payment. Nothing was changed.",
        );
      }
      await logActivity(staff, "booking", result.money.booking_id, "void_payment", {
        payment_id: paymentId,
        reason,
        status_after: result.money.status,
      });
      return { ok: true };
    },
  }),

  /** Clears the "needs attention" flag once staff have sorted a booking out. */
  markBookingReviewed: defineAction({
    accept: "form",
    handler: async (form, context): Promise<MoneyFormResult> => {
      const staff = requireWriter(context);
      const ok = await clearBookingAttention(formUuid(form, "booking_id"), staff);
      return ok ? { ok: true } : failed("Could not update the booking. Try again.");
    },
  }),

  /** Cancels a booking and frees its seats. Money received stays on record. */
  cancelBooking: defineAction({
    accept: "form",
    handler: async (form, context): Promise<MoneyFormResult> => {
      const staff = requireWriter(context);
      const reason = formText(form, "reason", 500);
      if (reason === "") return failed("Say why this booking is being canceled.");
      const ok = await cancelBooking(formUuid(form, "booking_id"), reason, staff);
      return ok
        ? { ok: true }
        : failed("Could not cancel the booking. It may already be canceled.");
    },
  }),

  /** A credit on a booking, or a credit taken back. */
  addCredit: defineAction({
    accept: "form",
    handler: async (form, context): Promise<MoneyFormResult> => {
      const staff = requireWriter(context);
      const bookingId = formUuid(form, "booking_id");
      const amount = parseDollarsToCents(formText(form, "amount", 20));
      const reason = formText(form, "reason", 500);
      const remove = formText(form, "direction", 10) === "remove";

      if (amount === null || amount <= 0) return failed("Enter the credit in dollars, like 500.");
      if (reason === "") return failed("Say what the credit is for.");

      const result = await addAdjustment({
        bookingId,
        amountCents: remove ? -amount : amount,
        reason,
        createdBy: staff.email,
      });
      if (!result.ok) {
        return failed(
          result.reason === "out_of_range"
            ? "Credits cannot add up to less than zero or more than the booking's total."
            : "Could not save the credit. Nothing was changed.",
        );
      }
      await logActivity(staff, "booking", bookingId, remove ? "remove_credit" : "add_credit", {
        amount_cents: amount,
        reason,
        status_after: result.money.status,
      });
      return { ok: true };
    },
  }),
};
