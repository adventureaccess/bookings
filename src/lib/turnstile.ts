/**
 * Cloudflare Turnstile: the check on the registration form that the visitor
 * is a person. The browser gets a token from Cloudflare's widget; this asks
 * Cloudflare whether the token is genuine. Pure apart from the network call,
 * which is passed in for testing.
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The form field Cloudflare's widget adds. */
export const TURNSTILE_FIELD = "cf-turnstile-response";

/**
 * True when Cloudflare confirms the token. A missing token, a refusal, a
 * network failure or an unreadable answer are all false: when in doubt, the
 * form is not accepted.
 */
export async function verifyTurnstile(
  token: string,
  secret: string,
  address: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (token === "" || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (address) body.set("remoteip", address);
    const response = await fetchImpl(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: unknown };
    return result.success === true;
  } catch {
    return false;
  }
}
