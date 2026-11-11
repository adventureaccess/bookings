/**
 * The public base URL of this deploy, without a trailing slash.
 *
 * SITE_URL wins when set. Otherwise use Netlify's build variables: URL is the
 * site's main address, DEPLOY_PRIME_URL is the address of a Deploy Preview or
 * branch deploy. Locally it is the Astro dev server.
 */
export function siteUrl(source: Record<string, string | undefined>): string {
  const netlifyUrl =
    source.CONTEXT === "production" ? source.URL : source.DEPLOY_PRIME_URL;
  const url = source.SITE_URL || netlifyUrl || "http://localhost:4321";
  return url.replace(/\/$/, "");
}
