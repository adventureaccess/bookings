import { describe, expect, it } from "vitest";
import { readCheckoutSession } from "../stripe/events";
import { checkoutParams, PAYMENT_HOLD_MINUTES, SESSION_MINUTES, type CheckoutInput } from "./checkout";

const input = (overrides: Partial<CheckoutInput> = {}): CheckoutInput => ({
  bookingId: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
  reference: "AA-7K3Q",
  tripTitle: "Ladakh Multisport",
  startDate: "2027-07-10",
  endDate: "2027-07-22",
  option: { key: "deposit", label: "Deposit", amount_cents: 75000, due_date: null },
  feeBps: 300,
  email: "tenzin@example.com",
  origin: "https://book.adventure-access.com",
  now: new Date("2027-01-01T00:00:00Z"),
  ...overrides,
});

describe("checkoutParams", () => {
  it("charges the trip amount and the card fee as two lines", () => {
    const params = checkoutParams(input());
    expect(params.mode).toBe("payment");
    expect(params.customer_creation).toBe("always");
    expect(params.customer_email).toBe("tenzin@example.com");
    expect(params.line_items).toEqual([
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 75000,
          product_data: {
            name: "Ladakh Multisport: Deposit",
            description: "Booking AA-7K3Q, Jul 10 – Jul 22, 2027",
          },
        },
      },
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 2250,
          product_data: { name: "Card processing fee (3%)" },
        },
      },
    ]);
  });

  it("puts the same amounts in the metadata the webhook reads back", () => {
    const params = checkoutParams(input());
    expect(params.metadata).toEqual({
      booking_id: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
      reference: "AA-7K3Q",
      option: "deposit",
      amount_cents: "75000",
      fee_cents: "2250",
    });
    expect(params.payment_intent_data?.metadata).toEqual(params.metadata);

    // Round trip: a session Stripe charged in full is read as this payment.
    const total = (params.line_items ?? []).reduce(
      (sum, line) => sum + (line.price_data?.unit_amount ?? 0),
      0,
    );
    const reading = readCheckoutSession({
      id: "cs_test_1",
      mode: "payment",
      payment_status: "paid",
      currency: "usd",
      amount_total: total,
      payment_intent: "pi_1",
      metadata: params.metadata as Record<string, string>,
    });
    expect(reading.kind === "payment" && reading.payment).toMatchObject({
      amountCents: 75000,
      feeCents: 2250,
    });
  });

  it("leaves the fee line out when the fee is zero", () => {
    const params = checkoutParams(input({ feeBps: 0 }));
    expect(params.line_items).toHaveLength(1);
    expect(params.metadata?.fee_cents).toBe("0");
  });

  it("never sends the booking's access token to Stripe", () => {
    const params = checkoutParams(input());
    expect(params.success_url).toBe("https://book.adventure-access.com/booking/return?r=paid");
    expect(params.cancel_url).toBe("https://book.adventure-access.com/booking/return?r=canceled");
    expect(JSON.stringify(params)).not.toMatch(/[?&]t=/);
  });

  it("expires just over Stripe's 30 minute minimum, inside the seat hold", () => {
    const params = checkoutParams(input());
    const start = Date.parse("2027-01-01T00:00:00Z") / 1000;
    expect(params.expires_at).toBe(start + SESSION_MINUTES * 60);
    expect(SESSION_MINUTES).toBeGreaterThanOrEqual(30);
    expect(PAYMENT_HOLD_MINUTES).toBeGreaterThan(SESSION_MINUTES);
  });

  it("omits the email when there is none", () => {
    expect("customer_email" in checkoutParams(input({ email: null }))).toBe(false);
  });
});
