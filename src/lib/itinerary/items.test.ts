import { describe, expect, it } from "vitest";
import { itineraryFromWebsiteTrip, parseItemForm, readItinerary } from "./items";

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields: Record<string, string> = {
    kind: "day",
    day_label: "Days 1–2",
    title: "  Nimmu: a soft landing ",
    body_md: "Settle in.\n\n- Day 1: Fly to Leh.",
    image_url: "https://adventure-access.com/images/nimmu.jpg",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function errorsOf(overrides: Record<string, string>) {
  const result = parseItemForm(form(overrides));
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

describe("parseItemForm", () => {
  it("reads a day", () => {
    expect(parseItemForm(form())).toEqual({
      ok: true,
      data: {
        kind: "day",
        day_label: "Days 1–2",
        title: "Nimmu: a soft landing",
        body_md: "Settle in.\n\n- Day 1: Fly to Leh.",
        image_url: "https://adventure-access.com/images/nimmu.jpg",
      },
    });
  });

  it("drops the day label on a highlight and allows no image or text", () => {
    const result = parseItemForm(form({ kind: "highlight", image_url: "", body_md: "" }));
    expect(result.ok && result.data).toMatchObject({
      kind: "highlight",
      day_label: "",
      image_url: null,
      body_md: "",
    });
  });

  it("needs a title and a known kind", () => {
    expect(errorsOf({ title: "  " }).title).toBe("Enter a title.");
    expect(errorsOf({ kind: "note" }).kind).toBeDefined();
  });

  it("only takes full https image addresses", () => {
    for (const bad of ["/images/a.jpg", "http://example.com/a.jpg", "javascript:alert(1)", "https://a b"]) {
      expect(errorsOf({ image_url: bad }).image_url).toMatch(/https/);
    }
  });

  it("caps every field", () => {
    expect(errorsOf({ title: "x".repeat(201) }).title).toMatch(/under 200/);
    expect(errorsOf({ day_label: "x".repeat(41) }).day_label).toBeDefined();
    expect(errorsOf({ body_md: "x".repeat(8001) }).body_md).toMatch(/8,000/);
  });

  it("returns what was typed with the errors", () => {
    const result = parseItemForm(form({ title: "" }));
    expect(!result.ok && result.values.body_md).toBe("Settle in.\n\n- Day 1: Fly to Leh.");
  });
});

describe("readItinerary", () => {
  it("keeps well-formed items and skips the rest", () => {
    expect(
      readItinerary([
        { kind: "day", day_label: "Day 1", title: "Arrive", body_md: "Text", image_url: null },
        { title: "No kind defaults to a day" },
        { kind: "day", title: "" },
        { kind: "day", title: "Bad image", image_url: "/relative.jpg" },
        "nope",
        null,
      ]),
    ).toEqual([
      { kind: "day", day_label: "Day 1", title: "Arrive", body_md: "Text", image_url: null },
      { kind: "day", day_label: "", title: "No kind defaults to a day", body_md: "", image_url: null },
    ]);
    expect(readItinerary(null)).toEqual([]);
    expect(readItinerary({})).toEqual([]);
  });

  it("stops at 60 items", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ title: `Day ${i + 1}` }));
    expect(readItinerary(many)).toHaveLength(60);
  });
});

describe("itineraryFromWebsiteTrip", () => {
  const trip = {
    chapters: {
      groups: [
        {
          dayStart: 1,
          dayEnd: 2,
          title: "Nimmu — A Soft Landing",
          image: { src: "/images/2026/11/trips/day-2.jpg", alt: "x" },
          prose: ["First paragraph.", "Second paragraph."],
          days: [
            { label: "Day 1", text: "Fly Delhi to Leh." },
            { label: "Day 2", text: "Ride above Lamayuru." },
          ],
        },
        { dayStart: 3, dayEnd: 3, title: "Zangla", prose: [], days: [] },
      ],
    },
    highlights: [
      { where: "Zangla", title: "Khar Kongma Palace", body: "A palace above the village.", image: "/images/palace.jpg" },
    ],
  };

  it("turns chapters into days and highlights into highlights, with absolute images", () => {
    expect(itineraryFromWebsiteTrip(trip, "https://adventure-access.com")).toEqual([
      {
        kind: "day",
        day_label: "Days 1–2",
        title: "Nimmu — A Soft Landing",
        body_md:
          "First paragraph.\n\nSecond paragraph.\n\n- Day 1: Fly Delhi to Leh.\n- Day 2: Ride above Lamayuru.",
        image_url: "https://adventure-access.com/images/2026/11/trips/day-2.jpg",
      },
      { kind: "day", day_label: "Day 3", title: "Zangla", body_md: "", image_url: null },
      {
        kind: "highlight",
        day_label: "",
        title: "Khar Kongma Palace, Zangla",
        body_md: "A palace above the village.",
        image_url: "https://adventure-access.com/images/palace.jpg",
      },
    ]);
  });

  it("copes with a tour that has no itinerary", () => {
    expect(itineraryFromWebsiteTrip({}, "https://adventure-access.com")).toEqual([]);
    expect(itineraryFromWebsiteTrip({ chapters: {}, highlights: "x" }, "https://x.example")).toEqual([]);
  });
});
