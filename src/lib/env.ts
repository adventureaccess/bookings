import "server-only";
import { parseEnv, siteUrl } from "./env.schema";

/** Validated environment. Server code only; never import from a client component. */
export const env = parseEnv(process.env);

export const SITE_URL = siteUrl(process.env);
