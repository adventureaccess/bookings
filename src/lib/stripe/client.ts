import Stripe from "stripe";
import { STRIPE_LIVE_MODE, STRIPE_SECRET_KEY } from "astro:env/server";

/**
 * The Stripe client. Server code only.
 *
 * Test mode everywhere until Will flips the keys: a live key is refused
 * unless STRIPE_LIVE_MODE is also set to true, so a live key pasted by
 * mistake cannot take real money.
 */

export class StripeNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeNotConfigured";
  }
}

/** True for sk_test_ and rk_test_ keys. */
export function isTestKey(key: string): boolean {
  return /^(sk|rk)_test_/.test(key);
}

let client: Stripe | null = null;

export function stripeClient(): Stripe {
  if (client) return client;
  if (!STRIPE_SECRET_KEY) throw new StripeNotConfigured("STRIPE_SECRET_KEY is not set");
  if (!isTestKey(STRIPE_SECRET_KEY) && !STRIPE_LIVE_MODE) {
    throw new StripeNotConfigured(
      "STRIPE_SECRET_KEY is not a test key and STRIPE_LIVE_MODE is not on",
    );
  }
  client = new Stripe(STRIPE_SECRET_KEY);
  return client;
}
