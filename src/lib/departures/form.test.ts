import { describe, expect, it } from "vitest";
import {
  newPrivateToken,
  parseCustomQuestions,
  parseDepartureForm,
  questionsToText,
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
    balance_due_date: "",
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
      },
    });
  });

  it("defaults the balance due date to 60 days before departure", () => {
    const result = parseDepartureForm(form({ start_date: "2027-03-01", end_date: "2027-03-10" }));
    expect(result.ok && result.data.balance_due_date).toBe("2026-12-31");
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

describe("newPrivateToken", () => {
  it("is 32 URL-safe characters and different every time", () => {
    const a = newPrivateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newPrivateToken()).not.toBe(a);
  });
});
