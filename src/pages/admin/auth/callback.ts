import type { APIRoute } from "astro";
import { staffFromUser } from "../../../lib/auth/resolve";
import { createSessionClient } from "../../../lib/supabase/session";

/**
 * Google sends the visitor back here with a one-time code. Exchange it for a
 * session, then check the account is staff. Anyone else is signed straight
 * back out, so a non-staff Google account never keeps a session.
 */
export const GET: APIRoute = async ({ request, cookies, url, redirect }) => {
  const code = url.searchParams.get("code");
  if (!code || code.length > 2000) return redirect("/admin/login?error=callback");

  const supabase = createSessionClient(request, cookies);
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return redirect("/admin/login?error=callback");

  // Ask Supabase who just signed in, rather than trusting the token contents.
  const { data } = await supabase.auth.getUser();
  const staff = await staffFromUser(data.user);
  if (!staff) {
    await supabase.auth.signOut();
    return redirect("/admin/login?error=not_staff");
  }
  return redirect("/admin");
};
