import type { APIRoute } from "astro";
import { STAFF_DOMAIN } from "../../../lib/auth/staff";
import { allowRequest, callerAddress } from "../../../lib/rate-limit";
import { createSessionClient } from "../../../lib/supabase/session";

/** Starts Google sign-in. POST only, so a link cannot trigger it. */
export const POST: APIRoute = async ({ request, cookies, url, redirect, clientAddress }) => {
  if (!(await allowRequest("staff_sign_in", callerAddress({ clientAddress })))) {
    return redirect("/admin/login?error=busy");
  }
  const supabase = createSessionClient(request, cookies);
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${url.origin}/admin/auth/callback`,
      // `hd` only asks Google to show company accounts. It is a hint, not a
      // check; the callback and the staff table do the real checking.
      queryParams: { hd: STAFF_DOMAIN, prompt: "select_account" },
    },
  });
  if (error || !data.url) return redirect("/admin/login?error=start");
  return redirect(data.url);
};
