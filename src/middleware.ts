import { defineMiddleware } from "astro:middleware";
import { SECURITY_HEADERS } from "./lib/security-headers";

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
});
