import { describe, expect, it } from "vitest";
import {
  balanceCents,
  cardFeeCents,
  formatFeePercent,
  parseFeePercent,
  payOptions,
  type Account,
} from "./due";

const account = (overrides: Partial<Account> = {}): Account => ({
  traveler_count: 1,
  total_cents: 495000,
  discount_cents: 0,
  paid_cents: 0,
  deposit_cents: 75000,
  payment_schedule: [
    { id: "p1", label: "Second payment", due_date: "2027-02-01", amount_cents: 150000 },
  ],
  balance_due_date: "2027-05-11",
  ...overrides,
});

describe("balanceCents", () => {
  it("is the total less credits and payments, never negative", () => {
    expect(balanceCents(account())).toBe(495000);
    expect(balanceCents(account({ discount_cents: 50000, paid_cents: 200000 }))).toBe(245000);
    expect(balanceCents(account({ paid_cents: 600000 }))).toBe(0);
  });
});

describe("payOptions", () => {
  it("offers the deposit or the full amount to a new booking", () => {
    expect(payOptions(account())).toEqual([
      { key: "deposit", label: "Deposit", amount_cents: 75000, due_date: null },
      { key: "balance", label: "Full amount", amount_cents: 495000, due_date: "2027-05-11" },
    ]);
  });

  it("offers the next scheduled payment once the deposit is in", () => {
    expect(payOptions(account({ paid_cents: 75000 }))).toEqual([
      { key: "next", label: "Second payment", amount_cents: 150000, due_date: "2027-02-01" },
      { key: "balance", label: "Remaining balance", amount_cents: 420000, due_date: "2027-05-11" },
    ]);
  });

  it("offers only the rest once the schedule is done", () => {
    expect(payOptions(account({ paid_cents: 225000 }))).toEqual([
      { key: "balance", label: "Remaining balance", amount_cents: 270000, due_date: "2027-05-11" },
    ]);
  });

  it("asks only for what is missing after an irregular payment", () => {
    // 500 paid by wire: 250 completes the deposit.
    expect(payOptions(account({ paid_cents: 50000 }))[0]).toMatchObject({
      key: "deposit",
      amount_cents: 25000,
    });
    // 1,000 paid: past the deposit, 1,250 short of the second payment.
    expect(payOptions(account({ paid_cents: 100000 }))[0]).toMatchObject({
      key: "next",
      label: "Second payment",
      amount_cents: 125000,
    });
  });

  it("multiplies by the number of travelers", () => {
    expect(payOptions(account({ traveler_count: 2, total_cents: 990000 }))).toEqual([
      { key: "deposit", label: "Deposit", amount_cents: 150000, due_date: null },
      { key: "balance", label: "Full amount", amount_cents: 990000, due_date: "2027-05-11" },
    ]);
  });

  it("takes credits off the end, never asking for more than is owed", () => {
    const options = payOptions(account({ discount_cents: 300000, paid_cents: 75000 }));
    // Owed 1,950 in all; 750 paid; the second payment would overshoot, so only 1,200 is left.
    expect(options).toEqual([
      { key: "balance", label: "Remaining balance", amount_cents: 120000, due_date: "2027-05-11" },
    ]);
  });

  it("offers nothing when nothing is owed", () => {
    expect(payOptions(account({ paid_cents: 495000 }))).toEqual([]);
    expect(payOptions(account({ discount_cents: 495000 }))).toEqual([]);
  });

  it("is one option when there is no deposit and no schedule", () => {
    expect(payOptions(account({ deposit_cents: 0, payment_schedule: [] }))).toEqual([
      { key: "balance", label: "Full amount", amount_cents: 495000, due_date: "2027-05-11" },
    ]);
  });

  it("every option is a positive amount no larger than the balance", () => {
    for (const paid of [0, 1, 74999, 75000, 75001, 224999, 225000, 494999]) {
      const a = account({ paid_cents: paid });
      for (const option of payOptions(a)) {
        expect(option.amount_cents).toBeGreaterThan(0);
        expect(option.amount_cents).toBeLessThanOrEqual(balanceCents(a));
      }
    }
  });
});

describe("card fee", () => {
  it("is a percentage of the payment, rounded to the cent", () => {
    expect(cardFeeCents(75000, 300)).toBe(2250);
    expect(cardFeeCents(300000, 300)).toBe(9000);
    expect(cardFeeCents(12345, 290)).toBe(358);
    expect(cardFeeCents(75000, 0)).toBe(0);
  });

  it("refuses amounts that are not whole cents and fees out of range", () => {
    expect(() => cardFeeCents(10.5, 300)).toThrow(RangeError);
    expect(() => cardFeeCents(-1, 300)).toThrow(RangeError);
    expect(() => cardFeeCents(100, 1001)).toThrow(RangeError);
    expect(() => cardFeeCents(100, -1)).toThrow(RangeError);
  });

  it("reads the percentage staff type in", () => {
    expect(parseFeePercent("3")).toBe(300);
    expect(parseFeePercent(" 2.9 % ")).toBe(290);
    expect(parseFeePercent("2.75")).toBe(275);
    expect(parseFeePercent("0")).toBe(0);
    expect(parseFeePercent("10")).toBe(1000);
  });

  it("rejects anything that is not a fee of at most 10 percent", () => {
    for (const bad of ["", "abc", "-1", "10.01", "11", "3.333", "1e2", "3,5"]) {
      expect(parseFeePercent(bad)).toBeNull();
    }
  });

  it("shows the percentage back without trailing zeros", () => {
    expect(formatFeePercent(300)).toBe("3");
    expect(formatFeePercent(290)).toBe("2.9");
    expect(formatFeePercent(275)).toBe("2.75");
    expect(formatFeePercent(0)).toBe("0");
    expect(parseFeePercent(formatFeePercent(125))).toBe(125);
  });
});
