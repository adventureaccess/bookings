import { createHash } from "node:crypto";

/**
 * The rate limit rules: how many requests one connection may make, per
 * window, for each kind of form post. Pure, so the rules can be tested.
 * src/lib/rate-limit.ts applies them.
 *
 * The limits are set well above what a real family or group does from one
 * home or office connection, and well below what a script would need.
 */

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

const TEN_MINUTES = 600;

export const RATE_LIMITS = {
  /** Registration form posts. A group of ten registering from one office, with mistakes, stays under this. */
  booking_form: { limit: 40, windowSeconds: TEN_MINUTES },
  /** Starting a card payment. Each one creates a Stripe session. */
  payment_start: { limit: 20, windowSeconds: TEN_MINUTES },
  /** Document uploads. Each one sends a file to the Shared Drive. */
  document_upload: { limit: 30, windowSeconds: TEN_MINUTES },
  /** Waiver signatures. */
  waiver_sign: { limit: 30, windowSeconds: TEN_MINUTES },
  /** Starting staff sign-in. */
  staff_sign_in: { limit: 20, windowSeconds: TEN_MINUTES },
  /** The scheduled-job routes. The schedule itself calls each a few times an hour. */
  cron: { limit: 60, windowSeconds: TEN_MINUTES },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitScope = keyof typeof RATE_LIMITS;

/**
 * The counter's key: the scope plus a hash of the caller's address. The
 * address itself is never stored. Callers with no known address share one
 * counter per scope.
 */
export function rateLimitKey(scope: RateLimitScope, address: string | null): string {
  const who = address ? createHash("sha256").update(address).digest("hex").slice(0, 32) : "unknown";
  return `${scope}:${who}`;
}

export const TOO_MANY =
  "Too many attempts from this connection. Wait a few minutes and try again.";
