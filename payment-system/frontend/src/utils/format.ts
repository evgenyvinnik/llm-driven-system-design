/**
 * Utility functions for formatting values in the payment system UI.
 */

/**
 * Formats an amount from cents to display currency.
 * Uses Intl.NumberFormat for locale-aware formatting.
 * @param cents - Amount in cents (e.g., 1050 = $10.50)
 * @param currency - ISO 4217 currency code (default: USD)
 * @returns Formatted currency string (e.g., "$10.50")
 */
export function formatCurrency(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

/**
 * Formats an ISO date string for display.
 * Shows date with abbreviated month and 12-hour time.
 * @param dateString - ISO 8601 date string
 * @returns Formatted date string (e.g., "Jan 15, 2024, 02:30 PM")
 */
export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Formats a number as a percentage with one decimal place.
 * @param value - Numeric percentage value (e.g., 45.678)
 * @returns Formatted percentage string (e.g., "45.7%")
 */
export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * Returns Tailwind CSS classes for styling status badges.
 * Maps transaction, refund, and chargeback statuses to appropriate colors.
 * @param status - Status string from transaction/refund/chargeback
 * @returns Tailwind CSS class string for background and text colors
 */
export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    authorized: 'bg-blue-100 text-blue-800',
    captured: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    refunded: 'bg-purple-100 text-purple-800',
    partially_refunded: 'bg-purple-100 text-purple-800',
    voided: 'bg-gray-100 text-gray-800',
    completed: 'bg-green-100 text-green-800',
    open: 'bg-yellow-100 text-yellow-800',
    won: 'bg-green-100 text-green-800',
    lost: 'bg-red-100 text-red-800',
    pending_response: 'bg-orange-100 text-orange-800',
  };
  return colors[status] || 'bg-gray-100 text-gray-800';
}

/**
 * Truncates a string to a maximum length with ellipsis.
 * Useful for displaying long transaction IDs or descriptions.
 * @param str - String to truncate
 * @param length - Maximum length before truncation
 * @returns Original string if short enough, or truncated with "..."
 */
export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + '...';
}
