import { describe, expect, it } from "vitest";
import { parseEnv, siteUrl } from "./env.schema";

const base = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "placeholder-anon",
  SUPABASE_SERVICE_ROLE_KEY: "placeholder-service",
};

describe("parseEnv", () => {
  it("accepts the required names", () => {
    expect(parseEnv(base).NEXT_PUBLIC_SUPABASE_URL).toBe(
      "https://example.supabase.co",
    );
  });

  it("names what is missing without printing values", () => {
    const rest = { ...base, SUPABASE_SERVICE_ROLE_KEY: undefined };
    expect(() => parseEnv(rest)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => parseEnv(rest)).not.toThrow(/placeholder-anon/);
  });

  it("treats a blank value as missing", () => {
    expect(() =>
      parseEnv({ ...base, NEXT_PUBLIC_SUPABASE_ANON_KEY: "  " }),
    ).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });

  it("rejects a Supabase URL that is not a URL", () => {
    expect(() =>
      parseEnv({ ...base, NEXT_PUBLIC_SUPABASE_URL: "not a url" }),
    ).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});

describe("siteUrl", () => {
  it("prefers SITE_URL and trims the trailing slash", () => {
    expect(siteUrl({ SITE_URL: "https://book.adventure-access.com/" })).toBe(
      "https://book.adventure-access.com",
    );
  });

  it("falls back to the Vercel URL, then localhost", () => {
    expect(siteUrl({ VERCEL_URL: "x.vercel.app" })).toBe("https://x.vercel.app");
    expect(siteUrl({})).toBe("http://localhost:3000");
  });
});
