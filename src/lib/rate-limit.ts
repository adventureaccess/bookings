import { isIP } from "node:net";
import { RATE_LIMITS, rateLimitKey, type RateLimitScope } from "./rate-limit-rules";
import { createServiceClient } from "./supabase/service";

/**
 * Applies the rate limit rules, counting in Postgres so every server
 * instance shares the same counters.
 */

/** The caller's address if it is a real IP, else null. */
export function callerAddress(context: { clientAddress: string }): string | null {
  try {
    return isIP(context.clientAddress) ? context.clientAddress : null;
  } catch {
    return null; // some hosts cannot tell; treat as unknown
  }
}

/**
 * Counts this request and says whether it may go ahead.
 *
 * Not enforced on the dev server: everything there comes from one address,
 * and the browser tests would trip it. If the counter itself cannot be
 * reached the request is allowed, so a database hiccup never locks
 * travelers out; the forms have their own checks behind this one.
 */
export async function allowRequest(scope: RateLimitScope, address: string | null): Promise<boolean> {
  if (import.meta.env.DEV) return true;
  const rule = RATE_LIMITS[scope];
  const { data, error } = await createServiceClient().rpc("check_rate_limit", {
    p_key: rateLimitKey(scope, address),
    p_limit: rule.limit,
    p_window_seconds: rule.windowSeconds,
  });
  if (error) {
    console.error("[rate-limit] counter unavailable", { scope, code: error.code ?? "unknown" });
    return true;
  }
  return data !== false;
}
