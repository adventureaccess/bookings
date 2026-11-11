import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "./security-headers";

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
