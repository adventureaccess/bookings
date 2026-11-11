import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "astro:env/server";

/**
 * Service-role client. It bypasses row-level security, so it is allowed in
 * exactly four places: the Stripe webhook, cron routes, the booking
 * transaction, and admin actions after a server-side role check.
 * Server code only; astro:env/server cannot be imported in the browser.
 */
export function createServiceClient(): SupabaseClient {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
