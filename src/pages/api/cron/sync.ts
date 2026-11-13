import { timingSafeEqual } from "node:crypto";
import type { APIRoute } from "astro";
import { CRON_SECRET } from "astro:env/server";
import { allowRequest, callerAddress } from "../../../lib/rate-limit";
import { workerDeps } from "../../../lib/sync/db";
import { runSyncJobs } from "../../../lib/sync/worker";

/**
 * Runs the sync worker: HubSpot updates and emails waiting in the queue.
 * Called every few minutes by the scheduled function in netlify/functions,
 * with the shared secret header.
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

export const POST: APIRoute = async ({ request, url, clientAddress }) => {
  if (!CRON_SECRET) return json(503, { error: "cron not configured" });
  if (!(await allowRequest("cron", callerAddress({ clientAddress })))) {
    return json(429, { error: "too many requests" });
  }
  if (!secretMatches(request.headers.get("x-cron-secret"))) return json(401, { error: "unauthorized" });

  const report = await runSyncJobs(await workerDeps(url.origin));
  // Counts only. Nothing about who or what was synced.
  return json(200, {
    done: report.done,
    failed: report.failed,
    gave_up: report.gaveUp,
    waiting_on_setup: report.waitingOnSetup,
  });
};
