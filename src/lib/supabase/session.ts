import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AstroCookies } from "astro";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "astro:env/server";

/**
 * A Supabase client tied to the visitor's sign-in cookies. Used only for the
 * sign-in flow and to ask Supabase who the visitor is. Data access in the
 * admin goes through the service client, after the role check.
 */
export function createSessionClient(
  request: Request,
  cookies: AstroCookies,
): SupabaseClient {
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { flowType: "pkce" },
    cookies: {
      getAll() {
        return parseCookieHeader(request.headers.get("Cookie") ?? "").map(
          ({ name, value }) => ({ name, value: value ?? "" }),
        );
      },
      setAll(toSet) {
        for (const { name, value, options } of toSet) {
          cookies.set(name, value, {
            ...options,
            path: "/",
            httpOnly: true,
            sameSite: "lax",
            secure: import.meta.env.PROD,
          });
        }
      },
    },
  });
}
