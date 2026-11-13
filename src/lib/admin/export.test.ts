import { describe, expect, it } from "vitest";
import { csvCell, dollars, EXPORT_HEADER, exportRows, toCsv, type ExportBooking } from "./export";

const booking = (overrides: Partial<ExportBooking> = {}): ExportBooking => ({
  reference: "AA-7K3Q",
  status: "deposit_paid",
  traveler_count: 2,
  total_cents: 990000,
  discount_cents: 50000,
  paid_cents: 150000,
  needs_attention: false,
  created_at: "2026-11-12T15:04:05Z",
  trip_title: "Ladakh Multisport",
  group_name: "Hulsey family",
  start_date: "2027-07-10",
  end_date: "2027-07-22",
  balance_due_date: "2027-05-11",
  documents: "2 of 6 in, 1 to review",
  travelers: [
    { first_name: "Pema", last_name: "Norbu", email: null, phone: null, is_lead: false, answers: {} },
    {
      first_name: "Tenzin",
      last_name: "Norbu",
      email: "tenzin@example.com",
      phone: "+1 555 0100",
      is_lead: true,
      answers: { q1: "172 cm", q2: "Cycling, hiking" },
    },
  ],
  ...overrides,
});

describe("csvCell", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("Norbu, Tenzin")).toBe('"Norbu, Tenzin"');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });

  it("keeps a cell that looks like a formula as text", () => {
    expect(csvCell("=HYPERLINK(\"http://evil.example\",\"click\")")).toBe(
      "\"'=HYPERLINK(\"\"http://evil.example\"\",\"\"click\"\")\"",
    );
    expect(csvCell("+1 555 0100")).toBe("'+1 555 0100");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("writes empty for missing values and plain numbers for numbers", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(3)).toBe("3");
    expect(csvCell(Number.NaN)).toBe("");
  });
});

describe("exportRows", () => {
  it("writes one row per traveler, the person who registered first", () => {
    const rows = exportRows([booking()]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([
      "AA-7K3Q",
      "Deposit paid",
      "",
      "Ladakh Multisport",
      "Hulsey family",
      "2027-07-10",
      "2027-07-22",
      "Tenzin",
      "Norbu",
      "tenzin@example.com",
      "+1 555 0100",
      "Self",
      "172 cm; Cycling, hiking",
      2,
      "9900.00",
      "500.00",
      "1500.00",
      "7900.00",
      "2027-05-11",
      "2 of 6 in, 1 to review",
      "2026-11-12",
    ]);
    expect(rows[0]).toHaveLength(EXPORT_HEADER.length);
  });

  it("puts the money on one row only, so a column can be summed", () => {
    const rows = exportRows([booking()]);
    const dependent = rows[1]!;
    expect(dependent[7]).toBe("Pema");
    expect(dependent[11]).toBe("Tenzin Norbu");
    expect(dependent.slice(13, 20)).toEqual([null, null, null, null, null, null, null]);
  });

  it("flags a booking that needs a look and never shows a negative balance", () => {
    const [row] = exportRows([booking({ needs_attention: true, paid_cents: 2000000 })]);
    expect(row![2]).toBe("Yes");
    expect(row![17]).toBe("0.00");
  });
});

describe("toCsv", () => {
  it("starts with a byte-order mark and uses CRLF, for Excel", () => {
    const csv = toCsv(["A", "B"], [["1", "x,y"]]);
    expect(csv).toBe('﻿A,B\r\n1,"x,y"\r\n');
  });

  it("round-trips a whole export without breaking the columns", () => {
    const tricky = booking({
      travelers: [
        {
          first_name: '=cmd|"/c calc"!A1',
          last_name: "O'Brien, Jr.",
          email: "a@b.co",
          phone: "+44 20 7946 0958",
          is_lead: true,
          answers: { q1: "line one\nline two" },
        },
      ],
    });
    const csv = toCsv(EXPORT_HEADER, exportRows([tricky]));
    // Header, one record (with a quoted line break inside it), trailing newline.
    const records = csv.slice(1).split("\r\n");
    expect(records).toHaveLength(3);
    expect(records[1]).toContain("\"'=cmd|\"\"/c calc\"\"!A1\"");
    expect(records[1]).toContain("\"O'Brien, Jr.\"");
    expect(records[1]).toContain("'+44 20 7946 0958");
  });

  it("formats cents as plain dollars", () => {
    expect(dollars(495000)).toBe("4950.00");
    expect(dollars(12345)).toBe("123.45");
    expect(dollars(0)).toBe("0.00");
  });
});
