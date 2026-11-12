import { describe, expect, it } from "vitest";
import { planTripSync, tripFeedSchema, type ExistingTrip } from "./feed";

const ladakh: ExistingTrip = {
  slug: "ladakh-multisport",
  title: "Ladakh Multisport",
  destination: "ladakh",
  hero_image_url: "https://adventure-access.com/images/ladakh.jpg",
  active: true,
};
const ladakhFeed = {
  slug: "ladakh-multisport",
  title: "Ladakh Multisport",
  destination: "ladakh",
  heroImage: "https://adventure-access.com/images/ladakh.jpg",
};

describe("tripFeedSchema", () => {
  it("accepts the documented shape", () => {
    expect(tripFeedSchema.safeParse({ trips: [ladakhFeed] }).success).toBe(true);
  });

  it("allows a missing hero image", () => {
    const { heroImage: _none, ...rest } = ladakhFeed;
    void _none;
    expect(tripFeedSchema.safeParse({ trips: [rest] }).success).toBe(true);
  });

  it("rejects relative or non-https image URLs, bad slugs and other shapes", () => {
    const bad = [
      { trips: [{ ...ladakhFeed, heroImage: "/images/ladakh.jpg" }] },
      { trips: [{ ...ladakhFeed, heroImage: "http://example.com/a.jpg" }] },
      { trips: [{ ...ladakhFeed, slug: "Ladakh Multisport" }] },
      { trips: [{ ...ladakhFeed, title: "" }] },
      { trips: "nope" },
      [],
    ];
    for (const value of bad) {
      expect(tripFeedSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("planTripSync", () => {
  it("adds a trip that is new", () => {
    const plan = planTripSync([], [ladakhFeed]);
    expect(plan.added).toBe(1);
    expect(plan.upserts).toEqual([ladakh]);
    expect(plan.deactivate).toEqual([]);
  });

  it("leaves an identical trip alone", () => {
    const plan = planTripSync([ladakh], [ladakhFeed]);
    expect(plan).toMatchObject({ added: 0, updated: 0, unchanged: 1, upserts: [] });
  });

  it("updates a trip whose title, destination or image changed", () => {
    const plan = planTripSync([ladakh], [{ ...ladakhFeed, title: "Ladakh Multi-Sport" }]);
    expect(plan.updated).toBe(1);
    expect(plan.upserts[0]?.title).toBe("Ladakh Multi-Sport");
  });

  it("switches off a trip that left the feed, without deleting it", () => {
    const plan = planTripSync([ladakh], []);
    expect(plan.deactivate).toEqual(["ladakh-multisport"]);
    expect(plan.upserts).toEqual([]);
  });

  it("switches a returning trip back on", () => {
    const plan = planTripSync([{ ...ladakh, active: false }], [ladakhFeed]);
    expect(plan.updated).toBe(1);
    expect(plan.upserts[0]?.active).toBe(true);
  });

  it("does not deactivate a trip that is already off", () => {
    expect(planTripSync([{ ...ladakh, active: false }], []).deactivate).toEqual([]);
  });

  it("carries a tour's itinerary when the feed has one, and leaves it alone when it does not", () => {
    const itinerary = [
      { kind: "day" as const, day_label: "Day 1", title: "Arrive", body_md: "", image_url: null },
    ];
    const stored = { ...ladakh, itinerary };

    const withNew = planTripSync([ladakh], [{ ...ladakhFeed, itinerary }]);
    expect(withNew.updated).toBe(1);
    expect(withNew.upserts[0]?.itinerary).toEqual(itinerary);

    const same = planTripSync([stored], [{ ...ladakhFeed, itinerary }]);
    expect(same.unchanged).toBe(1);

    const absent = planTripSync([stored], [ladakhFeed]);
    expect(absent.unchanged).toBe(1);
    expect(absent.upserts).toHaveLength(0);
  });

  it("checks itinerary items in the feed", () => {
    const trip = { slug: "ladakh-multisport", title: "Ladakh Multisport", destination: "ladakh" };
    expect(
      tripFeedSchema.safeParse({
        trips: [{ ...trip, itinerary: [{ kind: "day", day_label: "Day 1", title: "Arrive", body_md: "", image_url: null }] }],
      }).success,
    ).toBe(true);
    expect(
      tripFeedSchema.safeParse({
        trips: [{ ...trip, itinerary: [{ kind: "day", day_label: "", title: "", body_md: "", image_url: null }] }],
      }).success,
    ).toBe(false);
    expect(
      tripFeedSchema.safeParse({
        trips: [{ ...trip, itinerary: [{ kind: "day", day_label: "", title: "x", body_md: "", image_url: "/relative.jpg" }] }],
      }).success,
    ).toBe(false);
  });

  it("ignores a repeated slug in the feed", () => {
    const plan = planTripSync([], [ladakhFeed, { ...ladakhFeed, title: "Copy" }]);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]?.title).toBe("Ladakh Multisport");
  });
});
