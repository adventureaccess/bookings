import "server-only";
import { parseEnv, siteUrl } from "./env.schema";

/** Validated environment. Server code only; never import from a client component. */
export const env = parseEnv(process.env);

// next.config.ts bakes SITE_URL in at build time; the fallback covers tests.
export const SITE_URL = process.env.SITE_URL ?? siteUrl(process.env);
