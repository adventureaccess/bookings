import type { OutgoingEmail, SendEmail } from "../email/resend";
import { isEmailTemplate, renderEmail, type EmailBooking } from "../email/templates";
import type { HubSpotClient } from "../hubspot/client";
import { syncBookingToHubSpot, type HubSpotConfig, type SyncBooking, type SyncResult } from "../hubspot/sync";

/**
 * The sync worker: takes waiting jobs one at a time and does them. A job
 * that fails is left for its next try; the queue handles the delay and the
 * giving up. Everything it touches is passed in, so it can be tested without
 * a database, HubSpot or an email service.
 */

/** A job is given up after this many attempts, about a day in all. */
export const MAX_ATTEMPTS = 6;

export type JobKind = "hubspot" | "email";

export interface SyncJob {
  id: string;
  kind: JobKind;
  booking_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

/** A booking with everything both kinds of job need. */
export interface WorkerBooking extends SyncBooking, EmailBooking {
  lead_email: string | null;
}

export interface WorkerDeps {
  /** Null until a HubSpot token and a pipeline are both set. */
  hubspot: { client: HubSpotClient; config: HubSpotConfig } | null;
  /** Null until an email key and a from address are both set. */
  email: { send: SendEmail; from: string; staffTo: string } | null;
  /** The site's own address, for links back into the admin. */
  origin: string;
  claim(kinds: JobKind[], limit: number): Promise<SyncJob[]>;
  complete(jobId: string): Promise<void>;
  /** Records the failure. Returns true when the job was given up. */
  fail(jobId: string, error: string, maxAttempts: number): Promise<boolean>;
  loadBooking(bookingId: string): Promise<WorkerBooking | null>;
  saveHubSpotIds(bookingId: string, result: SyncResult): Promise<void>;
  now?: () => number;
}

export interface WorkerReport {
  done: number;
  failed: number;
  gaveUp: number;
  /** Kinds that were not attempted because they are not set up yet. */
  waitingOnSetup: JobKind[];
  /** Custom deal properties HubSpot does not have, seen during this run. */
  missingProperties: string[];
}

/** A short reason safe to store and show: the error's own message, which never holds personal data. */
function reason(error: unknown): string {
  if (error instanceof Error && (error.name === "HubSpotError" || error.name === "EmailError")) {
    return error.message;
  }
  if (error instanceof Error && error.name === "TimeoutError") return "The request timed out";
  return "Unexpected error";
}

async function runHubSpotJob(job: SyncJob, deps: WorkerDeps, report: WorkerReport): Promise<void> {
  if (!deps.hubspot || !job.booking_id) return;
  const booking = await deps.loadBooking(job.booking_id);
  if (!booking) return; // the booking is gone; nothing to send
  const result = await syncBookingToHubSpot(
    deps.hubspot.client,
    deps.hubspot.config,
    booking,
    `${deps.origin}/admin/bookings/${booking.id}`,
  );
  await deps.saveHubSpotIds(booking.id, result);
  for (const name of result.missingProperties) {
    if (!report.missingProperties.includes(name)) report.missingProperties.push(name);
  }
}

async function runEmailJob(job: SyncJob, deps: WorkerDeps): Promise<void> {
  if (!deps.email || !job.booking_id) return;
  const template = job.payload.template;
  if (!isEmailTemplate(template)) return; // unknown template: nothing to send
  const booking = await deps.loadBooking(job.booking_id);
  if (!booking) return;

  const message = renderEmail(template, booking, job.payload, `${deps.origin}/admin/bookings/${booking.id}`);
  if (!message) return;
  const to = message.to === "staff" ? deps.email.staffTo : booking.lead_email;
  if (!to) return;

  const email: OutgoingEmail = {
    from: deps.email.from,
    to,
    subject: message.subject,
    text: message.text,
    idempotencyKey: job.id,
  };
  await deps.email.send(email);
}

/**
 * Works through waiting jobs until there are none, `maxJobs` are done, or the
 * time budget runs out. Jobs are claimed one at a time, so stopping early
 * never leaves a claimed job untouched.
 */
export async function runSyncJobs(
  deps: WorkerDeps,
  limits: { maxJobs?: number; budgetMs?: number } = {},
): Promise<WorkerReport> {
  const maxJobs = limits.maxJobs ?? 10;
  const budgetMs = limits.budgetMs ?? 7000;
  const now = deps.now ?? Date.now;
  const started = now();

  const kinds: JobKind[] = [];
  const waitingOnSetup: JobKind[] = [];
  (deps.hubspot ? kinds : waitingOnSetup).push("hubspot");
  (deps.email ? kinds : waitingOnSetup).push("email");

  const report: WorkerReport = { done: 0, failed: 0, gaveUp: 0, waitingOnSetup, missingProperties: [] };
  if (kinds.length === 0) return report;

  for (let handled = 0; handled < maxJobs && now() - started < budgetMs; handled++) {
    const [job] = await deps.claim(kinds, 1);
    if (!job) break;
    try {
      if (job.kind === "hubspot") await runHubSpotJob(job, deps, report);
      else await runEmailJob(job, deps);
      await deps.complete(job.id);
      report.done += 1;
    } catch (error) {
      report.failed += 1;
      if (await deps.fail(job.id, reason(error), MAX_ATTEMPTS)) report.gaveUp += 1;
    }
  }
  return report;
}
