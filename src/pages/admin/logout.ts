import type { APIRoute } from "astro";
import { createSessionClient } from "../../lib/supabase/session";

/** Signs out. POST only, so a link or image on another site cannot do it. */
export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  await createSessionClient(request, cookies).auth.signOut();
  return redirect("/admin/login?signed_out=1");
};
