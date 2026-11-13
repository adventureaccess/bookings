/**
 * Security headers. The middleware sets them on every server-rendered
 * response; netlify.toml repeats them for static files, which never pass
 * through the middleware. A test keeps the two in step.
 */

/**
 * The Content-Security-Policy. Everything the pages need comes from this
 * site itself, with four named exceptions:
 *
 *   script-src / frame-src  Cloudflare Turnstile's widget on the registration form
 *   img-src https:          tour and itinerary photos, which live on the website
 *   form-action             where a form post may be redirected: Stripe's payment
 *                           page, and Supabase then Google for staff sign-in
 *
 * There are no inline scripts or inline styles anywhere, so neither is
 * allowed. No page may be framed, by anyone.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self'",
  "img-src 'self' https: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  "form-action 'self' https://checkout.stripe.com https://*.supabase.co https://accounts.google.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
};
