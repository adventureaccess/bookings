/**
 * Baseline security headers. The middleware sets them on every server-rendered
 * response; netlify.toml repeats them for static files, which never pass
 * through the middleware. A test keeps the two in step.
 *
 * The full Content-Security-Policy lands in milestone 6, once Stripe and
 * Turnstile are in place.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
