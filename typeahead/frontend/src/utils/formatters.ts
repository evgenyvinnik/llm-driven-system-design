/**
 * Utility functions for formatting values in the admin dashboard.
 */

/**
 * Formats a duration in seconds into a human-readable string.
 * Shows days and hours for longer durations, hours and minutes for shorter ones.
 *
 * @param seconds - The duration in seconds
 * @returns A formatted string like "2d 5h", "3h 45m", or "12m"
 *
 * @example
 * formatUptime(90000) // "1d 1h"
 * formatUptime(3700)  // "1h 1m"
 * formatUptime(300)   // "5m"
 */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Formats a byte count into a human-readable string with appropriate units.
 * Automatically selects KB, MB, or GB based on the size.
 *
 * @param bytes - The number of bytes to format
 * @returns A formatted string like "1.5 GB", "256.0 MB", or "64.0 KB"
 *
 * @example
 * formatBytes(1073741824) // "1.0 GB"
 * formatBytes(1048576)    // "1.0 MB"
 * formatBytes(1024)       // "1.0 KB"
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) {
    return `${(bytes / 1073741824).toFixed(1)} GB`;
  }
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}
