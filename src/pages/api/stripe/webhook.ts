import type { APIRoute } from "astro";
import { STRIPE_WEBHOOK_SECRET } from "astro:env/server";
import type Stripe from "stripe";
import {
  claimWebhookEvent,
  finishWebhookEvent,
  recordCardPayment,
  recordCardRefund,
} from "../../../lib/payments/db";
import { stripeClient, StripeNotConfigured } from "../../../lib/stripe/client";
import { readCheckoutSession, readRefundedCharge } from "../../../lib/stripe/events";

/**
 * The Stripe webhook: the only path that marks card money as paid or
 * refunded.
 *
 * 1. Verify Stripe's signature on the raw body. Anything unsigned is refused.
 * 2. Store the event ID before doing any work. An event already handled is
 *    acknowledged and skipped, so a replay changes nothing.
 * 3. Record the payment. That is idempotent too: one row per Checkout Session.
 *
 * A failure answers 500 so Stripe retries; the reason is kept on the event
 * row for the admin.
 */

export const prerender = false;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/** Does the work for one verified event. Returns a problem to keep, or null. */
async function handle(event: Stripe.Event): Promise<string | null> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const reading = readCheckoutSession(event.data.object);
      if (reading.kind === "ignore") return null;
      if (reading.kind === "error") return reading.why;
      const result = await recordCardPayment(reading.payment);
      return result ? null : "could not record the payment";
    }
    case "charge.refunded": {
      const refund = readRefundedCharge(event.data.object);
      if (!refund) return null;
      return (await recordCardRefund(refund)) ? null : "could not record the refund";
    }
    // Nothing to change for these: an expired session leaves its booking
    // pending, and a failed payment was never recorded. Keeping the event
    // row is the record.
    case "checkout.session.expired":
    case "payment_intent.payment_failed":
    case "invoice.paid":
    default:
      return null;
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!STRIPE_WEBHOOK_SECRET) return json(503, { error: "webhook not configured" });

  const signature = request.headers.get("stripe-signature");
  const body = await request.text();
  if (!signature) return json(400, { error: "missing signature" });

  let event: Stripe.Event;
  try {
    event = await stripeClient().webhooks.constructEventAsync(body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    if (error instanceof StripeNotConfigured) return json(503, { error: "stripe not configured" });
    return json(400, { error: "invalid signature" });
  }

  const claim = await claimWebhookEvent(event.id, event.type);
  if (claim === "done") return json(200, { received: true, duplicate: true });
  if (claim === "error") return json(500, { error: "could not store the event" });

  let problem: string | null;
  try {
    problem = await handle(event);
  } catch {
    problem = "unexpected error while handling the event";
  }
  await finishWebhookEvent(event.id, problem);
  if (problem !== null) {
    console.error("[stripe] event not handled", { id: event.id, type: event.type, problem });
    return json(500, { error: "event not handled" });
  }
  return json(200, { received: true });
};
