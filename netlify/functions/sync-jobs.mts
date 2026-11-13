// Scheduled function: every five minutes, asks the app to work through the
// sync queue (HubSpot updates and emails). The work happens in the app's own
// route, behind the shared secret; this file only knocks on the door.
//
// Needs CRON_SECRET in the site's environment variables. URL is set by
// Netlify to the site's main address.

export default async function syncJobs(): Promise<Response> {
  const site = process.env.URL;
  const secret = process.env.CRON_SECRET;
  if (!site || !secret) {
    console.error("[sync-jobs] URL or CRON_SECRET is not set");
    return new Response("not configured", { status: 500 });
  }

  const response = await fetch(`${site}/api/cron/sync`, {
    method: "POST",
    headers: { "x-cron-secret": secret },
  });
  console.log("[sync-jobs] status", response.status);
  return new Response(null, { status: response.ok ? 200 : 500 });
}

export const config = { schedule: "*/5 * * * *" };
