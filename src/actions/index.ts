import { ActionError, defineAction, type ActionAPIContext } from "astro:actions";
import { TRIPS_FEED_URL } from "astro:env/server";
import {
  deleteDeparture,
  publishPolicy,
  saveDeparture,
  savePolicy,
  syncTrips,
  type TripSyncSummary,
} from "../lib/admin/db";
import { canWrite, type StaffSession } from "../lib/auth/staff";
import {
  parseDepartureForm,
  readDepartureValues,
  type DepartureFormErrors,
  type DepartureFormValues,
} from "../lib/departures/form";
import {
  parsePolicyForm,
  type PolicyFormErrors,
  type PolicyFormValues,
} from "../lib/policies/form";

/**
 * Admin actions. Each one is reachable directly at /_actions/<name> as well
 * as through its form, so each one checks the staff role itself. The
 * middleware has already resolved who is signed in.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in staff member, if they may change things. Otherwise throws. */
function requireWriter(context: ActionAPIContext): StaffSession {
  const staff = context.locals.staff;
  if (!staff) {
    throw new ActionError({ code: "UNAUTHORIZED", message: "Sign in first." });
  }
  if (!canWrite(staff)) {
    throw new ActionError({
      code: "FORBIDDEN",
      message: "Your account can view but not change this.",
    });
  }
  return staff;
}

/** An optional record id from a hidden form field. "" means a new record. */
function readId(form: FormData): string | null {
  const raw = form.get("id");
  if (typeof raw !== "string" || raw === "") return null;
  if (!UUID.test(raw)) {
    throw new ActionError({ code: "BAD_REQUEST", message: "That record id is not valid." });
  }
  return raw;
}

function requireId(form: FormData): string {
  const id = readId(form);
  if (!id) throw new ActionError({ code: "BAD_REQUEST", message: "Missing record id." });
  return id;
}

export type DepartureActionResult =
  | { ok: true; id: string }
  | {
      ok: false;
      message?: string;
      errors: DepartureFormErrors;
      values: DepartureFormValues;
    };

export type PolicyActionResult =
  | { ok: true; id: string }
  | { ok: false; message?: string; errors: PolicyFormErrors; values: PolicyFormValues };

export type SimpleActionResult = { ok: true } | { ok: false; message: string };

export type SyncActionResult =
  | { ok: true; summary: TripSyncSummary }
  | { ok: false; message: string };

export const server = {
  saveDeparture: defineAction({
    accept: "form",
    handler: async (form, context): Promise<DepartureActionResult> => {
      const staff = requireWriter(context);
      const id = readId(form);
      const parsed = parseDepartureForm(form);
      if (!parsed.ok) return parsed;
      const saved = await saveDeparture(id, parsed.data, staff);
      if (!saved.ok) {
        return {
          ok: false,
          message: saved.message,
          errors: {},
          values: readDepartureValues(form),
        };
      }
      return { ok: true, id: saved.value };
    },
  }),

  deleteDeparture: defineAction({
    accept: "form",
    handler: async (form, context): Promise<SimpleActionResult> => {
      const staff = requireWriter(context);
      const result = await deleteDeparture(requireId(form), staff);
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
  }),

  savePolicy: defineAction({
    accept: "form",
    handler: async (form, context): Promise<PolicyActionResult> => {
      const staff = requireWriter(context);
      const id = readId(form);
      const parsed = parsePolicyForm(form);
      if (!parsed.ok) return parsed;
      const saved = await savePolicy(id, parsed.data, staff);
      if (!saved.ok) {
        return { ok: false, message: saved.message, errors: {}, values: parsed.data };
      }
      return { ok: true, id: saved.value };
    },
  }),

  publishPolicy: defineAction({
    accept: "form",
    handler: async (form, context): Promise<SimpleActionResult> => {
      const staff = requireWriter(context);
      const result = await publishPolicy(requireId(form), staff);
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
  }),

  syncTrips: defineAction({
    accept: "form",
    handler: async (_form, context): Promise<SyncActionResult> => {
      const staff = requireWriter(context);
      const result = await syncTrips(TRIPS_FEED_URL, staff);
      return result.ok
        ? { ok: true, summary: result.value }
        : { ok: false, message: result.message };
    },
  }),
};
