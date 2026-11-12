/**
 * Reading Stripe webhook events. Pure functions: they take the event's
 * object and say what, if anything, should be recorded. No Stripe client and
 * no database here, so the rules can be tested directly.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The parts of a Checkout Session this app reads. */
export interface SessionLike {
  id: string;
  mode?: string | null;
  payment_status?: string | null;
  currency?: string | null;
  amount_total?: number | null;
  payment_intent?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
}

export interface CardPayment {
  bookingId: string;
  sessionId: string;
  paymentIntentId: string | null;
  /** Trip money. */
  amountCents: number;
  /** The card fee charged on top. */
  feeCents: number;
}

export type SessionReading =
  | { kind: "payment"; payment: CardPayment }
  | { kind: "ignore"; why: string }
  | { kind: "error"; why: string };

function wholeCents(text: string | undefined): number | null {
  return text !== undefined && /^\d{1,9}$/.test(text) ? Number(text) : null;
}

/**
 * What a completed Checkout Session means. The amounts recorded are the ones
 * this server put in the session's metadata when it created it; the browser
 * never had a say. As a cross-check, what Stripe says it charged must equal
 * those amounts exactly, or nothing is recorded and the event is kept as an
 * error for staff.
 */
export function readCheckoutSession(session: SessionLike): SessionReading {
  if (session.mode !== "payment") return { kind: "ignore", why: "not a payment session" };
  if (session.payment_status !== "paid") return { kind: "ignore", why: "not paid yet" };

  const metadata = session.metadata ?? {};
  const bookingId = metadata.booking_id;
  if (!bookingId || !UUID.test(bookingId)) {
    return { kind: "ignore", why: "not one of this app's sessions" };
  }

  const amountCents = wholeCents(metadata.amount_cents);
  const feeCents = wholeCents(metadata.fee_cents);
  if (amountCents === null || feeCents === null || amountCents <= 0) {
    return { kind: "error", why: "session metadata has no valid amounts" };
  }
  if (session.currency !== "usd") return { kind: "error", why: "session is not in usd" };
  if (session.amount_total !== amountCents + feeCents) {
    return { kind: "error", why: "charged total does not match the amounts requested" };
  }

  const intent = session.payment_intent;
  return {
    kind: "payment",
    payment: {
      bookingId,
      sessionId: session.id,
      paymentIntentId: typeof intent === "string" ? intent : (intent?.id ?? null),
      amountCents,
      feeCents,
    },
  };
}

/** The parts of a Charge this app reads. */
export interface ChargeLike {
  id: string;
  amount_refunded?: number | null;
  payment_intent?: string | { id: string } | null;
}

export interface CardRefund {
  paymentIntentId: string;
  /** Unique per refund state: the charge and its running refunded total. */
  refundKey: string;
  totalRefundedCents: number;
}

/** What a refunded charge means, or null when there is nothing to record. */
export function readRefundedCharge(charge: ChargeLike): CardRefund | null {
  const intent = charge.payment_intent;
  const paymentIntentId = typeof intent === "string" ? intent : (intent?.id ?? null);
  const total = charge.amount_refunded ?? 0;
  if (!paymentIntentId || !Number.isSafeInteger(total) || total <= 0) return null;
  return {
    paymentIntentId,
    refundKey: `${charge.id}:${total}`,
    totalRefundedCents: total,
  };
}
