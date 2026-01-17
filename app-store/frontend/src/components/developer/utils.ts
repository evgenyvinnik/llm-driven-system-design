/**
 * @fileoverview Utility functions for developer components.
 * Contains shared helpers for styling and formatting.
 */

import type { App } from '../../types';

/**
 * Maps app status to corresponding Tailwind CSS color classes.
 *
 * @param status - Current app status
 * @returns CSS class string for badge styling
 *
 * @example
 * ```tsx
 * <span className={getStatusColor('published')}>Published</span>
 * ```
 */
export function getStatusColor(status: App['status']): string {
  const colors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-700',
    pending: 'bg-yellow-100 text-yellow-700',
    approved: 'bg-green-100 text-green-700',
    rejected: 'bg-red-100 text-red-700',
    published: 'bg-blue-100 text-blue-700',
    suspended: 'bg-red-100 text-red-700',
  };
  return colors[status] || 'bg-gray-100 text-gray-700';
}
