import { randomBytes } from "node:crypto";
import { addDays, isIsoDate } from "../dates";
import { parseDollarsToCents } from "../money";

/**
 * Turns the departure form into a row for the database, or a list of
 * per-field messages. The database has matching check constraints; this is
 * the friendly first line, not the only one.
 */

export const DEPARTURE_STATUSES = ["open", "full", "closed", "canceled"] as const;
export const DEPARTURE_VISIBILITIES = ["public", "private"] as const;
export type DepartureStatus = (typeof DEPARTURE_STATUSES)[number];
export type DepartureVisibility = (typeof DEPARTURE_VISIBILITIES)[number];

/** Default from the brief: the balance is due 60 days before departure. */
export const BALANCE_DUE_DAYS_BEFORE = 60;
const MAX_PRICE_CENTS = 10_000_000; // $100,000 per person
const MAX_GROUP = 100;
const MAX_QUESTIONS = 20;
const MAX_QUESTION_LENGTH = 200;

export interface CustomQuestion {
  id: string;
  label: string;
  type: "text";
  required: boolean;
}

export interface DepartureInput {
  trip_id: string;
  start_date: string;
  end_date: string;
  price_cents: number;
  deposit_cents: number;
  balance_due_date: string;
  min_travelers: number;
  max_travelers: number;
  status: DepartureStatus;
  visibility: DepartureVisibility;
  policy_version_id: string | null;
  custom_questions: CustomQuestion[];
}

export const DEPARTURE_FIELDS = [
  "trip_id",
  "start_date",
  "end_date",
  "price",
  "deposit",
  "balance_due_date",
  "min_travelers",
  "max_travelers",
  "status",
  "visibility",
  "policy_version_id",
  "custom_questions",
] as const;
export type DepartureField = (typeof DEPARTURE_FIELDS)[number];
export type DepartureFormValues = Record<DepartureField, string>;
export type DepartureFormErrors = Partial<Record<DepartureField, string>>;

export type DepartureFormResult =
  | { ok: true; data: DepartureInput }
  | { ok: false; errors: DepartureFormErrors; values: DepartureFormValues };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Form values as trimmed, length-capped strings. Files and missing fields become "". */
export function readDepartureValues(form: FormData): DepartureFormValues {
  const values = {} as DepartureFormValues;
  for (const field of DEPARTURE_FIELDS) {
    const raw = form.get(field);
    const cap = field === "custom_questions" ? 5000 : 200;
    values[field] = typeof raw === "string" ? raw.trim().slice(0, cap) : "";
  }
  return values;
}

function wholeNumber(text: string): number | null {
  return /^\d{1,4}$/.test(text) ? Number(text) : null;
}

/** One question per line. Each becomes an optional free-text question. */
export function parseCustomQuestions(text: string): CustomQuestion[] | string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length > MAX_QUESTIONS) return `At most ${MAX_QUESTIONS} questions.`;
  if (lines.some((line) => line.length > MAX_QUESTION_LENGTH)) {
    return `Keep each question under ${MAX_QUESTION_LENGTH} characters.`;
  }
  return lines.map((label, index) => ({
    id: `q${index + 1}`,
    label,
    type: "text" as const,
    required: false,
  }));
}

export function questionsToText(questions: unknown): string {
  if (!Array.isArray(questions)) return "";
  return questions
    .map((q) => (q && typeof q === "object" && "label" in q ? String(q.label) : ""))
    .filter((label) => label !== "")
    .join("\n");
}

export function parseDepartureForm(form: FormData): DepartureFormResult {
  const values = readDepartureValues(form);
  const errors: DepartureFormErrors = {};

  if (!UUID.test(values.trip_id)) errors.trip_id = "Choose a trip.";

  if (!isIsoDate(values.start_date)) errors.start_date = "Enter a start date.";
  if (!isIsoDate(values.end_date)) errors.end_date = "Enter an end date.";
  if (!errors.start_date && !errors.end_date && values.end_date < values.start_date) {
    errors.end_date = "The end date cannot be before the start date.";
  }

  const price = parseDollarsToCents(values.price);
  if (price === null) errors.price = "Enter a price in dollars, like 4950.";
  else if (price > MAX_PRICE_CENTS) errors.price = "That price is too high.";

  const deposit = parseDollarsToCents(values.deposit);
  if (deposit === null) errors.deposit = "Enter a deposit in dollars, like 750.";
  else if (price !== null && deposit > price) {
    errors.deposit = "The deposit cannot be more than the price.";
  }

  let balanceDue = values.balance_due_date;
  if (balanceDue === "" && !errors.start_date) {
    balanceDue = addDays(values.start_date, -BALANCE_DUE_DAYS_BEFORE);
  }
  if (!isIsoDate(balanceDue)) {
    if (!errors.start_date) errors.balance_due_date = "Enter a date, or leave it blank.";
  } else if (!errors.start_date && balanceDue > values.start_date) {
    errors.balance_due_date = "The balance must be due on or before the start date.";
  }

  const min = wholeNumber(values.min_travelers);
  const max = wholeNumber(values.max_travelers);
  if (min === null || min < 1) errors.min_travelers = "Enter a number of at least 1.";
  if (max === null || max < 1) errors.max_travelers = "Enter a number of at least 1.";
  else if (max > MAX_GROUP) errors.max_travelers = `At most ${MAX_GROUP} travelers.`;
  else if (min !== null && min >= 1 && min > max) {
    errors.min_travelers = "The minimum cannot be more than the maximum.";
  }

  const status = DEPARTURE_STATUSES.find((s) => s === values.status);
  if (!status) errors.status = "Choose a status.";
  const visibility = DEPARTURE_VISIBILITIES.find((v) => v === values.visibility);
  if (!visibility) errors.visibility = "Choose who can see it.";

  if (values.policy_version_id !== "" && !UUID.test(values.policy_version_id)) {
    errors.policy_version_id = "Choose a policy from the list.";
  }

  const questions = parseCustomQuestions(values.custom_questions);
  if (typeof questions === "string") errors.custom_questions = questions;

  if (Object.keys(errors).length > 0) return { ok: false, errors, values };

  return {
    ok: true,
    data: {
      trip_id: values.trip_id,
      start_date: values.start_date,
      end_date: values.end_date,
      price_cents: price as number,
      deposit_cents: deposit as number,
      balance_due_date: balanceDue,
      min_travelers: min as number,
      max_travelers: max as number,
      status: status as DepartureStatus,
      visibility: visibility as DepartureVisibility,
      policy_version_id: values.policy_version_id || null,
      custom_questions: questions as CustomQuestion[],
    },
  };
}

/** The unguessable part of a private departure's link. 32 URL-safe characters. */
export function newPrivateToken(): string {
  return randomBytes(24).toString("base64url");
}
