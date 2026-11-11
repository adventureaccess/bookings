/**
 * Who counts as staff. Pure functions, no I/O, so the rules can be tested.
 *
 * Three things must all be true:
 *   1. The account was created through Google sign-in.
 *   2. Its email is confirmed and ends in @adventure-access.com.
 *   3. That email is in the staff table (checked by the caller).
 */

export const STAFF_DOMAIN = "adventure-access.com";

export type StaffRole = "admin" | "staff" | "read_only";

export interface StaffSession {
  email: string;
  role: StaffRole;
}

/** The parts of a Supabase user this module reads. */
export interface AuthUserLike {
  email?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: { provider?: string } | null;
}

/**
 * The lowercased email if this user could be staff, otherwise null.
 * app_metadata is set by Supabase and cannot be edited by the user.
 */
export function eligibleStaffEmail(user: AuthUserLike | null | undefined): string | null {
  if (!user?.email || !user.email_confirmed_at) return null;
  if (user.app_metadata?.provider !== "google") return null;
  const email = user.email.trim().toLowerCase();
  if (!email.endsWith(`@${STAFF_DOMAIN}`)) return null;
  if (email.length > 254 || email.indexOf("@") < 1) return null;
  return email;
}

export function isStaffRole(value: unknown): value is StaffRole {
  return value === "admin" || value === "staff" || value === "read_only";
}

/** Admin and staff roles may change departures and policies. read_only may not. */
export function canWrite(staff: StaffSession | null | undefined): boolean {
  return staff?.role === "admin" || staff?.role === "staff";
}

/** For logs: "w***@adventure-access.com". Logs never hold a full email. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
