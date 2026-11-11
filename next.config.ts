import type { NextConfig } from "next";
import { parseEnv, siteUrl } from "./src/lib/env.schema";

// Fail the build early if a required environment variable is missing.
parseEnv(process.env);

// Baseline headers. The full Content-Security-Policy lands in milestone 6,
// once Stripe and Turnstile are in place.
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  // Resolved at build time, where Netlify's deploy variables exist.
  env: { SITE_URL: siteUrl(process.env) },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
