import {
  parseISO,
  format,
  addMinutes,
  startOfDay,
  endOfDay,
  isBefore,
  isAfter,
  areIntervalsOverlapping,
  getDay,
  setHours,
  setMinutes,
} from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

export interface TimeInterval {
  start: Date;
  end: Date;
}

/**
 * Parse time string (HH:MM) to hours and minutes
 */
export function parseTime(timeString: string): { hours: number; minutes: number } {
  const [hours, minutes] = timeString.split(':').map(Number);
  return { hours, minutes };
}

/**
 * Convert a local time to UTC
 */
export function localToUtc(date: Date, timezone: string): Date {
  return fromZonedTime(date, timezone);
}

/**
 * Convert UTC to local time
 */
export function utcToLocal(date: Date, timezone: string): Date {
  return toZonedTime(date, timezone);
}

/**
 * Format date for display in a specific timezone
 */
export function formatInTimezone(date: Date, timezone: string, formatStr: string): string {
  const zonedDate = toZonedTime(date, timezone);
  return format(zonedDate, formatStr);
}

/**
 * Get the day of week for a date in a specific timezone
 */
export function getDayOfWeekInTimezone(date: Date, timezone: string): number {
  const zonedDate = toZonedTime(date, timezone);
  return getDay(zonedDate);
}

/**
 * Merge overlapping intervals
 */
export function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  if (intervals.length === 0) return [];

  // Sort by start time
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: TimeInterval[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    // If current interval overlaps or is adjacent to the last merged interval
    if (current.start.getTime() <= last.end.getTime()) {
      // Extend the end if needed
      if (current.end.getTime() > last.end.getTime()) {
        last.end = current.end;
      }
    } else {
      // No overlap, add as new interval
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Find gaps (available slots) between busy intervals within a given range
 */
export function findGaps(
  rangeStart: Date,
  rangeEnd: Date,
  busyIntervals: TimeInterval[],
  slotDuration: number // in minutes
): TimeInterval[] {
  const gaps: TimeInterval[] = [];
  const merged = mergeIntervals(busyIntervals);

  let currentStart = rangeStart;

  for (const busy of merged) {
    // If there's a gap before this busy period
    if (isBefore(currentStart, busy.start)) {
      const gapEnd = busy.start;
      // Check if the gap is long enough for a slot
      const gapDuration = (gapEnd.getTime() - currentStart.getTime()) / (1000 * 60);
      if (gapDuration >= slotDuration) {
        gaps.push({ start: currentStart, end: gapEnd });
      }
    }
    // Move current start past this busy period
    if (isAfter(busy.end, currentStart)) {
      currentStart = busy.end;
    }
  }

  // Check for gap after the last busy period
  if (isBefore(currentStart, rangeEnd)) {
    const gapDuration = (rangeEnd.getTime() - currentStart.getTime()) / (1000 * 60);
    if (gapDuration >= slotDuration) {
      gaps.push({ start: currentStart, end: rangeEnd });
    }
  }

  return gaps;
}

/**
 * Generate time slots from gaps
 */
export function generateSlots(
  gaps: TimeInterval[],
  slotDuration: number, // in minutes
  bufferBefore: number = 0,
  bufferAfter: number = 0
): TimeInterval[] {
  const slots: TimeInterval[] = [];
  const totalSlotTime = slotDuration + bufferBefore + bufferAfter;

  for (const gap of gaps) {
    let slotStart = addMinutes(gap.start, bufferBefore);
    const effectiveEnd = addMinutes(gap.end, -bufferAfter);

    while (addMinutes(slotStart, slotDuration).getTime() <= effectiveEnd.getTime()) {
      slots.push({
        start: slotStart,
        end: addMinutes(slotStart, slotDuration),
      });
      slotStart = addMinutes(slotStart, slotDuration + bufferAfter + bufferBefore);
    }
  }

  return slots;
}

/**
 * Check if two intervals overlap
 */
export function intervalsOverlap(a: TimeInterval, b: TimeInterval): boolean {
  return areIntervalsOverlapping(
    { start: a.start, end: a.end },
    { start: b.start, end: b.end }
  );
}

/**
 * Create a Date from a date string and time string in a specific timezone
 */
export function createDateWithTime(
  dateStr: string, // YYYY-MM-DD
  timeStr: string, // HH:MM
  timezone: string
): Date {
  const { hours, minutes } = parseTime(timeStr);
  const date = parseISO(dateStr);
  const dateWithTime = setMinutes(setHours(date, hours), minutes);
  return fromZonedTime(dateWithTime, timezone);
}

/**
 * Get start and end of day in a specific timezone, converted to UTC
 */
export function getDayBoundsUtc(
  dateStr: string,
  timezone: string
): { start: Date; end: Date } {
  const date = parseISO(dateStr);
  const startLocal = startOfDay(date);
  const endLocal = endOfDay(date);

  return {
    start: fromZonedTime(startLocal, timezone),
    end: fromZonedTime(endLocal, timezone),
  };
}

/**
 * Validate timezone string
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of common timezones
 */
export function getCommonTimezones(): string[] {
  return [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Toronto',
    'America/Vancouver',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Moscow',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Asia/Singapore',
    'Australia/Sydney',
    'Pacific/Auckland',
  ];
}
