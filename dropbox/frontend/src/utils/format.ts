/**
 * Formatting utilities for display in the UI.
 * Provides human-readable formatting for bytes, dates, and storage indicators.
 * @module utils/format
 */

/**
 * Formats a byte count into a human-readable string.
 * @param bytes - Number of bytes to format
 * @returns Formatted string like "1.5 MB" or "256 KB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Formats a date into a localized string with date and time.
 * @param date - Date string or Date object to format
 * @returns Formatted date string like "Jan 15, 2024, 03:45 PM"
 */
export function formatDate(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Formats a date as a relative time string.
 * Shows "Just now", "X minutes ago", etc. for recent dates.
 * Falls back to absolute date for dates over 7 days old.
 * @param date - Date string or Date object to format
 * @returns Relative time string like "2 hours ago"
 */
export function formatRelativeDate(date: string | Date): string {
  const d = new Date(date);
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) {
    return formatDate(date);
  } else if (days > 0) {
    return `${days} day${days > 1 ? 's' : ''} ago`;
  } else if (hours > 0) {
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  } else if (minutes > 0) {
    return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  } else {
    return 'Just now';
  }
}

/**
 * Determines the icon type for a file based on its MIME type.
 * Used to display appropriate icons in the file browser.
 * @param mimeType - MIME type of the file
 * @param isFolder - Whether the item is a folder
 * @returns Icon type string (folder, image, video, audio, pdf, etc.)
 */
export function getFileIcon(mimeType: string | null, isFolder: boolean): string {
  if (isFolder) return 'folder';

  if (!mimeType) return 'file';

  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z')) return 'archive';
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'doc';
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return 'spreadsheet';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'presentation';

  return 'file';
}

/**
 * Calculates storage usage percentage.
 * @param used - Bytes used
 * @param quota - Total quota in bytes
 * @returns Percentage of storage used (0-100)
 */
export function getStoragePercentage(used: number, quota: number): number {
  if (quota === 0) return 0;
  return Math.min(100, (used / quota) * 100);
}

/**
 * Returns the Tailwind CSS class for storage bar color.
 * Red for >= 90%, yellow for >= 75%, blue otherwise.
 * @param percentage - Storage usage percentage
 * @returns Tailwind background color class
 */
export function getStorageColor(percentage: number): string {
  if (percentage >= 90) return 'bg-red-500';
  if (percentage >= 75) return 'bg-yellow-500';
  return 'bg-dropbox-blue';
}
