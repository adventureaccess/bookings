import { defineMiddleware, sequence } from "astro:middleware";
import { resolveStaff } from "./lib/auth/resolve";
import { SECURITY_HEADERS } from "./lib/security-headers";

const securityHeaders = defineMiddleware(async (_context, next) => {
  const response = await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    // The dev server's own tooling injects inline script, which the policy
    // forbids. Every built site gets the policy.
    if (name === "Content-Security-Policy" && import.meta.env.DEV) continue;
    response.headers.set(name, value);
  }
  return response;
});

/** Admin routes that must work without a session: the sign-in flow itself. */
function isOpenAdminPath(path: string): boolean {
  return path === "/admin/login" || path.startsWith("/admin/auth/");
}

/**
 * The staff gate. Every /admin page requires a signed-in staff member.
 * Actions are reachable at /_actions/* as well as through their pages, so the
 * staff member is resolved for those too and each action checks the role.
 */
const staffGate = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  const isAdmin = path === "/admin" || path.startsWith("/admin/");
  const isAction = path.startsWith("/_actions/");
  context.locals.staff = null;

  if (!isAdmin && !isAction) return next();

  context.locals.staff = await resolveStaff(context);
  if (isAdmin && !isOpenAdminPath(path) && !context.locals.staff) {
    return context.redirect("/admin/login");
  }

  const response = await next();
  // Admin pages show bookings and staff data. Never cache them anywhere.
  response.headers.set("Cache-Control", "no-store");
  return response;
});

export const onRequest = sequence(securityHeaders, staffGate);
