import { formatDateRange } from "../dates";
import { formatUsd } from "../money";

/**
 * Every email the app sends, as plain text. Short sentences, no hype.
 *
 * Traveler emails say what happened and what to do next. Staff emails say
 * which booking and link to it in the admin. No email ever carries a
 * document, a card detail, or anything read from a passport.
 */

export const EMAIL_TEMPLATES = [
  "traveler_registered",
  "traveler_new_link",
  "traveler_booking_confirmed",
  "traveler_payment_received",
  "staff_new_booking",
  "staff_payment_received",
  "staff_document_received",
  "staff_sync_failed",
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

export function isEmailTemplate(value: unknown): value is EmailTemplate {
  return typeof value === "string" && (EMAIL_TEMPLATES as readonly string[]).includes(value);
}

/** What the templates know about a booking. */
export interface EmailBooking {
  reference: string;
  trip_title: string;
  start_date: string;
  end_date: string;
  traveler_count: number;
  total_cents: number;
  discount_cents: number;
  paid_cents: number;
  balance_due_date: string;
  lead_first_name: string;
  lead_name: string;
  group_name: string | null;
}

export interface EmailMessage {
  /** Who it goes to: the booking's own traveler, or the staff inbox. */
  to: "traveler" | "staff";
  subject: string;
  text: string;
}

const SIGN_OFF = "Adventure Access\ninfo@adventure-access.com";

const balance = (b: EmailBooking) => Math.max(b.total_cents - b.discount_cents - b.paid_cents, 0);
const cents = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const lines = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter((part): part is string => typeof part === "string").join("\n");

const DOCUMENT_LABEL: Record<string, string> = {
  insurance: "proof of travel insurance",
  passport: "a passport copy",
};

/**
 * Builds one email. `payload` is the queued job's own data; `adminUrl` is the
 * booking's page in the admin. Returns null when the job cannot be turned
 * into an email, for example a link email whose link is missing.
 */
export function renderEmail(
  template: EmailTemplate,
  booking: EmailBooking,
  payload: Record<string, unknown>,
  adminUrl: string,
): EmailMessage | null {
  const trip = `${booking.trip_title}, ${formatDateRange(booking.start_date, booking.end_date)}`;
  const owed = balance(booking);
  const who = booking.group_name ? `${booking.lead_name} (${booking.group_name})` : booking.lead_name;

  switch (template) {
    case "traveler_registered": {
      const url = text(payload.url);
      if (!url) return null;
      return {
        to: "traveler",
        subject: `You are registered: ${booking.trip_title} (${booking.reference})`,
        text: lines(
          `Hello ${booking.lead_first_name},`,
          "",
          `You are registered for ${trip}.`,
          "",
          "Your booking page:",
          url,
          "",
          "On that page you can pay your deposit, hand in your documents and see what is still needed. Keep this email: the link is the way back to your booking, and anyone who has it can open it.",
          "",
          "Your place is confirmed once the deposit is paid.",
          "",
          SIGN_OFF,
        ),
      };
    }

    case "traveler_new_link": {
      const url = text(payload.url);
      if (!url) return null;
      return {
        to: "traveler",
        subject: `A new link to your booking (${booking.reference})`,
        text: lines(
          `Hello ${booking.lead_first_name},`,
          "",
          `Here is a new link to your booking for ${trip}:`,
          url,
          "",
          "Any earlier link to this booking has stopped working.",
          "",
          SIGN_OFF,
        ),
      };
    }

    case "traveler_booking_confirmed":
      return {
        to: "traveler",
        subject: `Your place is confirmed: ${booking.trip_title} (${booking.reference})`,
        text: lines(
          `Hello ${booking.lead_first_name},`,
          "",
          `Your place on ${trip} is confirmed.`,
          "",
          `Travelers: ${booking.traveler_count}`,
          `Paid so far: ${formatUsd(booking.paid_cents)}`,
          owed > 0 ? `Balance: ${formatUsd(owed)}` : "Balance: nothing more to pay",
          "",
          "To pay the balance or hand in your documents, open your booking page with the link in your registration email.",
          "",
          SIGN_OFF,
        ),
      };

    case "traveler_payment_received": {
      const amount = cents(payload.amount_cents);
      if (amount === null) return null;
      return {
        to: "traveler",
        subject: `Payment received: ${formatUsd(amount)} (${booking.reference})`,
        text: lines(
          `Hello ${booking.lead_first_name},`,
          "",
          `We received ${formatUsd(amount)} toward ${trip}. Thank you.`,
          "",
          `Paid so far: ${formatUsd(booking.paid_cents)}`,
          owed > 0 ? `Balance: ${formatUsd(owed)}` : "Balance: nothing more to pay",
          "",
          "If you paid by card, any card fee is shown on your receipt from Stripe and is not part of these amounts.",
          "",
          SIGN_OFF,
        ),
      };
    }

    case "staff_new_booking":
      return {
        to: "staff",
        subject: `New registration: ${who}, ${booking.trip_title} (${booking.reference})`,
        text: lines(
          `${who} registered for ${trip}.`,
          "",
          `Travelers: ${booking.traveler_count}`,
          `Total: ${formatUsd(booking.total_cents)}`,
          "Nothing is paid yet.",
          "",
          adminUrl,
        ),
      };

    case "staff_payment_received": {
      const amount = cents(payload.amount_cents);
      if (amount === null) return null;
      return {
        to: "staff",
        subject: `Payment: ${formatUsd(amount)} from ${who} (${booking.reference})`,
        text: lines(
          `${formatUsd(amount)} was recorded for ${who}, ${trip}.`,
          "",
          `Paid so far: ${formatUsd(booking.paid_cents)}`,
          `Balance: ${formatUsd(owed)}`,
          "",
          adminUrl,
        ),
      };
    }

    case "staff_document_received": {
      const kind = DOCUMENT_LABEL[text(payload.document_kind)] ?? "a document";
      return {
        to: "staff",
        subject: `Document to review: ${who} (${booking.reference})`,
        text: lines(
          `${who} handed in ${kind} for ${trip}.`,
          "",
          "Open the booking to review it:",
          `${adminUrl}#documents`,
        ),
      };
    }

    case "staff_sync_failed": {
      const what =
        text(payload.failed_kind) === "hubspot"
          ? "The HubSpot update"
          : `An email (${text(payload.failed_template) || "unknown"})`;
      return {
        to: "staff",
        subject: `Needs a look: sync failed for ${booking.reference}`,
        text: lines(
          `${what} for booking ${booking.reference} (${who}, ${trip}) failed after several tries and has stopped retrying.`,
          "",
          "Open Sync in the admin to see the error and retry it. The booking itself is not affected.",
          "",
          adminUrl,
        ),
      };
    }
  }
}
