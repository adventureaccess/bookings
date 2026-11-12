import { z } from "astro/zod";

/**
 * Itinerary items: a highlight or a day (or run of days) on a departure.
 * The same shape is used for a tour's template, for what staff type into the
 * editor, and for what the group's page shows.
 */

export const ITEM_KINDS = ["day", "highlight"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const MAX_ITEMS = 60;
const MAX_BODY = 8000;

export interface ItineraryItem {
  kind: ItemKind;
  /** "Day 1", "Days 3–5". Empty for a highlight. */
  day_label: string;
  title: string;
  /** Plain text with a little Markdown, like policy text. */
  body_md: string;
  /** Absolute https URL, or null. */
  image_url: string | null;
}

export const itineraryItemSchema = z.object({
  kind: z.enum(ITEM_KINDS),
  day_label: z.string().trim().max(40),
  title: z.string().trim().min(1).max(200),
  body_md: z.string().trim().max(MAX_BODY),
  image_url: z
    .string()
    .trim()
    .max(500)
    .regex(/^https:\/\//)
    .nullable(),
});

/** Stored or fed itinerary data, read leniently: anything malformed is skipped. */
export function readItinerary(raw: unknown): ItineraryItem[] {
  if (!Array.isArray(raw)) return [];
  const items: ItineraryItem[] = [];
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const parsed = itineraryItemSchema.safeParse({
      kind: record.kind ?? "day",
      day_label: record.day_label ?? "",
      title: record.title,
      body_md: record.body_md ?? "",
      image_url: record.image_url || null,
    });
    if (parsed.success) items.push(parsed.data);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export const ITEM_FIELDS = ["kind", "day_label", "title", "body_md", "image_url"] as const;
export type ItemField = (typeof ITEM_FIELDS)[number];
export type ItemFormValues = Record<ItemField, string>;
export type ItemFormErrors = Partial<Record<ItemField, string>>;

export type ItemFormResult =
  | { ok: true; data: ItineraryItem }
  | { ok: false; errors: ItemFormErrors; values: ItemFormValues };

/** One item from the admin editor. */
export function parseItemForm(form: FormData): ItemFormResult {
  const values = {} as ItemFormValues;
  for (const field of ITEM_FIELDS) {
    const raw = form.get(field);
    values[field] = typeof raw === "string" ? raw.trim().slice(0, MAX_BODY + 1) : "";
  }
  const errors: ItemFormErrors = {};

  const kind = ITEM_KINDS.find((k) => k === values.kind);
  if (!kind) errors.kind = "Choose day or highlight.";
  if (values.title === "") errors.title = "Enter a title.";
  else if (values.title.length > 200) errors.title = "Keep the title under 200 characters.";
  if (values.day_label.length > 40) errors.day_label = "Keep this under 40 characters.";
  if (values.body_md.length > MAX_BODY) {
    errors.body_md = `Keep the text under ${MAX_BODY.toLocaleString("en-US")} characters.`;
  }
  if (values.image_url !== "" && !/^https:\/\/\S+$/.test(values.image_url)) {
    errors.image_url = "Enter a full address starting with https://, or leave it blank.";
  } else if (values.image_url.length > 500) {
    errors.image_url = "That address is too long.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, values };
  return {
    ok: true,
    data: {
      kind: kind as ItemKind,
      day_label: kind === "highlight" ? "" : values.day_label,
      title: values.title,
      body_md: values.body_md,
      image_url: values.image_url || null,
    },
  };
}

/** The website's own shape for a tour (src/content/trips/*.json), as far as this app reads it. */
interface WebsiteTrip {
  highlights?: unknown;
  chapters?: { groups?: unknown };
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function absoluteImage(src: unknown, siteOrigin: string): string | null {
  const path = text(src);
  if (path === "") return null;
  if (/^https:\/\//.test(path)) return path;
  return path.startsWith("/") ? `${siteOrigin}${path}` : null;
}

/**
 * Turns a website tour file into a template itinerary: each chapter becomes
 * a "day" item ("Days 1–2", its prose, then one line per day), each highlight
 * a "highlight" item. Used by the feed and by the local import script.
 */
export function itineraryFromWebsiteTrip(trip: WebsiteTrip, siteOrigin: string): ItineraryItem[] {
  const items: unknown[] = [];
  const groups = Array.isArray(trip.chapters?.groups) ? (trip.chapters.groups as unknown[]) : [];
  for (const entry of groups) {
    if (!entry || typeof entry !== "object") continue;
    const group = entry as Record<string, unknown>;
    const start = Number(group.dayStart);
    const end = Number(group.dayEnd);
    const label =
      Number.isInteger(start) && Number.isInteger(end)
        ? start === end
          ? `Day ${start}`
          : `Days ${start}–${end}`
        : "";
    const prose = Array.isArray(group.prose) ? group.prose.map(text).filter(Boolean) : [];
    const days = Array.isArray(group.days)
      ? (group.days as unknown[])
          .map((day) => {
            const d = (day ?? {}) as Record<string, unknown>;
            const line = [text(d.label), text(d.text)].filter(Boolean).join(": ");
            return line ? `- ${line}` : "";
          })
          .filter(Boolean)
      : [];
    const image = (group.image ?? {}) as Record<string, unknown>;
    items.push({
      kind: "day",
      day_label: label,
      title: text(group.title),
      body_md: [prose.join("\n\n"), days.join("\n")].filter(Boolean).join("\n\n"),
      image_url: absoluteImage(image.src, siteOrigin),
    });
  }

  const highlights = Array.isArray(trip.highlights) ? (trip.highlights as unknown[]) : [];
  for (const entry of highlights) {
    if (!entry || typeof entry !== "object") continue;
    const highlight = entry as Record<string, unknown>;
    const where = text(highlight.where);
    items.push({
      kind: "highlight",
      day_label: "",
      title: [text(highlight.title), where].filter(Boolean).join(", "),
      body_md: text(highlight.body),
      image_url: absoluteImage(highlight.image, siteOrigin),
    });
  }
  return readItinerary(items);
}
