/**
 * Formats a calendar day ('YYYY-MM-DD', how the API returns DATE columns).
 * `new Date('2026-12-15')` parses as UTC midnight, which displays as Dec 14
 * anywhere west of Greenwich, so build the date from its parts in local time.
 */
export function formatCalendarDate(value: string | null): string {
  if (!value) return '-';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString();
}
