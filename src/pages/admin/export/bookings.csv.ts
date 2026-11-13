import type { APIRoute } from "astro";
import { logActivity } from "../../../lib/admin/db";
import { EXPORT_HEADER, exportRows, toCsv } from "../../../lib/admin/export";
import { listBookingsForExport } from "../../../lib/admin/reports";

/**
 * The bookings export: one row per traveler, as CSV. Staff only: the
 * middleware has already required a signed-in staff member for anything
 * under /admin, and this checks again. Every export is written to the
 * activity log, because the file holds names, emails and phone numbers.
 */

export const prerender = false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: APIRoute = async ({ locals, url }) => {
  const staff = locals.staff;
  if (!staff) return new Response("Sign in first.", { status: 401 });

  const requested = url.searchParams.get("departure");
  if (requested !== null && !UUID.test(requested)) return new Response("Not found", { status: 404 });

  const bookings = await listBookingsForExport(requested);
  const rows = exportRows(bookings);
  await logActivity(staff, requested ? "departure" : "bookings", requested, "export_bookings", {
    bookings: bookings.length,
    travelers: rows.length,
  });

  const today = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(EXPORT_HEADER, rows), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="adventure-access-bookings-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
