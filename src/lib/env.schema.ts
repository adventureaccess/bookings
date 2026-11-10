import { z } from "zod";

/**
 * Every environment variable the app reads, by name.
 *
 * Names in `requiredNow` fail the build when missing. Names in `comingLater`
 * are optional until the milestone that first uses them, then move up.
 * Only three names are public: the Supabase URL, the Supabase anon key and
 * the Turnstile site key. Nothing secret is ever prefixed NEXT_PUBLIC_.
 */
const value = z.string().trim().min(1).max(2000);

const requiredNow = {
  NEXT_PUBLIC_SUPABASE_URL: z.url().max(2000),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: value,
  SUPABASE_SERVICE_ROLE_KEY: value,
};

const comingLater = {
  // Falls back to the Vercel deployment URL, then localhost. See siteUrl().
  SITE_URL: z.url().max(2000).optional(),
  // Milestone 3
  TOKEN_SIGNING_SECRET: value.optional(),
  // Milestone 4
  STRIPE_SECRET_KEY: value.optional(),
  STRIPE_WEBHOOK_SECRET: value.optional(),
  CRON_SECRET: value.optional(),
  // Milestone 5
  HUBSPOT_ACCESS_TOKEN: value.optional(),
  RESEND_API_KEY: value.optional(),
  // Milestone 6
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: value.optional(),
  TURNSTILE_SECRET_KEY: value.optional(),
};

export const envSchema = z.object({ ...requiredNow, ...comingLater });

export type Env = z.infer<typeof envSchema>;

export const ENV_NAMES = Object.keys(envSchema.shape) as (keyof Env)[];

/** Parses the environment. The error lists names only, never values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // Treat empty strings as missing, so a blank line in .env does not pass.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((i) => String(i.path[0])))];
    throw new Error(
      `Missing or invalid environment variables: ${names.join(", ")}. ` +
        "See .env.example for the full list.",
    );
  }
  return result.data;
}

export function siteUrl(source: Record<string, string | undefined>): string {
  if (source.SITE_URL) return source.SITE_URL.replace(/\/$/, "");
  if (source.VERCEL_URL) return `https://${source.VERCEL_URL}`;
  return "http://localhost:3000";
}
