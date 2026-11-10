import { describe, expect, it } from "vitest";
import {
  assertCents,
  balanceCents,
  centsToDollars,
  formatUsd,
  isCents,
  multiplyCents,
} from "./money";

describe("isCents", () => {
  it("accepts non-negative whole numbers", () => {
    expect(isCents(0)).toBe(true);
    expect(isCents(495000)).toBe(true);
  });

  it("rejects floats, negatives, strings and non-finite values", () => {
    for (const bad of [1.5, -1, "100", NaN, Infinity, null, undefined]) {
      expect(isCents(bad)).toBe(false);
    }
  });
});

describe("assertCents", () => {
  it("returns the value when valid", () => {
    expect(assertCents(100)).toBe(100);
  });

  it("names the field in the error", () => {
    expect(() => assertCents(-5, "deposit")).toThrow(/deposit/);
  });
});

describe("multiplyCents", () => {
  it("multiplies a per-person amount by the party size", () => {
    expect(multiplyCents(75000, 3)).toBe(225000);
  });

  it("rejects a zero, negative or fractional quantity", () => {
    expect(() => multiplyCents(75000, 0)).toThrow(RangeError);
    expect(() => multiplyCents(75000, -1)).toThrow(RangeError);
    expect(() => multiplyCents(75000, 1.5)).toThrow(RangeError);
  });

  it("rejects a fractional amount", () => {
    expect(() => multiplyCents(750.5, 2)).toThrow(RangeError);
  });
});

describe("balanceCents", () => {
  it("is total minus paid", () => {
    expect(balanceCents(495000, 75000)).toBe(420000);
  });

  it("never goes below zero", () => {
    expect(balanceCents(1000, 1500)).toBe(0);
  });
});

describe("centsToDollars", () => {
  it("converts for HubSpot amounts", () => {
    expect(centsToDollars(495050)).toBe(4950.5);
  });
});

describe("formatUsd", () => {
  it("drops the cents on whole dollars", () => {
    expect(formatUsd(495000)).toBe("$4,950");
  });

  it("keeps the cents otherwise", () => {
    expect(formatUsd(495050)).toBe("$4,950.50");
  });

  it("formats zero", () => {
    expect(formatUsd(0)).toBe("$0");
  });
});
