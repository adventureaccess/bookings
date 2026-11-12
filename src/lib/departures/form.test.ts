import { describe, expect, it } from "vitest";
import {
  newPrivateToken,
  parseCustomQuestions,
  parseDepartureForm,
  parsePaymentSchedule,
  questionsToText,
  scheduleToValues,
} from "./form";

const TRIP = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields: Record<string, string> = {
    trip_id: TRIP,
    start_date: "2027-07-10",
    end_date: "2027-07-22",
    price: "4,950",
    deposit: "750",
    balance_due_date: "2027-05-11",
    min_travelers: "4",
    max_travelers: "10",
    status: "open",
    visibility: "public",
    policy_version_id: "",
    custom_questions: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function errorsOf(overrides: Record<string, string>) {
  const result = parseDepartureForm(form(overrides));
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

describe("parseDepartureForm", () => {
  it("turns a good form into a database row, in cents", () => {
    const result = parseDepartureForm(form());
    expect(result).toEqual({
      ok: true,
      data: {
        trip_id: TRIP,
        start_date: "2027-07-10",
        end_date: "2027-07-22",
        price_cents: 495000,
        deposit_cents: 75000,
        balance_due_date: "2027-05-11",
        min_travelers: 4,
        max_travelers: 10,
        status: "open",
        visibility: "public",
        policy_version_id: null,
        custom_questions: [],
        payment_schedule: [],
      },
    });
  });

  it("requires a final balance date on every departure, with no default", () => {
    expect(errorsOf({ balance_due_date: "" }).balance_due_date).toBe(
      "Enter the date the final balance is due.",
    );
    expect(errorsOf({ balance_due_date: "soon" }).balance_due_date).toBeDefined();
  });

  it("keeps a balance due date that was typed in", () => {
    const result = parseDepartureForm(form({ balance_due_date: "2027-06-10" }));
    expect(result.ok && result.data.balance_due_date).toBe("2027-06-10");
  });

  it("rejects an end date before the start date", () => {
    expect(errorsOf({ end_date: "2027-07-01" }).end_date).toMatch(/before the start/);
  });

  it("rejects a date that does not exist", () => {
    expect(errorsOf({ start_date: "2027-02-30" }).start_date).toBeDefined();
  });

  it("rejects a deposit larger than the price", () => {
    expect(errorsOf({ price: "500", deposit: "750" }).deposit).toMatch(/more than the price/);
  });

  it("rejects prices that are not plain dollar amounts", () => {
    expect(errorsOf({ price: "-100" }).price).toBeDefined();
    expect(errorsOf({ price: "free" }).price).toBeDefined();
    expect(errorsOf({ price: "1000000" }).price).toMatch(/too high/);
  });

  it("rejects a balance due after departure", () => {
    expect(errorsOf({ balance_due_date: "2027-07-11" }).balance_due_date).toBeDefined();
  });

  it("rejects a minimum above the maximum, zero and oversized groups", () => {
    expect(errorsOf({ min_travelers: "12" }).min_travelers).toMatch(/more than the maximum/);
    expect(errorsOf({ min_travelers: "0" }).min_travelers).toBeDefined();
    expect(errorsOf({ max_travelers: "500" }).max_travelers).toBeDefined();
    expect(errorsOf({ max_travelers: "2.5" }).max_travelers).toBeDefined();
  });

  it("rejects values outside the lists", () => {
    expect(errorsOf({ status: "sold" }).status).toBeDefined();
    expect(errorsOf({ visibility: "secret" }).visibility).toBeDefined();
    expect(errorsOf({ trip_id: "1 or 1=1" }).trip_id).toBeDefined();
    expect(errorsOf({ policy_version_id: "nope" }).policy_version_id).toBeDefined();
  });

  it("returns the typed values with the errors, so the form can be refilled", () => {
    const result = parseDepartureForm(form({ price: "abc" }));
    expect(!result.ok && result.values.price).toBe("abc");
    expect(!result.ok && result.values.deposit).toBe("750");
  });

  it("reports every problem at once", () => {
    const errors = errorsOf({ price: "", deposit: "", max_travelers: "" });
    expect(Object.keys(errors).sort()).toEqual(["deposit", "max_travelers", "price"]);
  });
});

describe("custom questions", () => {
  it("makes one optional text question per non-empty line", () => {
    expect(parseCustomQuestions("T-shirt size?\n\n  Bike height?  ")).toEqual([
      { id: "q1", label: "T-shirt size?", type: "text", required: false },
      { id: "q2", label: "Bike height?", type: "text", required: false },
    ]);
  });

  it("caps the count and the length", () => {
    expect(typeof parseCustomQuestions(Array(21).fill("Q?").join("\n"))).toBe("string");
    expect(typeof parseCustomQuestions("x".repeat(201))).toBe("string");
  });

  it("round-trips back to text for the edit form", () => {
    const questions = parseCustomQuestions("One?\nTwo?");
    expect(questionsToText(questions)).toBe("One?\nTwo?");
    expect(questionsToText(null)).toBe("");
  });
});

describe("scheduled payments", () => {
  const scheduleOf = (overrides: Record<string, string>) => {
    const result = parseDepartureForm(form(overrides));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.data.payment_schedule;
  };

  it("stores filled rows in date order, in cents, and skips blank rows", () => {
    expect(
      scheduleOf({
        payment_1_label: "Third payment",
        payment_1_due: "2027-04-01",
        payment_1_amount: "1,000.50",
        payment_3_label: "Second payment",
        payment_3_due: "2027-02-01",
        payment_3_amount: "1500",
      }),
    ).toEqual([
      { id: "p1", label: "Second payment", due_date: "2027-02-01", amount_cents: 150000 },
      { id: "p2", label: "Third payment", due_date: "2027-04-01", amount_cents: 100050 },
    ]);
  });

  it("names a payment that was left unnamed", () => {
    const [payment] = scheduleOf({ payment_1_due: "2027-02-01", payment_1_amount: "1500" });
    expect(payment?.label).toBe("Scheduled payment");
  });

  it("needs both a due date and an amount once a row is started", () => {
    expect(errorsOf({ payment_2_label: "Second payment" }).payment_schedule).toMatch(
      /Payment 2 needs a due date/,
    );
    expect(errorsOf({ payment_1_due: "2027-02-01" }).payment_schedule).toMatch(/amount/);
    expect(
      errorsOf({ payment_1_due: "2027-02-01", payment_1_amount: "0" }).payment_schedule,
    ).toMatch(/amount/);
    expect(
      errorsOf({ payment_1_due: "2027-02-30", payment_1_amount: "100" }).payment_schedule,
    ).toMatch(/due date/);
  });

  it("requires every payment to fall before the final balance date", () => {
    // The default final balance date for this form is 2027-05-11.
    expect(
      errorsOf({ payment_1_due: "2027-05-11", payment_1_amount: "100" }).payment_schedule,
    ).toMatch(/before the final balance/);
    expect(scheduleOf({ payment_1_due: "2027-05-10", payment_1_amount: "100" })).toHaveLength(1);
  });

  it("refuses a schedule that adds up to more than the price", () => {
    // Price 4,950 and deposit 750 leave 4,200.
    expect(
      errorsOf({
        payment_1_due: "2027-02-01",
        payment_1_amount: "4000",
        payment_2_due: "2027-03-01",
        payment_2_amount: "200.01",
      }).payment_schedule,
    ).toMatch(/more than the price/);
    expect(scheduleOf({ payment_1_due: "2027-02-01", payment_1_amount: "4200" })).toHaveLength(1);
  });

  it("keeps what was typed in the rows when the form has errors", () => {
    const result = parseDepartureForm(form({ price: "abc", payment_1_amount: "1500" }));
    expect(!result.ok && result.values.payment_1_amount).toBe("1500");
  });

  it("round-trips a stored schedule back into the form rows", () => {
    const values = scheduleToValues([
      { id: "p1", label: "Second payment", due_date: "2027-02-01", amount_cents: 150000 },
    ]);
    expect(values.payment_1_label).toBe("Second payment");
    expect(values.payment_1_due).toBe("2027-02-01");
    expect(parsePaymentSchedule(values, { priceCents: null, depositCents: null, balanceDue: null }))
      .toEqual([
        { id: "p1", label: "Second payment", due_date: "2027-02-01", amount_cents: 150000 },
      ]);
    expect(values.payment_2_due).toBe("");
    expect(scheduleToValues(null).payment_1_amount).toBe("");
  });
});

describe("newPrivateToken", () => {
  it("is 32 URL-safe characters and different every time", () => {
    const a = newPrivateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newPrivateToken()).not.toBe(a);
  });
});
