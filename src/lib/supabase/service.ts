import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env";

/**
 * Service-role client. It bypasses row-level security, so it is allowed in
 * exactly four places: the Stripe webhook, cron routes, the booking
 * transaction, and admin actions after a server-side role check.
 */
export function createServiceClient(): SupabaseClient {
  return createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
