import { defineAction } from "astro:actions";
import { logActivity } from "../lib/admin/db";
import { hashAccessToken, newAccessToken } from "../lib/bookings/token";
import { BOOKING_STATUSES, type HubSpotConfig } from "../lib/hubspot/sync";
import { createServiceClient } from "../lib/supabase/service";
import {
  enqueueBookingLinkEmail,
  hubSpotClient,
  retryJob,
  setHubSpotConfig,
  workerDeps,
} from "../lib/sync/db";
import { runSyncJobs } from "../lib/sync/worker";
import { formText, formUuid, requireAdmin, requireWriter } from "./guards";

/** Sync actions: HubSpot settings, the queue, and sending a traveler a new link. Staff only. */

export type SyncActionResult = { ok: true; note?: string } | { ok: false; message: string };
const failed = (message: string): SyncActionResult => ({ ok: false, message });

export const syncActions = {
  /** Which HubSpot pipeline bookings go into, and the stage for each status. Admins only. */
  saveHubSpotSettings: defineAction({
    accept: "form",
    handler: async (form, context): Promise<SyncActionResult> => {
      const staff = requireAdmin(context);
      const client = hubSpotClient();
      if (!client) return failed("Set the HubSpot token first. Nothing was saved.");

      const pipelineId = formText(form, "pipeline_id", 100);
      const stages = {} as HubSpotConfig["stages"];
      for (const status of BOOKING_STATUSES) stages[status] = formText(form, `stage_${status}`, 100);

      // Only pipelines and stages that really exist in HubSpot can be chosen.
      let pipelines;
      try {
        pipelines = await client.dealPipelines();
      } catch {
        return failed("HubSpot could not be reached to check the pipeline. Nothing was saved.");
      }
      const pipeline = pipelines.find((p) => p.id === pipelineId);
      if (!pipeline) return failed("Choose a pipeline from the list.");
      const known = new Set(pipeline.stages.map((stage) => stage.id));
      if (BOOKING_STATUSES.some((status) => !known.has(stages[status]))) {
        return failed("Choose a stage from that pipeline for every booking status.");
      }

      if (!(await setHubSpotConfig({ pipeline_id: pipelineId, stages }))) {
        return failed("Could not save the HubSpot settings. Try again.");
      }
      await logActivity(staff, "settings", null, "set_hubspot_pipeline", { pipeline: pipeline.label });
      return { ok: true };
    },
  }),

  /** Tries a waiting or given-up job again from the start. */
  retrySyncJob: defineAction({
    accept: "form",
    handler: async (form, context): Promise<SyncActionResult> => {
      const staff = requireWriter(context);
      const jobId = formUuid(form, "job_id");
      if (!(await retryJob(jobId))) return failed("That job has already finished.");
      await logActivity(staff, "sync_job", jobId, "retry");
      return { ok: true };
    },
  }),

  /** Works through the queue now, without waiting for the next scheduled run. */
  runSyncNow: defineAction({
    accept: "form",
    handler: async (_form, context): Promise<SyncActionResult> => {
      requireWriter(context);
      const report = await runSyncJobs(await workerDeps(context.url.origin), { maxJobs: 8, budgetMs: 6000 });
      const parts = [`${report.done} done`, `${report.failed} failed`];
      if (report.waitingOnSetup.length > 0) {
        parts.push(`${report.waitingOnSetup.join(" and ")} not set up yet`);
      }
      return { ok: true, note: parts.join(", ") };
    },
  }),

  /**
   * Emails the traveler a fresh link to their booking. The old link stops
   * working, because only one access token is kept per booking.
   */
  sendNewBookingLink: defineAction({
    accept: "form",
    handler: async (form, context): Promise<SyncActionResult> => {
      const staff = requireWriter(context);
      const bookingId = formUuid(form, "booking_id");
      const db = createServiceClient();

      const { data: booking, error: readError } = await db
        .from("bookings")
        .select("reference, travelers!travelers_booking_id_fkey ( email, is_lead )")
        .eq("id", bookingId)
        .maybeSingle();
      if (readError || !booking) return failed("That booking was not found.");
      const travelers = booking.travelers as { email: string | null; is_lead: boolean }[];
      if (!travelers.some((t) => t.is_lead && t.email)) {
        return failed("This booking has no email address to send a link to.");
      }

      const token = newAccessToken();
      const { error } = await db
        .from("bookings")
        .update({ access_token_hash: hashAccessToken(token) })
        .eq("id", bookingId);
      if (error) return failed("Could not make a new link. The old one still works.");

      const url = `${context.url.origin}/booking/${booking.reference as string}?t=${token}`;
      if (!(await enqueueBookingLinkEmail(bookingId, "traveler_new_link", url))) {
        return failed("A new link was made but the email could not be queued. Try again to send another.");
      }
      await logActivity(staff, "booking", bookingId, "send_new_link");
      return { ok: true };
    },
  }),
};
