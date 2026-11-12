import { timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import { CRON_SECRET } from "astro:env/server";
import { deleteExpiredHolds } from "../../../lib/payments/db";

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

export const POST: APIRoute = async ({ request }) => {
  if (!CRON_SECRET) return json(503, { error: "cron not configured" });
  if (!secretMatches(request.headers.get("x-cron-secret"))) return json(401, { error: "unauthorized" });

  const deleted = await deleteExpiredHolds();
  if (deleted === null) return json(500, { error: "cleanup failed" });
  return json(200, { deleted });
};
