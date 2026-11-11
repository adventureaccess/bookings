import { describe, expect, it } from "vitest";
import { siteUrl } from "./site-url";

describe("siteUrl", () => {
  it("prefers SITE_URL and trims the trailing slash", () => {
    expect(siteUrl({ SITE_URL: "https://book.adventure-access.com/" })).toBe(
      "https://book.adventure-access.com",
    );
  });

  it("uses the main site URL on a Netlify production deploy", () => {
    expect(
      siteUrl({
        CONTEXT: "production",
        URL: "https://book.adventure-access.com",
        DEPLOY_PRIME_URL: "https://main--aa-bookings.netlify.app",
      }),
    ).toBe("https://book.adventure-access.com");
  });

  it("uses the deploy URL on a Netlify Deploy Preview", () => {
    expect(
      siteUrl({
        CONTEXT: "deploy-preview",
        URL: "https://book.adventure-access.com",
        DEPLOY_PRIME_URL: "https://deploy-preview-7--aa-bookings.netlify.app",
      }),
    ).toBe("https://deploy-preview-7--aa-bookings.netlify.app");
  });

  it("falls back to the local dev server", () => {
    expect(siteUrl({})).toBe("http://localhost:4321");
  });
});
