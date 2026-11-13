/**
 * CSV for the bookings export. Pure, so it can be tested.
 *
 * Two things matter beyond commas and quotes. First, a spreadsheet treats a
 * cell that starts with =, +, - or @ as a formula, and a traveler can type
 * anything into their name: such cells are prefixed with an apostrophe so
 * they stay text. Second, Excel needs a byte-order mark to read accents.
 */

export type Cell = string | number | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows to CSV text, with a byte-order mark and CRLF line endings. */
export function toCsv(header: string[], rows: Cell[][]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Cents as a plain dollar amount a spreadsheet reads as a number: 495000 -> "4950.00". */
export function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export interface ExportBooking {
  reference: string;
  status: string;
  traveler_count: number;
  total_cents: number;
  discount_cents: number;
  paid_cents: number;
  needs_attention: boolean;
  created_at: string;
  trip_title: string;
  group_name: string | null;
  start_date: string;
  end_date: string;
  balance_due_date: string;
  /** "2 of 3 in, 1 to review" */
  documents: string;
  travelers: {
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
    is_lead: boolean;
    answers: unknown;
  }[];
}

export const EXPORT_HEADER = [
  "Reference",
  "Status",
  "Needs a look",
  "Trip",
  "Group",
  "Start",
  "End",
  "First name",
  "Last name",
  "Email",
  "Phone",
  "Registered by",
  "Answers",
  "Travelers on booking",
  "Total (USD)",
  "Credits (USD)",
  "Paid (USD)",
  "Balance (USD)",
  "Balance due",
  "Documents",
  "Registered on",
];

const STATUS: Record<string, string> = {
  pending: "Registered, not paid",
  deposit_paid: "Deposit paid",
  paid_in_full: "Paid in full",
  canceled: "Canceled",
  refunded: "Refunded",
};

function answers(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  return Object.values(raw as Record<string, unknown>)
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join("; ");
}

/**
 * One row per traveler. The booking's money appears on the row of the person
 * who registered and is left blank on their dependents' rows, so a column
 * can be summed without counting anything twice.
 */
export function exportRows(bookings: ExportBooking[]): Cell[][] {
  const rows: Cell[][] = [];
  for (const booking of bookings) {
    const travelers = [...booking.travelers].sort((a, b) => Number(b.is_lead) - Number(a.is_lead));
    const lead = travelers.find((t) => t.is_lead);
    const balance = Math.max(booking.total_cents - booking.discount_cents - booking.paid_cents, 0);
    travelers.forEach((traveler, index) => {
      const first = index === 0;
      rows.push([
        booking.reference,
        STATUS[booking.status] ?? booking.status,
        booking.needs_attention ? "Yes" : "",
        booking.trip_title,
        booking.group_name,
        booking.start_date,
        booking.end_date,
        traveler.first_name,
        traveler.last_name,
        traveler.email,
        traveler.phone,
        traveler.is_lead ? "Self" : lead ? `${lead.first_name} ${lead.last_name}` : "",
        answers(traveler.answers),
        first ? booking.traveler_count : null,
        first ? dollars(booking.total_cents) : null,
        first ? dollars(booking.discount_cents) : null,
        first ? dollars(booking.paid_cents) : null,
        first ? dollars(balance) : null,
        first ? booking.balance_due_date : null,
        first ? booking.documents : null,
        booking.created_at.slice(0, 10),
      ]);
    });
  }
  return rows;
}
