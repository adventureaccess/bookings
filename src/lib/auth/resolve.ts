import type { APIContext } from "astro";
import { createServiceClient } from "../supabase/service";
import { createSessionClient } from "../supabase/session";
import {
  eligibleStaffEmail,
  isStaffRole,
  type AuthUserLike,
  type StaffSession,
} from "./staff";

/** Looks an email up in the staff table. The service client bypasses RLS. */
async function lookUpStaff(email: string): Promise<StaffSession | null> {
  const { data, error } = await createServiceClient()
    .from("staff")
    .select("email, role")
    .eq("email", email)
    .maybeSingle();
  if (error || !data || !isStaffRole(data.role)) return null;
  return { email: data.email, role: data.role };
}

/** The staff record for a Supabase user that Supabase has just verified. */
export async function staffFromUser(
  user: AuthUserLike | null | undefined,
): Promise<StaffSession | null> {
  const email = eligibleStaffEmail(user);
  return email ? lookUpStaff(email) : null;
}

/**
 * The staff member making this request, or null.
 *
 * getUser() asks Supabase to verify the session; it does not trust the cookie
 * contents. The email must then pass eligibleStaffEmail and be in the staff
 * table.
 */
export async function resolveStaff(
  context: Pick<APIContext, "request" | "cookies">,
): Promise<StaffSession | null> {
  // Local development only. `import.meta.env.DEV` is false in every build, so
  // this branch is removed from deployed code; scripts/check-build.mjs fails
  // CI if it ever survives. The email must still be in the staff table.
  if (import.meta.env.DEV) {
    const devEmail = import.meta.env.DEV_STAFF_EMAIL;
    if (typeof devEmail === "string" && devEmail.trim() !== "") {
      return lookUpStaff(devEmail.trim().toLowerCase());
    }
  }

  const supabase = createSessionClient(context.request, context.cookies);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return staffFromUser(data.user);
}
