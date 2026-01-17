/**
 * @fileoverview Utility functions for alert-related components.
 *
 * Provides helper functions for styling and formatting alert data,
 * shared across multiple alert components.
 */

/**
 * Returns Tailwind CSS classes for severity badge styling.
 *
 * Maps alert severity levels to appropriate background and text colors:
 * - critical: red background
 * - warning: yellow/amber background
 * - info/default: blue background
 *
 * @param severity - The alert severity level
 * @returns Tailwind CSS class string for background and text color
 */
export function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'bg-red-600 text-white';
    case 'warning':
      return 'bg-yellow-600 text-white';
    default:
      return 'bg-blue-600 text-white';
  }
}

/**
 * Returns Tailwind CSS class for alert status text color.
 *
 * Maps alert instance status to appropriate text colors:
 * - firing: red text indicating active alert
 * - resolved: green text indicating resolved alert
 *
 * @param status - The alert instance status ('firing' or 'resolved')
 * @returns Tailwind CSS class for text color
 */
export function getStatusColor(status: string): string {
  return status === 'firing' ? 'text-red-400' : 'text-green-400';
}
