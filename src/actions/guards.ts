import { ActionError, type ActionAPIContext } from "astro:actions";
import { canWrite, type StaffSession } from "../lib/auth/staff";

/**
 * Role checks for admin actions. Every action is reachable directly at
 * /_actions/<name> as well as through its form, so each one calls one of
 * these itself. The middleware has already resolved who is signed in.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in staff member, if they may change things. Otherwise throws. */
export function requireWriter(context: ActionAPIContext): StaffSession {
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

/** The signed-in staff member, if they are an admin. Otherwise throws. */
export function requireAdmin(context: ActionAPIContext): StaffSession {
  const staff = requireWriter(context);
  if (staff.role !== "admin") {
    throw new ActionError({ code: "FORBIDDEN", message: "Only an admin can change this." });
  }
  return staff;
}

/** A required uuid from a form field. */
export function formUuid(form: FormData, name: string): string {
  const raw = form.get(name);
  if (typeof raw !== "string" || !UUID.test(raw)) {
    throw new ActionError({ code: "BAD_REQUEST", message: "That record id is not valid." });
  }
  return raw;
}

/** A form field as trimmed text, capped. Files and missing fields become "". */
export function formText(form: FormData, name: string, max = 500): string {
  const raw = form.get(name);
  return typeof raw === "string" ? raw.trim().slice(0, max) : "";
}
