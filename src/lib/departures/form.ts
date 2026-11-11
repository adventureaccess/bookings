import { randomBytes } from "node:crypto";
import { addDays, isIsoDate } from "../dates";
import { centsToInputValue, parseDollarsToCents } from "../money";

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

/**
 * A payment due between the deposit and the final balance. The amount is per
 * person. The final balance (total minus paid) stays due on balance_due_date.
 */
export interface ScheduledPayment {
  id: string;
  label: string;
  due_date: string;
  amount_cents: number;
}

/** The admin form offers this many scheduled payments per departure. */
export const SCHEDULE_ROWS = [1, 2, 3, 4] as const;
type ScheduleRow = (typeof SCHEDULE_ROWS)[number];
export type ScheduleField = `payment_${ScheduleRow}_${"label" | "due" | "amount"}`;
const SCHEDULE_FIELDS = SCHEDULE_ROWS.flatMap((n) => [
  `payment_${n}_label`,
  `payment_${n}_due`,
  `payment_${n}_amount`,
]) as ScheduleField[];
const MAX_PAYMENT_LABEL_LENGTH = 80;

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
  payment_schedule: ScheduledPayment[];
}

const BASE_FIELDS = [
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
type BaseField = (typeof BASE_FIELDS)[number];
export type DepartureField = BaseField | ScheduleField;
export const DEPARTURE_FIELDS: readonly DepartureField[] = [...BASE_FIELDS, ...SCHEDULE_FIELDS];
export type DepartureFormValues = Record<DepartureField, string>;
/** The scheduled payment rows share one message, under `payment_schedule`. */
export type DepartureFormErrors = Partial<Record<BaseField | "payment_schedule", string>>;

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

/**
 * Reads the scheduled payment rows. A row counts once anything is typed in
 * it. Returns the payments in date order, or one message for the section.
 * `limits` holds the already-parsed price, deposit and final balance date;
 * a null skips the checks that depend on it.
 */
export function parsePaymentSchedule(
  values: Pick<DepartureFormValues, ScheduleField>,
  limits: { priceCents: number | null; depositCents: number | null; balanceDue: string | null },
): ScheduledPayment[] | string {
  const payments: Omit<ScheduledPayment, "id">[] = [];
  for (const n of SCHEDULE_ROWS) {
    const label = values[`payment_${n}_label`];
    const due = values[`payment_${n}_due`];
    const amountText = values[`payment_${n}_amount`];
    if (label === "" && due === "" && amountText === "") continue;

    if (!isIsoDate(due)) return `Payment ${n} needs a due date.`;
    const amount = parseDollarsToCents(amountText);
    if (amount === null || amount <= 0) {
      return `Payment ${n} needs an amount in dollars, like 1500.`;
    }
    if (label.length > MAX_PAYMENT_LABEL_LENGTH) {
      return `Keep the name of payment ${n} under ${MAX_PAYMENT_LABEL_LENGTH} characters.`;
    }
    if (limits.balanceDue !== null && due >= limits.balanceDue) {
      return `Payment ${n} must be due before the final balance date.`;
    }
    payments.push({ label: label || "Scheduled payment", due_date: due, amount_cents: amount });
  }

  payments.sort((a, b) => a.due_date.localeCompare(b.due_date));
  if (limits.priceCents !== null && limits.depositCents !== null) {
    const scheduled = payments.reduce((sum, p) => sum + p.amount_cents, 0);
    if (limits.depositCents + scheduled > limits.priceCents) {
      return "The deposit plus the scheduled payments come to more than the price.";
    }
  }
  return payments.map((payment, index) => ({ id: `p${index + 1}`, ...payment }));
}

/** A stored schedule as form values, one row per payment, the rest blank. */
export function scheduleToValues(schedule: unknown): Record<ScheduleField, string> {
  const rows = Array.isArray(schedule) ? schedule : [];
  const values = {} as Record<ScheduleField, string>;
  for (const n of SCHEDULE_ROWS) {
    const row: unknown = rows[n - 1];
    const item = row && typeof row === "object" ? (row as Partial<ScheduledPayment>) : {};
    values[`payment_${n}_label`] = typeof item.label === "string" ? item.label : "";
    values[`payment_${n}_due`] = typeof item.due_date === "string" ? item.due_date : "";
    values[`payment_${n}_amount`] =
      typeof item.amount_cents === "number" ? centsToInputValue(item.amount_cents) : "";
  }
  return values;
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

  const schedule = parsePaymentSchedule(values, {
    priceCents: errors.price ? null : price,
    depositCents: errors.deposit ? null : deposit,
    balanceDue: errors.balance_due_date || errors.start_date ? null : balanceDue,
  });
  if (typeof schedule === "string") errors.payment_schedule = schedule;

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
      payment_schedule: schedule as ScheduledPayment[],
    },
  };
}

/** The unguessable part of a private departure's link. 32 URL-safe characters. */
export function newPrivateToken(): string {
  return randomBytes(24).toString("base64url");
}
