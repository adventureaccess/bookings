import { timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import { CRON_SECRET } from "astro:env/server";
import { allowRequest, callerAddress } from "../../../lib/rate-limit";
import { deleteExpiredHolds } from "../../../lib/payments/db";
import { createServiceClient } from "../../../lib/supabase/service";

/**
 * Housekeeping, called by the scheduled function in netlify/functions with
 * the shared secret header. Deletes seat holds that ran out more than an
 * hour ago. Expired holds already count for nothing; this only keeps the
 * table small.
 */

export const prerender = false;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function secretMatches(given: string | null): boolean {
  if (!CRON_SECRET || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(CRON_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  if (!CRON_SECRET) return json(503, { error: "cron not configured" });
  if (!(await allowRequest("cron", callerAddress({ clientAddress })))) {
    return json(429, { error: "too many requests" });
  }
  if (!secretMatches(request.headers.get("x-cron-secret"))) return json(401, { error: "unauthorized" });

  const deleted = await deleteExpiredHolds();
  if (deleted === null) return json(500, { error: "cleanup failed" });
  // Rate limit counters older than a day are of no use either.
  const { error } = await createServiceClient().rpc("delete_old_rate_limits");
  if (error) console.error("[cron] rate limit cleanup failed", { code: error.code ?? "unknown" });
  return json(200, { deleted });
};
