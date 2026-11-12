import { z } from "astro/zod";
import { email, personName, phone, uuid } from "../schemas";

/**
 * The traveler booking form. Turns the posted fields into the travelers for
 * the booking transaction, or a message per field. Prices never come from
 * here: the server works out every amount from the departure.
 *
 * Field names: `travelers` (the party size), then for traveler n
 * `t<n>_first_name`, `t<n>_last_name`, `t<n>_email`, `t<n>_<question id>`,
 * and `t1_phone` for the lead. Traveler 1 is the lead.
 */

/** The largest party one booking can hold. Bigger groups book with staff. */
export const MAX_PARTY = 10;
export const MAX_ANSWER_LENGTH = 200;
/** A hidden field people never see. Anything typed in it marks a bot. */
export const HONEYPOT_FIELD = "website";
const MAX_FIELD_LENGTH = 300;

export interface BookingQuestion {
  id: string;
  label: string;
}

export interface TravelerInput {
  first_name: string;
  last_name: string;
  /** Lowercase. Empty for an additional traveler who gave none. */
  email: string;
  phone: string;
  is_lead: boolean;
  answers: Record<string, string>;
}

export interface BookingInput {
  policy_version_id: string;
  travelers: TravelerInput[];
}

export type BookingFormValues = Record<string, string>;
export type BookingFormErrors = Record<string, string>;

export type BookingFormResult =
  | { ok: true; data: BookingInput; values: BookingFormValues }
  | { ok: false; spam: boolean; errors: BookingFormErrors; values: BookingFormValues };

const answer = z.string().max(MAX_ANSWER_LENGTH);
const phoneNumber = phone.regex(/^\+?[\d\s().-]+$/);
const QUESTION_ID = /^q\d{1,2}$/;

/** The departure's custom questions, as stored by the admin. Skips anything malformed. */
export function readQuestions(raw: unknown): BookingQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: BookingQuestion[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const { id, label } = item as Record<string, unknown>;
    if (typeof id === "string" && QUESTION_ID.test(id) && typeof label === "string" && label) {
      questions.push({ id, label });
    }
  }
  return questions;
}

/** The party size to show: what was asked for, kept between 1 and what can be booked. */
export function partySize(requested: string | null | undefined, seatsLeft: number): number {
  const most = Math.max(1, Math.min(MAX_PARTY, seatsLeft));
  const wanted = /^\d{1,2}$/.test(requested ?? "") ? Number(requested) : 1;
  return Math.min(Math.max(wanted, 1), most);
}

function text(form: FormData, name: string): string {
  const raw = form.get(name);
  return typeof raw === "string" ? raw.trim().slice(0, MAX_FIELD_LENGTH) : "";
}

export function parseBookingForm(
  form: FormData,
  context: { questions: BookingQuestion[] },
): BookingFormResult {
  const values: BookingFormValues = {};
  const errors: BookingFormErrors = {};
  const keep = (name: string): string => (values[name] = text(form, name));

  if (text(form, HONEYPOT_FIELD) !== "") {
    return { ok: false, spam: true, errors: {}, values: {} };
  }

  const countText = keep("travelers");
  const count = /^\d{1,2}$/.test(countText) ? Number(countText) : 0;
  if (count < 1 || count > MAX_PARTY) {
    errors.travelers = `Choose between 1 and ${MAX_PARTY} travelers.`;
  }

  const policyId = keep("policy_version_id");
  if (!uuid.safeParse(policyId).success) {
    errors.form = "Something went wrong with this page. Reload it and try again.";
  }
  if (keep("accept_policy") !== "yes") {
    errors.accept_policy = "Accept the terms to continue.";
  }

  const travelers: TravelerInput[] = [];
  for (let n = 1; n <= Math.min(Math.max(count, 0), MAX_PARTY); n++) {
    const isLead = n === 1;
    const first = keep(`t${n}_first_name`);
    const last = keep(`t${n}_last_name`);
    const emailText = keep(`t${n}_email`);
    const phoneText = isLead ? keep("t1_phone") : "";

    if (!personName.safeParse(first).success) {
      errors[`t${n}_first_name`] = first === "" ? "Enter a first name." : "That name is too long.";
    }
    if (!personName.safeParse(last).success) {
      errors[`t${n}_last_name`] = last === "" ? "Enter a last name." : "That name is too long.";
    }

    let cleanEmail = "";
    if (emailText === "") {
      if (isLead) errors.t1_email = "Enter an email address.";
    } else {
      const parsed = email.safeParse(emailText);
      if (parsed.success) cleanEmail = parsed.data;
      else errors[`t${n}_email`] = "That email address does not look right.";
    }

    if (isLead && !phoneNumber.safeParse(phoneText).success) {
      errors.t1_phone =
        phoneText === "" ? "Enter a phone number." : "That phone number does not look right.";
    }

    const answers: Record<string, string> = {};
    for (const question of context.questions) {
      const name = `t${n}_${question.id}`;
      const raw = form.get(name);
      const full = typeof raw === "string" ? raw.trim() : "";
      values[name] = full.slice(0, MAX_FIELD_LENGTH);
      if (!answer.safeParse(full).success) {
        errors[name] = `Keep this under ${MAX_ANSWER_LENGTH} characters.`;
      } else if (full !== "") {
        answers[question.id] = full;
      }
    }

    travelers.push({
      first_name: first,
      last_name: last,
      email: cleanEmail,
      phone: phoneText,
      is_lead: isLead,
      answers,
    });
  }

  if (Object.keys(errors).length > 0) return { ok: false, spam: false, errors, values };
  return { ok: true, data: { policy_version_id: policyId, travelers }, values };
}
