import { defineConfig, envField } from "astro/config";
import netlify from "@astrojs/netlify";
import tailwindcss from "@tailwindcss/vite";
import { siteUrl } from "./src/lib/site-url";

const secret = { context: "server", access: "secret" } as const;
const serverPublic = { context: "server", access: "public" } as const;

// https://astro.build/config
export default defineConfig({
  // Resolved at build time, where Netlify's deploy variables exist.
  site: siteUrl(process.env),
  // Every page renders on the server unless it opts into prerendering.
  // Seat counts and booking pages must never be served stale.
  output: "server",
  adapter: netlify(),
  vite: { plugins: [tailwindcss()] },
  security: { checkOrigin: true },
  env: {
    // Fail the build and server start when a required name is missing.
    validateSecrets: true,
    /**
     * Every environment variable the app reads. All of them are server-only:
     * nothing is exposed to the browser, so no name starts with PUBLIC_.
     * Optional names become required in the milestone that first uses them.
     */
    schema: {
      SUPABASE_URL: envField.string({ ...serverPublic, url: true }),
      // The anon key is safe to publish; row-level security protects the data.
      SUPABASE_ANON_KEY: envField.string({ ...serverPublic }),
      // Milestone 2
      SUPABASE_SERVICE_ROLE_KEY: envField.string({ ...secret, optional: true }),
      // Milestone 3
      TOKEN_SIGNING_SECRET: envField.string({ ...secret, optional: true }),
      // Milestone 4
      STRIPE_SECRET_KEY: envField.string({ ...secret, optional: true }),
      STRIPE_WEBHOOK_SECRET: envField.string({ ...secret, optional: true }),
      CRON_SECRET: envField.string({ ...secret, optional: true }),
      // Milestone 5
      HUBSPOT_ACCESS_TOKEN: envField.string({ ...secret, optional: true }),
      RESEND_API_KEY: envField.string({ ...secret, optional: true }),
      // Milestone 6
      TURNSTILE_SITE_KEY: envField.string({ ...serverPublic, optional: true }),
      TURNSTILE_SECRET_KEY: envField.string({ ...secret, optional: true }),
    },
  },
});
