/**
 * Calendar dates as "YYYY-MM-DD" strings, the way Postgres `date` and HTML
 * date inputs hold them. No time zones: a departure date is a day, not an
 * instant.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date in YYYY-MM-DD form. Rejects 2027-02-30. */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Adds (or with a negative number, subtracts) whole days. */
export function addDays(isoDate: string, days: number): string {
  if (!isIsoDate(isoDate)) throw new RangeError("not a YYYY-MM-DD date");
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const LONG = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** "Jul 10, 2027" */
export function formatDate(isoDate: string): string {
  return isIsoDate(isoDate) ? LONG.format(new Date(`${isoDate}T00:00:00Z`)) : isoDate;
}

/** "Jul 10 – Jul 22, 2027", or with both years when they differ. */
export function formatDateRange(start: string, end: string): string {
  if (!isIsoDate(start) || !isIsoDate(end)) return `${start} – ${end}`;
  if (start.slice(0, 4) !== end.slice(0, 4)) {
    return `${formatDate(start)} – ${formatDate(end)}`;
  }
  const short = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${short.format(new Date(`${start}T00:00:00Z`))} – ${formatDate(end)}`;
}
