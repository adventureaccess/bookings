/**
 * Money is integer cents in USD, everywhere. These helpers refuse anything else
 * so a float or a negative never reaches Stripe or the database.
 */

export const CURRENCY = "usd" as const;

export function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function assertCents(value: unknown, label = "amount"): number {
  if (!isCents(value)) {
    throw new RangeError(`${label} must be a non-negative whole number of cents`);
  }
  return value;
}

/** Per-person amount times a traveler count, e.g. the deposit for a party. */
export function multiplyCents(cents: number, quantity: number): number {
  assertCents(cents);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new RangeError("quantity must be a whole number of at least 1");
  }
  return assertCents(cents * quantity, "total");
}

/** What is still owed. Never negative: an overpaid booking owes nothing. */
export function balanceCents(totalCents: number, paidCents: number): number {
  assertCents(totalCents, "total");
  assertCents(paidCents, "paid");
  return Math.max(0, totalCents - paidCents);
}

/** Decimal dollars for HubSpot deal amounts. Display and CRM only. */
export function centsToDollars(cents: number): number {
  return assertCents(cents) / 100;
}

const withCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const wholeDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** "$4,950" for whole dollars, "$4,950.50" otherwise. */
export function formatUsd(cents: number): string {
  assertCents(cents);
  return cents % 100 === 0
    ? wholeDollars.format(cents / 100)
    : withCents.format(cents / 100);
}

/**
 * Reads a dollar amount typed into a form ("4,950", "$4950.00", "750.5") as
 * cents. Works on the digits as text, so no floating-point rounding can
 * creep in. Returns null for anything that is not a plain dollar amount.
 */
export function parseDollarsToCents(input: string): number | null {
  const text = input.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const total = dollars * 100 + cents;
  return isCents(total) ? total : null;
}

/** Cents as a plain form value: 495000 becomes "4950", 495050 becomes "4950.50". */
export function centsToInputValue(cents: number): string {
  assertCents(cents);
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(dollars) : `${dollars}.${String(rest).padStart(2, "0")}`;
}
