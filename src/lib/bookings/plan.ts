/**
 * What a party will pay and when, worked out on the server from the
 * departure. Integer cents throughout.
 */

export interface PlanLine {
  label: string;
  /** YYYY-MM-DD, or null for the deposit, which is due when booking. */
  due_date: string | null;
  amount_cents: number;
}

export interface PaymentPlan {
  total_cents: number;
  lines: PlanLine[];
}

interface PlanSource {
  price_cents: number;
  deposit_cents: number;
  balance_due_date: string;
  payment_schedule: unknown;
}

/** The departure's scheduled payments, per person, in date order. Skips anything malformed. */
export function scheduledPayments(raw: unknown): PlanLine[] {
  if (!Array.isArray(raw)) return [];
  const lines: PlanLine[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const { label, due_date, amount_cents } = item as Record<string, unknown>;
    if (
      typeof due_date === "string" &&
      typeof amount_cents === "number" &&
      Number.isSafeInteger(amount_cents) &&
      amount_cents > 0
    ) {
      lines.push({
        label: typeof label === "string" && label ? label : "Scheduled payment",
        due_date,
        amount_cents,
      });
    }
  }
  return lines.sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));
}

/** The deposit, each scheduled payment, then whatever is left as the final balance. */
export function paymentPlan(departure: PlanSource, travelers: number): PaymentPlan {
  if (!Number.isSafeInteger(travelers) || travelers < 1) {
    throw new RangeError("travelers must be a whole number of at least 1");
  }
  const scheduled = scheduledPayments(departure.payment_schedule);
  const perPersonLater = scheduled.reduce((sum, line) => sum + line.amount_cents, 0);
  const perPersonBalance = departure.price_cents - departure.deposit_cents - perPersonLater;

  const lines: PlanLine[] = [];
  if (departure.deposit_cents > 0) {
    lines.push({ label: "Deposit", due_date: null, amount_cents: departure.deposit_cents * travelers });
  }
  for (const line of scheduled) {
    lines.push({ ...line, amount_cents: line.amount_cents * travelers });
  }
  if (perPersonBalance > 0) {
    lines.push({
      label: "Final balance",
      due_date: departure.balance_due_date,
      amount_cents: perPersonBalance * travelers,
    });
  }
  return { total_cents: departure.price_cents * travelers, lines };
}
