import { scheduledPayments } from "../bookings/plan";

/**
 * What a booking still owes and what its traveler can pay by card right now.
 * Worked out on the server from the database, in integer cents. The browser
 * only ever says which option it picked.
 */

export interface Account {
  traveler_count: number;
  total_cents: number;
  discount_cents: number;
  paid_cents: number;
  /** Per person. */
  deposit_cents: number;
  payment_schedule: unknown;
  balance_due_date: string;
}

export type PayOptionKey = "deposit" | "next" | "balance";

export interface PayOption {
  key: PayOptionKey;
  label: string;
  amount_cents: number;
  /** YYYY-MM-DD, or null when it is due now. */
  due_date: string | null;
}

/** What the trip still costs this booking after credits and payments. Never negative. */
export function balanceCents(account: Account): number {
  return Math.max(account.total_cents - account.discount_cents - account.paid_cents, 0);
}

interface Step {
  label: string;
  due_date: string | null;
  /** The running total that should be paid once this step is done. */
  upTo: number;
}

/** The deposit, each scheduled payment, then the final balance, as running totals. */
function steps(account: Account): Step[] {
  const owed = Math.max(account.total_cents - account.discount_cents, 0);
  const list: Step[] = [];
  let upTo = Math.min(account.deposit_cents * account.traveler_count, owed);
  if (upTo > 0) list.push({ label: "Deposit", due_date: null, upTo });
  for (const line of scheduledPayments(account.payment_schedule)) {
    upTo = Math.min(upTo + line.amount_cents * account.traveler_count, owed);
    list.push({ label: line.label, due_date: line.due_date, upTo });
  }
  list.push({ label: "Final balance", due_date: account.balance_due_date, upTo: owed });
  return list;
}

/**
 * The card payments on offer: the next step in the schedule and, when that
 * is not everything, the whole remaining balance. Nothing when nothing is owed.
 */
export function payOptions(account: Account): PayOption[] {
  const balance = balanceCents(account);
  if (balance <= 0) return [];

  const all = steps(account);
  const next = all.find((step) => step.upTo > account.paid_cents);
  if (!next || next.upTo - account.paid_cents >= balance) {
    return [
      {
        key: "balance",
        label: account.paid_cents > 0 ? "Remaining balance" : "Full amount",
        amount_cents: balance,
        due_date: account.balance_due_date,
      },
    ];
  }
  return [
    {
      key: next === all[0] && next.label === "Deposit" ? "deposit" : "next",
      label: next.label,
      amount_cents: next.upTo - account.paid_cents,
      due_date: next.due_date,
    },
    {
      key: "balance",
      label: account.paid_cents > 0 ? "Remaining balance" : "Full amount",
      amount_cents: balance,
      due_date: account.balance_due_date,
    },
  ];
}

/** Card fees are stored in hundredths of a percent: 300 is 3%. At most 10%. */
export const MAX_CARD_FEE_BPS = 1000;

/** The fee added on top of a card payment, rounded to the nearest cent. */
export function cardFeeCents(amountCents: number, feeBps: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new RangeError("amount must be whole cents");
  }
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > MAX_CARD_FEE_BPS) {
    throw new RangeError("card fee out of range");
  }
  return Math.round((amountCents * feeBps) / 10_000);
}

/** "3", "2.9" or "0" as typed by staff, to hundredths of a percent. Null when it is not a fee. */
export function parseFeePercent(input: string): number | null {
  const text = input.trim().replace(/%$/, "").trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bps <= MAX_CARD_FEE_BPS ? bps : null;
}

/** 300 -> "3", 290 -> "2.9", 275 -> "2.75". */
export function formatFeePercent(feeBps: number): string {
  return (feeBps / 100).toFixed(2).replace(/\.?0+$/, "");
}
