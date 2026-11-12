import { createServiceClient } from "../supabase/service";
import { MAX_CARD_FEE_BPS } from "./due";

/**
 * Money in the database. Every change goes through a SQL function
 * (supabase/migrations, payments) that only the service role may run, and
 * each of those ends in apply_booking_money, so card and offline payments
 * follow the same rules.
 */

/** Logs the database error code only. Messages can contain row values. */
function logDbError(where: string, error: { code?: string } | null): void {
  console.error(`[payments] ${where} failed`, { code: error?.code ?? "unknown" });
}

export const OFFLINE_METHODS = ["wire", "ach", "check", "cash", "other"] as const;
export type OfflineMethod = (typeof OFFLINE_METHODS)[number];

export interface MoneyResult {
  booking_id: string;
  status: string;
  paid_cents: number;
  discount_cents: number;
  balance_cents: number;
  needs_attention: boolean;
  confirmed_now: boolean;
}

// --- Settings --------------------------------------------------------------

/** The system-wide card fee in hundredths of a percent. 0 when unset or unreadable. */
export async function getCardFeeBps(): Promise<number> {
  const { data, error } = await createServiceClient()
    .from("settings")
    .select("value")
    .eq("key", "card_fee_bps")
    .maybeSingle();
  if (error) logDbError("getCardFeeBps", error);
  const value: unknown = data?.value;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_CARD_FEE_BPS
    ? value
    : 0;
}

export async function setCardFeeBps(bps: number): Promise<boolean> {
  const { error } = await createServiceClient()
    .from("settings")
    .upsert({ key: "card_fee_bps", value: bps }, { onConflict: "key" });
  if (error) logDbError("setCardFeeBps", error);
  return !error;
}

// --- Card payments (webhook only) ------------------------------------------

export async function recordCardPayment(payment: {
  bookingId: string;
  sessionId: string;
  paymentIntentId: string | null;
  amountCents: number;
  feeCents: number;
}): Promise<(MoneyResult & { recorded: boolean }) | null> {
  const { data, error } = await createServiceClient().rpc("record_card_payment", {
    p_booking_id: payment.bookingId,
    p_checkout_session_id: payment.sessionId,
    p_payment_intent_id: payment.paymentIntentId,
    p_amount_cents: payment.amountCents,
    p_fee_cents: payment.feeCents,
  });
  if (error || !data) {
    logDbError("recordCardPayment", error);
    return null;
  }
  return data as MoneyResult & { recorded: boolean };
}

export async function recordCardRefund(refund: {
  paymentIntentId: string;
  refundKey: string;
  totalRefundedCents: number;
}): Promise<boolean> {
  const { error } = await createServiceClient().rpc("record_card_refund", {
    p_payment_intent_id: refund.paymentIntentId,
    p_refund_key: refund.refundKey,
    p_total_refunded_cents: refund.totalRefundedCents,
  });
  if (error) logDbError("recordCardRefund", error);
  return !error;
}

export type PrepareResult =
  | { ok: true; hold_expires_at: string | null }
  | { ok: false; reason: "not_found" | "closed" | "not_enough_seats" | "error" };

/** Makes sure a pending booking holds its seats for as long as the card session lasts. */
export async function preparePayment(bookingId: string, holdMinutes: number): Promise<PrepareResult> {
  const { data, error } = await createServiceClient().rpc("prepare_payment", {
    p_booking_id: bookingId,
    p_hold_minutes: holdMinutes,
  });
  if (error || !data) {
    logDbError("preparePayment", error);
    return { ok: false, reason: "error" };
  }
  return data as PrepareResult;
}

/** The lead traveler's email, for the Stripe receipt. Needs the booking's token hash. */
export async function getLeadEmail(reference: string, accessTokenHash: string): Promise<string | null> {
  const { data, error } = await createServiceClient().rpc("booking_lead_email", {
    p_reference: reference,
    p_access_token_hash: accessTokenHash,
  });
  if (error) logDbError("getLeadEmail", error);
  return typeof data === "string" ? data : null;
}

// --- Webhook events --------------------------------------------------------

export type EventClaim = "new" | "retry" | "done" | "error";

/**
 * Stores the Stripe event ID before any work happens. "done" means this
 * event was already handled and must be skipped; "retry" means it was seen
 * before but failed, so it runs again.
 */
export async function claimWebhookEvent(eventId: string, type: string): Promise<EventClaim> {
  const db = createServiceClient();
  const { error } = await db.from("webhook_events").insert({ stripe_event_id: eventId, type });
  if (!error) return "new";
  if (error.code !== "23505") {
    logDbError("claimWebhookEvent", error);
    return "error";
  }
  const { data, error: readError } = await db
    .from("webhook_events")
    .select("processed_at")
    .eq("stripe_event_id", eventId)
    .maybeSingle();
  if (readError || !data) {
    logDbError("claimWebhookEvent.read", readError);
    return "error";
  }
  return data.processed_at ? "done" : "retry";
}

/** Marks an event handled, or keeps a short reason when it could not be. */
export async function finishWebhookEvent(eventId: string, problem: string | null): Promise<void> {
  const { error } = await createServiceClient()
    .from("webhook_events")
    .update(
      problem === null
        ? { processed_at: new Date().toISOString(), error: null }
        : { error: problem.slice(0, 300) },
    )
    .eq("stripe_event_id", eventId);
  if (error) logDbError("finishWebhookEvent", error);
}

// --- Offline payments and credits (admin actions, after the role check) -----

export type MoneyActionResult =
  | { ok: true; money: MoneyResult }
  | { ok: false; reason: string };

export async function recordOfflinePayment(input: {
  bookingId: string;
  method: OfflineMethod;
  amountCents: number;
  receivedOn: string;
  note: string;
  recordedBy: string;
}): Promise<MoneyActionResult> {
  const { data, error } = await createServiceClient().rpc("record_offline_payment", {
    p_booking_id: input.bookingId,
    p_method: input.method,
    p_amount_cents: input.amountCents,
    p_received_on: input.receivedOn,
    p_note: input.note,
    p_recorded_by: input.recordedBy,
  });
  if (error || !data) {
    logDbError("recordOfflinePayment", error);
    return { ok: false, reason: "error" };
  }
  return { ok: true, money: data as MoneyResult };
}

export async function voidPayment(paymentId: string, reason: string): Promise<MoneyActionResult> {
  const { data, error } = await createServiceClient().rpc("void_payment", {
    p_payment_id: paymentId,
    p_reason: reason,
  });
  if (error || !data) {
    logDbError("voidPayment", error);
    return { ok: false, reason: "error" };
  }
  const result = data as MoneyResult & { ok: boolean; reason?: string };
  return result.ok ? { ok: true, money: result } : { ok: false, reason: result.reason ?? "error" };
}

export async function addAdjustment(input: {
  bookingId: string;
  amountCents: number;
  reason: string;
  createdBy: string;
}): Promise<MoneyActionResult> {
  const { data, error } = await createServiceClient().rpc("add_booking_adjustment", {
    p_booking_id: input.bookingId,
    p_amount_cents: input.amountCents,
    p_reason: input.reason,
    p_created_by: input.createdBy,
  });
  if (error || !data) {
    logDbError("addAdjustment", error);
    return { ok: false, reason: "error" };
  }
  const result = data as MoneyResult & { ok: boolean; reason?: string };
  return result.ok ? { ok: true, money: result } : { ok: false, reason: result.reason ?? "error" };
}

// --- Housekeeping ----------------------------------------------------------

export async function deleteExpiredHolds(): Promise<number | null> {
  const { data, error } = await createServiceClient().rpc("delete_expired_holds");
  if (error) {
    logDbError("deleteExpiredHolds", error);
    return null;
  }
  return typeof data === "number" ? data : 0;
}
