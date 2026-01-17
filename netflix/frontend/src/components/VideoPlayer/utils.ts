/**
 * VideoPlayer Utility Functions
 *
 * Shared utility functions used across VideoPlayer sub-components.
 */

/**
 * Formats seconds into a human-readable time string.
 * Returns format "H:MM:SS" for videos over an hour, or "M:SS" for shorter videos.
 *
 * @param seconds - Time in seconds to format
 * @returns Formatted time string (e.g., "1:23:45" or "45:30")
 *
 * @example
 * formatTime(3661) // "1:01:01"
 * formatTime(125)  // "2:05"
 * formatTime(45)   // "0:45"
 */
export function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}
