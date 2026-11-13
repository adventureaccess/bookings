import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RATE_LIMITS, rateLimitKey } from "./rate-limit-rules";
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from "./security-headers";
import { verifyTurnstile } from "./turnstile";

describe("security headers", () => {
  it("are repeated in netlify.toml for static files", () => {
    const toml = readFileSync("netlify.toml", "utf8");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(toml).toContain(`${name} = "${value}"`);
    }
  });

  it("deny framing and sniffing", () => {
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("Content-Security-Policy", () => {
  const directives = Object.fromEntries(
    CONTENT_SECURITY_POLICY.split("; ").map((part) => {
      const [name, ...values] = part.split(" ");
      return [name, values];
    }),
  );

  it("allows nothing by default but this site", () => {
    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("never allows inline or evaluated script, or inline style", () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(directives["style-src"]).toEqual(["'self'"]);
  });

  it("lets scripts and frames come only from this site and Turnstile", () => {
    expect(directives["script-src"]).toEqual(["'self'", "https://challenges.cloudflare.com"]);
    expect(directives["frame-src"]).toEqual(["https://challenges.cloudflare.com"]);
  });

  it("lets a form post end up only here, at Stripe, or in the staff sign-in", () => {
    expect(directives["form-action"]).toEqual([
      "'self'",
      "https://checkout.stripe.com",
      "https://*.supabase.co",
      "https://accounts.google.com",
    ]);
  });

  it("has no wildcard source except https images", () => {
    for (const [name, values] of Object.entries(directives)) {
      if (name === "img-src") continue;
      expect(values, name).not.toContain("*");
      expect(values, name).not.toContain("https:");
    }
  });
});

describe("rate limit rules", () => {
  it("never puts the caller's address in the key", () => {
    const key = rateLimitKey("booking_form", "203.0.113.7");
    expect(key).toMatch(/^booking_form:[0-9a-f]{32}$/);
    expect(key).not.toContain("203.0.113.7");
  });

  it("gives the same caller the same key, and different callers and scopes different ones", () => {
    expect(rateLimitKey("booking_form", "203.0.113.7")).toBe(rateLimitKey("booking_form", "203.0.113.7"));
    expect(rateLimitKey("booking_form", "203.0.113.7")).not.toBe(rateLimitKey("booking_form", "203.0.113.8"));
    expect(rateLimitKey("booking_form", "203.0.113.7")).not.toBe(rateLimitKey("payment_start", "203.0.113.7"));
    expect(rateLimitKey("booking_form", null)).toBe("booking_form:unknown");
  });

  it("every rule has a sane limit and window", () => {
    for (const [scope, rule] of Object.entries(RATE_LIMITS)) {
      expect(rule.limit, scope).toBeGreaterThanOrEqual(10);
      expect(rule.limit, scope).toBeLessThanOrEqual(100);
      expect(rule.windowSeconds, scope).toBeGreaterThanOrEqual(60);
    }
  });
});

describe("verifyTurnstile", () => {
  const answering = (body: unknown, status = 200) => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as URLSearchParams });
      return Response.json(body, { status });
    }) as typeof fetch;
    return { fake, calls };
  };

  it("accepts a token Cloudflare confirms, sending the secret and the address", async () => {
    const { fake, calls } = answering({ success: true });
    expect(await verifyTurnstile("token-abc", "the-secret", "203.0.113.7", fake)).toBe(true);
    expect(calls[0]?.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(Object.fromEntries(calls[0]!.body)).toEqual({
      secret: "the-secret",
      response: "token-abc",
      remoteip: "203.0.113.7",
    });
  });

  it("refuses when Cloudflare says no", async () => {
    const { fake } = answering({ success: false, "error-codes": ["invalid-input-response"] });
    expect(await verifyTurnstile("token-abc", "s", null, fake)).toBe(false);
  });

  it("refuses a missing or oversized token without asking Cloudflare", async () => {
    const { fake, calls } = answering({ success: true });
    expect(await verifyTurnstile("", "s", null, fake)).toBe(false);
    expect(await verifyTurnstile("x".repeat(2049), "s", null, fake)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses when Cloudflare cannot be reached or answers nonsense", async () => {
    const broken = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect(await verifyTurnstile("t", "s", null, broken)).toBe(false);
    expect(await verifyTurnstile("t", "s", null, answering({}, 500).fake)).toBe(false);
    expect(await verifyTurnstile("t", "s", null, answering({ success: "true" }).fake)).toBe(false);
  });
});
