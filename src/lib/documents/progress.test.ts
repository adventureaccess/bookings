import { describe, expect, it } from "vitest";
import type { BookingDocuments } from "./db";
import {
  documentProgress,
  latestUpload,
  progressLabel,
  requiredKinds,
  staffProgress,
  type UploadRow,
} from "./progress";

const upload = (traveler: string, kind: UploadRow["kind"], status: UploadRow["status"], at: string): UploadRow => ({
  traveler_id: traveler,
  kind,
  status,
  created_at: at,
});

describe("requiredKinds", () => {
  it("reads the stored list and ignores anything unknown", () => {
    expect(requiredKinds(["passport", "insurance", "visa"])).toEqual(["insurance", "passport"]);
    expect(requiredKinds([])).toEqual([]);
    expect(requiredKinds(null)).toEqual([]);
    expect(requiredKinds("passport")).toEqual([]);
  });
});

describe("latestUpload", () => {
  it("picks the newest upload of that kind for that traveler", () => {
    const uploads = [
      upload("a", "passport", "rejected", "2026-11-01T10:00:00Z"),
      upload("a", "passport", "submitted", "2026-11-03T10:00:00Z"),
      upload("a", "insurance", "accepted", "2026-11-05T10:00:00Z"),
      upload("b", "passport", "accepted", "2026-11-06T10:00:00Z"),
    ];
    expect(latestUpload(uploads, "a", "passport")?.status).toBe("submitted");
    expect(latestUpload(uploads, "b", "insurance")).toBeUndefined();
  });
});

describe("staffProgress", () => {
  const base = {
    travelerIds: ["a", "b"],
    required: ["insurance", "passport"] as UploadRow["kind"][],
    waiverVersionId: "w1",
  };

  it("counts every file and the waiver for every traveler", () => {
    expect(staffProgress({ ...base, uploads: [], signatures: [] })).toEqual({
      total: 6,
      done: 0,
      toReview: 0,
      missing: 6,
    });
  });

  it("separates accepted, waiting for review, and still missing", () => {
    const progress = staffProgress({
      ...base,
      uploads: [
        upload("a", "insurance", "accepted", "2026-11-01T10:00:00Z"),
        upload("a", "passport", "submitted", "2026-11-01T10:00:00Z"),
        upload("b", "passport", "rejected", "2026-11-01T10:00:00Z"),
      ],
      signatures: [{ traveler_id: "a", waiver_version_id: "w1" }],
    });
    expect(progress).toEqual({ total: 6, done: 2, toReview: 1, missing: 3 });
    expect(progressLabel(progress)).toBe("2 of 6 in, 1 to review");
  });

  it("treats a rejected file as missing until it is sent again", () => {
    const rejected = [upload("a", "passport", "rejected", "2026-11-01T10:00:00Z")];
    const one = { travelerIds: ["a"], required: ["passport"] as UploadRow["kind"][], waiverVersionId: null };
    expect(staffProgress({ ...one, uploads: rejected, signatures: [] }).missing).toBe(1);
    const resent = [...rejected, upload("a", "passport", "submitted", "2026-11-02T10:00:00Z")];
    expect(staffProgress({ ...one, uploads: resent, signatures: [] })).toEqual({
      total: 1,
      done: 0,
      toReview: 1,
      missing: 0,
    });
  });

  it("does not count a signature on an older waiver version", () => {
    const progress = staffProgress({
      travelerIds: ["a"],
      required: [],
      waiverVersionId: "w2",
      uploads: [],
      signatures: [{ traveler_id: "a", waiver_version_id: "w1" }],
    });
    expect(progress).toEqual({ total: 1, done: 0, toReview: 0, missing: 1 });
  });

  it("labels the finished and the empty cases", () => {
    expect(progressLabel({ total: 3, done: 3, toReview: 0, missing: 0 })).toBe("All 3 in");
    expect(progressLabel({ total: 0, done: 0, toReview: 0, missing: 0 })).toBe("Nothing asked for");
    expect(progressLabel({ total: 3, done: 0, toReview: 0, missing: 3 })).toBe("0 of 3 in");
  });
});

describe("documentProgress (the traveler's view)", () => {
  const docs: Pick<BookingDocuments, "required" | "waiver" | "travelers"> = {
    required: ["insurance", "passport"],
    waiver: { id: "w1", version: 1, title: "Travel Consent" },
    travelers: [
      {
        id: "a",
        first_name: "Tenzin",
        last_name: "Norbu",
        is_lead: true,
        documents: {
          insurance: { status: "accepted", note: null, uploaded_at: "2026-11-01T10:00:00Z" },
          passport: { status: "rejected", note: "Too blurry", uploaded_at: "2026-11-01T10:00:00Z" },
        },
        waiver_signed_at: "2026-11-02T10:00:00Z",
      },
    ],
  };

  it("counts what is handed in and what still needs the traveler", () => {
    expect(documentProgress(docs)).toEqual({ total: 3, handedIn: 2, accepted: 2, needsAction: 1 });
  });
});
