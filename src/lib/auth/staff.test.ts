import { describe, expect, it } from "vitest";
import { canWrite, eligibleStaffEmail, isStaffRole, maskEmail } from "./staff";

const google = {
  email: "Guide@Adventure-Access.com",
  email_confirmed_at: "2026-11-11T00:00:00Z",
  app_metadata: { provider: "google" },
};

describe("eligibleStaffEmail", () => {
  it("accepts a confirmed Google account on the company domain, lowercased", () => {
    expect(eligibleStaffEmail(google)).toBe("guide@adventure-access.com");
  });

  it("refuses an account that was not created through Google", () => {
    expect(
      eligibleStaffEmail({ ...google, app_metadata: { provider: "email" } }),
    ).toBeNull();
    expect(eligibleStaffEmail({ ...google, app_metadata: null })).toBeNull();
  });

  it("refuses an unconfirmed email", () => {
    expect(eligibleStaffEmail({ ...google, email_confirmed_at: null })).toBeNull();
  });

  it("refuses other domains, including lookalikes", () => {
    for (const email of [
      "someone@gmail.com",
      "someone@adventure-access.com.evil.com",
      "someone@notadventure-access.com",
      "someone@sub.adventure-access.com",
      "@adventure-access.com",
    ]) {
      expect(eligibleStaffEmail({ ...google, email })).toBeNull();
    }
  });

  it("refuses a missing user", () => {
    expect(eligibleStaffEmail(null)).toBeNull();
    expect(eligibleStaffEmail({})).toBeNull();
  });
});

describe("canWrite", () => {
  it("allows admin and staff, not read_only or nobody", () => {
    expect(canWrite({ email: "a@adventure-access.com", role: "admin" })).toBe(true);
    expect(canWrite({ email: "a@adventure-access.com", role: "staff" })).toBe(true);
    expect(canWrite({ email: "a@adventure-access.com", role: "read_only" })).toBe(false);
    expect(canWrite(null)).toBe(false);
  });
});

describe("isStaffRole", () => {
  it("recognizes only the three roles", () => {
    expect(isStaffRole("admin")).toBe(true);
    expect(isStaffRole("owner")).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskEmail("will@adventure-access.com")).toBe("w***@adventure-access.com");
    expect(maskEmail("nonsense")).toBe("***");
  });
});
