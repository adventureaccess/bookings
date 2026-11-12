import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { readCheckoutSession, readRefundedCharge, type SessionLike } from "./events";

const BOOKING = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

const session = (overrides: Partial<SessionLike> = {}): SessionLike => ({
  id: "cs_test_123",
  mode: "payment",
  payment_status: "paid",
  currency: "usd",
  amount_total: 77250,
  payment_intent: "pi_test_123",
  metadata: { booking_id: BOOKING, amount_cents: "75000", fee_cents: "2250" },
  ...overrides,
});

describe("readCheckoutSession", () => {
  it("reads a paid session as trip money plus the card fee", () => {
    expect(readCheckoutSession(session())).toEqual({
      kind: "payment",
      payment: {
        bookingId: BOOKING,
        sessionId: "cs_test_123",
        paymentIntentId: "pi_test_123",
        amountCents: 75000,
        feeCents: 2250,
      },
    });
  });

  it("accepts an expanded payment intent and a zero fee", () => {
    const reading = readCheckoutSession(
      session({
        payment_intent: { id: "pi_obj" },
        amount_total: 75000,
        metadata: { booking_id: BOOKING, amount_cents: "75000", fee_cents: "0" },
      }),
    );
    expect(reading.kind === "payment" && reading.payment.paymentIntentId).toBe("pi_obj");
  });

  it("records nothing when the charged total differs from what the server asked for", () => {
    for (const total of [77249, 77251, 1, 0, null]) {
      expect(readCheckoutSession(session({ amount_total: total }))).toEqual({
        kind: "error",
        why: "charged total does not match the amounts requested",
      });
    }
  });

  it("records nothing for a session that is not paid, not a payment, or not ours", () => {
    expect(readCheckoutSession(session({ payment_status: "unpaid" })).kind).toBe("ignore");
    expect(readCheckoutSession(session({ mode: "subscription" })).kind).toBe("ignore");
    expect(readCheckoutSession(session({ metadata: {} })).kind).toBe("ignore");
    expect(readCheckoutSession(session({ metadata: null })).kind).toBe("ignore");
    expect(
      readCheckoutSession(session({ metadata: { booking_id: "1 or 1=1", amount_cents: "1", fee_cents: "0" } }))
        .kind,
    ).toBe("ignore");
  });

  it("treats bad amounts or another currency as an error, not a payment", () => {
    const bad = (metadata: Record<string, string>) =>
      readCheckoutSession(session({ metadata: { booking_id: BOOKING, ...metadata } })).kind;
    expect(bad({ amount_cents: "-5", fee_cents: "0" })).toBe("error");
    expect(bad({ amount_cents: "75000.5", fee_cents: "0" })).toBe("error");
    expect(bad({ amount_cents: "0", fee_cents: "0" })).toBe("error");
    expect(bad({ fee_cents: "0" })).toBe("error");
    expect(readCheckoutSession(session({ currency: "eur" })).kind).toBe("error");
  });
});

describe("readRefundedCharge", () => {
  it("reads the running refunded total, keyed so each refund state is recorded once", () => {
    expect(
      readRefundedCharge({ id: "ch_1", amount_refunded: 25000, payment_intent: "pi_1" }),
    ).toEqual({ paymentIntentId: "pi_1", refundKey: "ch_1:25000", totalRefundedCents: 25000 });
  });

  it("is nothing without a payment intent or a refunded amount", () => {
    expect(readRefundedCharge({ id: "ch_1", amount_refunded: 0, payment_intent: "pi_1" })).toBeNull();
    expect(readRefundedCharge({ id: "ch_1", amount_refunded: 100, payment_intent: null })).toBeNull();
  });
});

describe("Stripe signature check", () => {
  // The webhook route relies on the Stripe library for this. These tests pin
  // down the behavior the route depends on, with a throwaway secret.
  const stripe = new Stripe("sk_test_not_a_real_key");
  const secret = "whsec_test_only";
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed" });

  it("accepts a correctly signed payload", async () => {
    const header = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
    const event = await stripe.webhooks.constructEventAsync(payload, header, secret);
    expect(event.id).toBe("evt_1");
  });

  it("rejects a tampered payload, a wrong secret and a missing signature", async () => {
    const header = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
    const tampered = payload.replace("evt_1", "evt_2");
    await expect(stripe.webhooks.constructEventAsync(tampered, header, secret)).rejects.toThrow();
    await expect(
      stripe.webhooks.constructEventAsync(payload, header, "whsec_other"),
    ).rejects.toThrow();
    await expect(stripe.webhooks.constructEventAsync(payload, "", secret)).rejects.toThrow();
  });
});
