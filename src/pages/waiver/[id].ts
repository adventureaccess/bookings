import type { APIRoute } from "astro";
import { getWaiverFile } from "../../lib/documents/db";

/**
 * Shows a published waiver's PDF, so a traveler can read it before signing.
 * The waiver is the company's own document, not personal data. Drafts and
 * unknown IDs are not found.
 */

export const prerender = false;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: APIRoute = async ({ params }) => {
  const id = params.id ?? "";
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });

  const file = await getWaiverFile(id);
  if (!file) return new Response("Not found", { status: 404 });

  // Only letters, digits, dot, dash and underscore reach the header.
  const safeName = file.fileName.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100) || "waiver.pdf";
  return new Response(file.bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Content-Length": String(file.bytes.length),
      // A published version never changes.
      "Cache-Control": "public, max-age=3600",
    },
  });
};
