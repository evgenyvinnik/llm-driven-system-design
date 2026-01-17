/**
 * @fileoverview Utility functions for the News Feed frontend.
 * Provides date formatting, number abbreviation, and UI helpers.
 */

/**
 * Formats a date string into a human-readable relative time.
 * Shows "Just now" for < 1 minute, "Xm" for minutes, "Xh" for hours,
 * "Xd" for days, "Xw" for weeks, or the actual date for older posts.
 *
 * @param dateString - ISO date string to format
 * @returns Human-readable relative time string
 */
export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffSeconds < 60) {
    return 'Just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  } else if (diffHours < 24) {
    return `${diffHours}h`;
  } else if (diffDays < 7) {
    return `${diffDays}d`;
  } else if (diffWeeks < 4) {
    return `${diffWeeks}w`;
  } else {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
  }
}

/**
 * Abbreviates large numbers for display (e.g., 1500 -> "1.5K").
 * Supports K (thousands) and M (millions) suffixes.
 *
 * @param num - Number to format
 * @returns Abbreviated string representation
 */
export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return num.toString();
}

/**
 * Extracts initials from a name for avatar display.
 * Takes first letter of first two words, uppercase.
 *
 * @param name - Full name to extract initials from
 * @returns 1-2 character uppercase initials string
 */
export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Utility function for conditionally joining class names.
 * Filters out falsy values and joins remaining strings with spaces.
 *
 * @param classes - Array of class names or falsy values
 * @returns Space-separated string of truthy class names
 */
export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}
