import { format, parseISO, addMinutes } from 'date-fns';
import { toZonedTime, formatInTimeZone } from 'date-fns-tz';

/**
 * Get the user's local timezone
 */
export function getLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Format a date in a specific timezone
 */
export function formatInTimezone(date: Date | string, timezone: string, formatStr: string): string {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return formatInTimeZone(dateObj, timezone, formatStr);
}

/**
 * Format a time slot for display
 */
export function formatTimeSlot(startIso: string, endIso: string, timezone: string): string {
  const start = formatInTimezone(startIso, timezone, 'h:mm a');
  const end = formatInTimezone(endIso, timezone, 'h:mm a');
  return `${start} - ${end}`;
}

/**
 * Format date for display
 */
export function formatDate(date: Date | string, timezone: string): string {
  return formatInTimezone(date, timezone, 'EEEE, MMMM d, yyyy');
}

/**
 * Format date and time for display
 */
export function formatDateTime(date: Date | string, timezone: string): string {
  return formatInTimezone(date, timezone, 'EEEE, MMMM d, yyyy \'at\' h:mm a');
}

/**
 * Get day name from day number
 */
export function getDayName(dayOfWeek: number): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[dayOfWeek];
}

/**
 * Get short day name from day number
 */
export function getShortDayName(dayOfWeek: number): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[dayOfWeek];
}

/**
 * Format time string (HH:MM) to 12-hour format
 */
export function formatTime12Hour(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
  return `${hour12}:${minutes.toString().padStart(2, '0')} ${period}`;
}

/**
 * Common timezones list
 */
export const commonTimezones = [
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'Eastern Time (US & Canada)' },
  { value: 'America/Chicago', label: 'Central Time (US & Canada)' },
  { value: 'America/Denver', label: 'Mountain Time (US & Canada)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (US & Canada)' },
  { value: 'America/Toronto', label: 'Toronto' },
  { value: 'America/Vancouver', label: 'Vancouver' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Europe/Moscow', label: 'Moscow' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Kolkata', label: 'Mumbai, Kolkata' },
  { value: 'Asia/Shanghai', label: 'Beijing, Shanghai' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Australia/Sydney', label: 'Sydney' },
  { value: 'Pacific/Auckland', label: 'Auckland' },
];

/**
 * Get display name for timezone
 */
export function getTimezoneDisplayName(timezone: string): string {
  const found = commonTimezones.find(tz => tz.value === timezone);
  return found ? found.label : timezone;
}
