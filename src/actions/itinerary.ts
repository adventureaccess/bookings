import { defineAction } from "astro:actions";
import {
  copyItineraryFromDeparture,
  copyItineraryFromTour,
  deleteItineraryItem,
  moveItineraryItem,
  saveItineraryItem,
} from "../lib/admin/itinerary";
import { parseItemForm, type ItemFormErrors, type ItemFormValues } from "../lib/itinerary/items";
import { formText, formUuid, requireWriter, UUID } from "./guards";

/** Itinerary editor actions. Staff only; each checks the role itself. */

export type ItemActionResult =
  | { ok: true }
  | {
      ok: false;
      message?: string;
      /** The item being edited, or "" for the new-item form. */
      itemId: string;
      errors: ItemFormErrors;
      values: ItemFormValues;
    };

export type ItineraryActionResult = { ok: true } | { ok: false; message: string };

export const itineraryActions = {
  /** Adds an item, or saves changes to one. */
  saveItineraryItem: defineAction({
    accept: "form",
    handler: async (form, context): Promise<ItemActionResult> => {
      const staff = requireWriter(context);
      const departureId = formUuid(form, "departure_id");
      const rawItem = formText(form, "item_id", 40);
      const itemId = UUID.test(rawItem) ? rawItem : null;

      const parsed = parseItemForm(form);
      if (!parsed.ok) {
        return { ok: false, itemId: itemId ?? "", errors: parsed.errors, values: parsed.values };
      }
      const saved = await saveItineraryItem(departureId, itemId, parsed.data, staff);
      if (!saved.ok) {
        return {
          ok: false,
          message: saved.message,
          itemId: itemId ?? "",
          errors: {},
          values: {
            kind: parsed.data.kind,
            day_label: parsed.data.day_label,
            title: parsed.data.title,
            body_md: parsed.data.body_md,
            image_url: parsed.data.image_url ?? "",
          },
        };
      }
      return { ok: true };
    },
  }),

  deleteItineraryItem: defineAction({
    accept: "form",
    handler: async (form, context): Promise<ItineraryActionResult> => {
      const staff = requireWriter(context);
      return deleteItineraryItem(formUuid(form, "departure_id"), formUuid(form, "item_id"), staff);
    },
  }),

  moveItineraryItem: defineAction({
    accept: "form",
    handler: async (form, context): Promise<ItineraryActionResult> => {
      requireWriter(context);
      const direction = formText(form, "direction", 10) === "up" ? "up" : "down";
      return moveItineraryItem(formUuid(form, "departure_id"), formUuid(form, "item_id"), direction);
    },
  }),

  /** Replaces the whole itinerary with the tour's template or another departure's. */
  copyItinerary: defineAction({
    accept: "form",
    handler: async (form, context): Promise<ItineraryActionResult> => {
      const staff = requireWriter(context);
      const departureId = formUuid(form, "departure_id");
      const source = formText(form, "source", 40);
      if (source === "tour") return copyItineraryFromTour(departureId, staff);
      if (UUID.test(source)) return copyItineraryFromDeparture(departureId, source, staff);
      return { ok: false, message: "Choose where to copy the itinerary from." };
    },
  }),
};
