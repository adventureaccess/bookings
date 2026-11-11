import { describe, expect, it } from "vitest";
import { hashAccessToken, isAccessToken, newAccessToken } from "./token";
import { paymentPlan } from "./plan";
import { policyBlocks } from "../policies/render";

const departure = {
  price_cents: 495000,
  deposit_cents: 75000,
  balance_due_date: "2027-05-11",
  payment_schedule: [
    { id: "p2", label: "Third payment", due_date: "2027-04-01", amount_cents: 100000 },
    { id: "p1", label: "Second payment", due_date: "2027-02-01", amount_cents: 150000 },
  ],
};

describe("paymentPlan", () => {
  it("lists the deposit, scheduled payments in date order, then the final balance", () => {
    expect(paymentPlan(departure, 2)).toEqual({
      total_cents: 990000,
      lines: [
        { label: "Deposit", due_date: null, amount_cents: 150000 },
        { label: "Second payment", due_date: "2027-02-01", amount_cents: 300000 },
        { label: "Third payment", due_date: "2027-04-01", amount_cents: 200000 },
        { label: "Final balance", due_date: "2027-05-11", amount_cents: 340000 },
      ],
    });
  });

  it("always adds up to the total", () => {
    for (const travelers of [1, 3, 10]) {
      const plan = paymentPlan(departure, travelers);
      expect(plan.lines.reduce((sum, line) => sum + line.amount_cents, 0)).toBe(plan.total_cents);
    }
  });

  it("is deposit plus balance when there is no schedule", () => {
    const plan = paymentPlan({ ...departure, payment_schedule: [] }, 1);
    expect(plan.lines.map((line) => line.label)).toEqual(["Deposit", "Final balance"]);
    expect(plan.lines[1]?.amount_cents).toBe(420000);
  });

  it("leaves out a zero deposit and a zero balance", () => {
    expect(
      paymentPlan({ ...departure, deposit_cents: 495000, payment_schedule: null }, 1).lines,
    ).toEqual([{ label: "Deposit", due_date: null, amount_cents: 495000 }]);
    expect(
      paymentPlan({ ...departure, deposit_cents: 0, payment_schedule: [] }, 1).lines,
    ).toEqual([{ label: "Final balance", due_date: "2027-05-11", amount_cents: 495000 }]);
  });

  it("ignores malformed schedule entries and refuses a bad party size", () => {
    const plan = paymentPlan(
      { ...departure, payment_schedule: [{ due_date: "2027-02-01" }, "x", { amount_cents: -5, due_date: "2027-02-01" }] },
      1,
    );
    expect(plan.lines).toHaveLength(2);
    expect(() => paymentPlan(departure, 0)).toThrow(RangeError);
    expect(() => paymentPlan(departure, 1.5)).toThrow(RangeError);
  });
});

describe("access tokens", () => {
  it("are 32 URL-safe characters, different every time", () => {
    const token = newAccessToken();
    expect(isAccessToken(token)).toBe(true);
    expect(newAccessToken()).not.toBe(token);
    expect(isAccessToken("short")).toBe(false);
    expect(isAccessToken(`${token}!`)).toBe(false);
  });

  it("hash to 64 hex characters, the same way every time", () => {
    const token = newAccessToken();
    expect(hashAccessToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAccessToken(token)).toBe(hashAccessToken(token));
    expect(hashAccessToken(token)).not.toBe(hashAccessToken(newAccessToken()));
  });
});

describe("policyBlocks", () => {
  it("splits policy text into headings, paragraphs and lists", () => {
    expect(
      policyBlocks("## Payments\n\nFull payment is due\n30 days before.\n\n- One\n- Two\nAfter the list."),
    ).toEqual([
      { type: "heading", text: "Payments" },
      { type: "paragraph", text: "Full payment is due 30 days before." },
      { type: "list", items: ["One", "Two"] },
      { type: "paragraph", text: "After the list." },
    ]);
  });

  it("keeps markup as plain text", () => {
    expect(policyBlocks("<script>alert(1)</script>")).toEqual([
      { type: "paragraph", text: "<script>alert(1)</script>" },
    ]);
    expect(policyBlocks("")).toEqual([]);
  });
});
