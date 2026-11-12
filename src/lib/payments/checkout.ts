import type Stripe from "stripe";
import { formatDateRange } from "../dates";
import { cardFeeCents, formatFeePercent, type PayOption } from "./due";

/**
 * Builds the Stripe Checkout Session for one card payment. Every amount
 * comes from the server: the option was worked out from the database, and
 * the fee from the system-wide setting. The same amounts go into the
 * session's metadata, which the webhook reads back.
 */

/** Stripe's shortest allowed session life is 30 minutes. One more for clock drift. */
export const SESSION_MINUTES = 31;
/** A pending booking's hold must outlast the session, so a paid session always has its seat. */
export const PAYMENT_HOLD_MINUTES = SESSION_MINUTES + 2;

export interface CheckoutInput {
  bookingId: string;
  reference: string;
  tripTitle: string;
  startDate: string;
  endDate: string;
  option: PayOption;
  feeBps: number;
  email: string | null;
  /** The site's own origin, e.g. https://book.adventure-access.com. */
  origin: string;
  now?: Date;
}

export function checkoutParams(input: CheckoutInput): Stripe.Checkout.SessionCreateParams {
  const amount = input.option.amount_cents;
  const fee = cardFeeCents(amount, input.feeBps);
  const metadata = {
    booking_id: input.bookingId,
    reference: input.reference,
    option: input.option.key,
    amount_cents: String(amount),
    fee_cents: String(fee),
  };
  const now = input.now ?? new Date();
  const description = `Booking ${input.reference}, ${formatDateRange(input.startDate, input.endDate)}`;

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: amount,
        product_data: { name: `${input.tripTitle}: ${input.option.label}`, description },
      },
    },
  ];
  if (fee > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: fee,
        product_data: { name: `Card processing fee (${formatFeePercent(input.feeBps)}%)` },
      },
    });
  }

  return {
    mode: "payment",
    customer_creation: "always",
    ...(input.email ? { customer_email: input.email } : {}),
    client_reference_id: input.reference,
    line_items: lineItems,
    metadata,
    payment_intent_data: { metadata, description },
    // The booking's access token never goes to Stripe. The return page finds
    // the booking from the traveler's own cookie.
    success_url: `${input.origin}/booking/return?r=paid`,
    cancel_url: `${input.origin}/booking/return?r=canceled`,
    expires_at: Math.floor(now.getTime() / 1000) + SESSION_MINUTES * 60,
  };
}
