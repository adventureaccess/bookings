import { describe, expect, it } from "vitest";
import { HONEYPOT_FIELD, parseBookingForm, partySize, readQuestions } from "./form";

const POLICY = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const QUESTIONS = [{ id: "q1", label: "What is your height, for bike sizing?" }];

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields: Record<string, string> = {
    travelers: "2",
    policy_version_id: POLICY,
    accept_policy: "yes",
    t1_first_name: "  Tenzin ",
    t1_last_name: "Norbu",
    t1_email: "Tenzin@Example.com",
    t1_phone: "+1 (555) 010-0100",
    t1_q1: "172 cm",
    t2_first_name: "Pema",
    t2_last_name: "Norbu",
    t2_email: "",
    t2_q1: "",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function errorsOf(overrides: Record<string, string>) {
  const result = parseBookingForm(form(overrides), { questions: QUESTIONS });
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

describe("parseBookingForm", () => {
  it("turns a good form into travelers, with the first as lead", () => {
    const result = parseBookingForm(form(), { questions: QUESTIONS });
    expect(result.ok && result.data).toEqual({
      policy_version_id: POLICY,
      travelers: [
        {
          first_name: "Tenzin",
          last_name: "Norbu",
          email: "tenzin@example.com",
          phone: "+1 (555) 010-0100",
          is_lead: true,
          answers: { q1: "172 cm" },
        },
        { first_name: "Pema", last_name: "Norbu", email: "", phone: "", is_lead: false, answers: {} },
      ],
    });
  });

  it("never reads a price, total or deposit from the form", () => {
    const result = parseBookingForm(
      form({ price_cents: "1", total_cents: "1", deposit_cents: "0", amount: "0" }),
      { questions: QUESTIONS },
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/cents|amount/);
  });

  it("requires names for everyone, and email and phone for the lead only", () => {
    const errors = errorsOf({
      t1_first_name: "",
      t1_email: "",
      t1_phone: "",
      t2_last_name: "",
    });
    expect(errors).toEqual({
      t1_first_name: "Enter a first name.",
      t1_email: "Enter an email address.",
      t1_phone: "Enter a phone number.",
      t2_last_name: "Enter a last name.",
    });
  });

  it("checks an additional traveler's email only when one is given", () => {
    expect(errorsOf({ t2_email: "not-an-email" }).t2_email).toMatch(/does not look right/);
    const result = parseBookingForm(form({ t2_email: "Pema@Example.com" }), { questions: QUESTIONS });
    expect(result.ok && result.data.travelers[1]?.email).toBe("pema@example.com");
  });

  it("rejects malformed emails and phone numbers for the lead", () => {
    expect(errorsOf({ t1_email: "tenzin@" }).t1_email).toBeDefined();
    expect(errorsOf({ t1_phone: "call me" }).t1_phone).toMatch(/does not look right/);
    expect(errorsOf({ t1_phone: "123" }).t1_phone).toBeDefined();
  });

  it("caps names and answers", () => {
    expect(errorsOf({ t1_first_name: "x".repeat(81) }).t1_first_name).toMatch(/too long/);
    expect(errorsOf({ t1_q1: "x".repeat(201) }).t1_q1).toMatch(/under 200/);
  });

  it("requires the terms to be accepted", () => {
    expect(errorsOf({ accept_policy: "" }).accept_policy).toBe("Accept the terms to continue.");
    expect(errorsOf({ accept_policy: "on" }).accept_policy).toBeDefined();
  });

  it("rejects a party size outside 1 to 10 and a bad policy id", () => {
    expect(errorsOf({ travelers: "0" }).travelers).toBeDefined();
    expect(errorsOf({ travelers: "11" }).travelers).toBeDefined();
    expect(errorsOf({ travelers: "two" }).travelers).toBeDefined();
    expect(errorsOf({ policy_version_id: "nope" }).form).toBeDefined();
  });

  it("ignores travelers beyond the stated party size", () => {
    const result = parseBookingForm(
      form({ travelers: "1", t2_first_name: "Extra", t3_first_name: "Extra" }),
      { questions: QUESTIONS },
    );
    expect(result.ok && result.data.travelers).toHaveLength(1);
  });

  it("only keeps answers to this departure's questions", () => {
    const result = parseBookingForm(form({ t1_q9: "sneaky", t1_notes: "x" }), {
      questions: QUESTIONS,
    });
    expect(result.ok && result.data.travelers[0]?.answers).toEqual({ q1: "172 cm" });
  });

  it("returns what was typed alongside the errors", () => {
    const result = parseBookingForm(form({ t1_email: "bad" }), { questions: QUESTIONS });
    expect(!result.ok && result.values.t1_email).toBe("bad");
    expect(!result.ok && result.values.t2_first_name).toBe("Pema");
    expect(!result.ok && result.values.accept_policy).toBe("yes");
  });

  it("flags a filled honeypot as spam and reports nothing else", () => {
    const result = parseBookingForm(form({ [HONEYPOT_FIELD]: "https://spam.example" }), {
      questions: QUESTIONS,
    });
    expect(result).toEqual({ ok: false, spam: true, errors: {}, values: {} });
  });
});

describe("partySize", () => {
  it("keeps the request between 1 and what can be booked", () => {
    expect(partySize("3", 8)).toBe(3);
    expect(partySize("9", 4)).toBe(4);
    expect(partySize("40", 40)).toBe(10);
    expect(partySize("0", 8)).toBe(1);
    expect(partySize("abc", 8)).toBe(1);
    expect(partySize(null, 8)).toBe(1);
    expect(partySize("2", 0)).toBe(1);
  });
});

describe("readQuestions", () => {
  it("reads stored questions and skips anything malformed", () => {
    expect(
      readQuestions([
        { id: "q1", label: "Height?", type: "text", required: false },
        { id: "bad id", label: "x" },
        { id: "q2" },
        "nope",
        null,
      ]),
    ).toEqual([{ id: "q1", label: "Height?" }]);
    expect(readQuestions(null)).toEqual([]);
  });
});
