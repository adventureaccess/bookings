import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "astro:env/server";

/**
 * Anonymous client for public reads. Row-level security applies: it sees
 * active trips, public open or full departures, and published policies.
 * Server code only; astro:env/server cannot be imported in the browser.
 */
export function createAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
