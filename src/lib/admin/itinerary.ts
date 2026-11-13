import type { StaffSession } from "../auth/staff";
import type { ItineraryRow, RosterBooking } from "../db-types";
import { MAX_ITEMS, readItinerary, type ItineraryItem } from "../itinerary/items";
import { createServiceClient } from "../supabase/service";
import { logActivity } from "./db";

/**
 * A departure's itinerary and roster, for the admin. Service role, after
 * the action or page has checked the staff role.
 */

/** Logs the database error code only. Messages can contain row values. */
function logDbError(where: string, error: { code?: string } | null): void {
  console.error(`[admin] ${where} failed`, { code: error?.code ?? "unknown" });
}

const COLUMNS = "id, departure_id, position, kind, day_label, title, body_md, image_url";

export async function listItinerary(departureId: string): Promise<ItineraryRow[]> {
  const { data, error } = await createServiceClient()
    .from("itinerary_items")
    .select(COLUMNS)
    .eq("departure_id", departureId)
    .order("position")
    .order("created_at");
  if (error) logDbError("listItinerary", error);
  return (data ?? []) as ItineraryRow[];
}

export type ItineraryResult = { ok: true } | { ok: false; message: string };
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** Adds an item at the end, or updates one. */
export async function saveItineraryItem(
  departureId: string,
  itemId: string | null,
  item: ItineraryItem,
  staff: StaffSession,
): Promise<ItineraryResult> {
  const db = createServiceClient();
  if (itemId) {
    const { data, error } = await db
      .from("itinerary_items")
      .update(item)
      .eq("id", itemId)
      .eq("departure_id", departureId)
      .select("id")
      .maybeSingle();
    if (error || !data) {
      logDbError("saveItineraryItem.update", error);
      return fail("Could not save that item. It may have been removed. Reload and try again.");
    }
  } else {
    const existing = await listItinerary(departureId);
    if (existing.length >= MAX_ITEMS) return fail(`An itinerary holds at most ${MAX_ITEMS} items.`);
    const position = existing.reduce((max, row) => Math.max(max, row.position), 0) + 1;
    const { error } = await db
      .from("itinerary_items")
      .insert({ ...item, departure_id: departureId, position });
    if (error) {
      logDbError("saveItineraryItem.insert", error);
      return fail("Could not add that item. Try again.");
    }
  }
  await logActivity(staff, "departure", departureId, itemId ? "edit_itinerary_item" : "add_itinerary_item", {
    title: item.title,
  });
  return { ok: true };
}

export async function deleteItineraryItem(
  departureId: string,
  itemId: string,
  staff: StaffSession,
): Promise<ItineraryResult> {
  const { data, error } = await createServiceClient()
    .from("itinerary_items")
    .delete()
    .eq("id", itemId)
    .eq("departure_id", departureId)
    .select("title")
    .maybeSingle();
  if (error || !data) {
    logDbError("deleteItineraryItem", error);
    return fail("Could not remove that item. It may already be gone.");
  }
  await logActivity(staff, "departure", departureId, "delete_itinerary_item", { title: data.title });
  return { ok: true };
}

/** Moves an item one place up or down by swapping positions with its neighbor. */
export async function moveItineraryItem(
  departureId: string,
  itemId: string,
  direction: "up" | "down",
): Promise<ItineraryResult> {
  const rows = await listItinerary(departureId);
  const index = rows.findIndex((row) => row.id === itemId);
  const other = direction === "up" ? index - 1 : index + 1;
  const current = rows[index];
  const neighbor = rows[other];
  if (!current || !neighbor) return { ok: true }; // already first or last

  // Renumber the whole list while swapping, so positions stay 1, 2, 3...
  const order = [...rows];
  order[index] = neighbor;
  order[other] = current;
  const db = createServiceClient();
  for (const [i, row] of order.entries()) {
    if (row.position === i + 1) continue;
    const { error } = await db.from("itinerary_items").update({ position: i + 1 }).eq("id", row.id);
    if (error) {
      logDbError("moveItineraryItem", error);
      return fail("Could not reorder the itinerary. Reload and try again.");
    }
  }
  return { ok: true };
}

async function replaceItinerary(departureId: string, items: ItineraryItem[]): Promise<number | null> {
  const { data, error } = await createServiceClient().rpc("replace_itinerary", {
    p_departure_id: departureId,
    p_items: items,
  });
  if (error) {
    logDbError("replaceItinerary", error);
    return null;
  }
  return typeof data === "number" ? data : 0;
}

/** The tour's template itinerary for a departure, read leniently. */
export async function getTourTemplate(departureId: string): Promise<ItineraryItem[]> {
  const { data, error } = await createServiceClient()
    .from("departures")
    .select("trips ( itinerary )")
    .eq("id", departureId)
    .maybeSingle();
  if (error) logDbError("getTourTemplate", error);
  const trip = (data as { trips: { itinerary: unknown } | null } | null)?.trips;
  return readItinerary(trip?.itinerary);
}

/** Replaces the departure's itinerary with its tour's template. */
export async function copyItineraryFromTour(
  departureId: string,
  staff: StaffSession,
): Promise<ItineraryResult> {
  const template = await getTourTemplate(departureId);
  if (template.length === 0) return fail("This tour has no itinerary in the library yet.");
  const copied = await replaceItinerary(departureId, template);
  if (copied === null) return fail("Could not copy the itinerary. Nothing was changed.");
  await logActivity(staff, "departure", departureId, "copy_itinerary", { from: "tour", items: copied });
  return { ok: true };
}

/** Replaces the departure's itinerary with a copy of another departure's. */
export async function copyItineraryFromDeparture(
  departureId: string,
  sourceId: string,
  staff: StaffSession,
): Promise<ItineraryResult> {
  if (sourceId === departureId) return fail("Choose a different departure to copy from.");
  const source = await listItinerary(sourceId);
  if (source.length === 0) return fail("That departure has no itinerary to copy.");
  const items = source.map(({ kind, day_label, title, body_md, image_url }) => ({
    kind,
    day_label,
    title,
    body_md,
    image_url,
  }));
  const copied = await replaceItinerary(departureId, items);
  if (copied === null) return fail("Could not copy the itinerary. Nothing was changed.");
  await logActivity(staff, "departure", departureId, "copy_itinerary", {
    from: sourceId,
    items: copied,
  });
  return { ok: true };
}

/** How many itinerary items each departure has, for the copy list. */
export async function countItineraries(): Promise<Map<string, number>> {
  const { data, error } = await createServiceClient().from("itinerary_items").select("departure_id");
  if (error) logDbError("countItineraries", error);
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as { departure_id: string }[]) {
    counts.set(row.departure_id, (counts.get(row.departure_id) ?? 0) + 1);
  }
  return counts;
}

/** Everyone registered on a departure, oldest registration first. */
export async function listRoster(departureId: string): Promise<RosterBooking[]> {
  const { data, error } = await createServiceClient()
    .from("bookings")
    .select(
      `id, reference, status, traveler_count, total_cents, discount_cents, paid_cents,
       needs_attention, created_at,
       travelers!travelers_booking_id_fkey ( id, first_name, last_name, email, is_lead )`,
    )
    .eq("departure_id", departureId)
    .order("created_at");
  if (error) logDbError("listRoster", error);
  return (data ?? []) as unknown as RosterBooking[];
}
