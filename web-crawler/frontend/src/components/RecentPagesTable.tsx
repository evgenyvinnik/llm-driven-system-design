/**
 * @fileoverview Table component for displaying recently crawled pages.
 *
 * Displays a table of recently crawled pages with:
 * - URL/title (clickable to open in new tab)
 * - Domain
 * - HTTP status code (color-coded badge)
 * - Crawl duration
 * - Relative time since crawl
 *
 * Includes loading state with skeleton placeholder.
 *
 * @module components/RecentPagesTable
 */

/**
 * Data structure for a recently crawled page.
 */
interface RecentPage {
  /** The URL that was crawled */
  url: string;
  /** Domain hostname */
  domain: string;
  /** Extracted page title */
  title: string;
  /** HTTP status code */
  statusCode: number;
  /** ISO timestamp when crawled */
  crawledAt: string;
  /** Crawl duration in milliseconds */
  durationMs: number;
}

/**
 * Props for the RecentPagesTable component.
 */
interface RecentPagesTableProps {
  /** Array of recently crawled pages to display */
  pages: RecentPage[];
  /** Whether the data is loading (shows skeleton) */
  loading?: boolean;
}

/**
 * Table displaying recently crawled pages.
 *
 * Shows a list of the most recently crawled URLs with their metadata.
 * Used on the dashboard to show real-time crawl activity.
 *
 * @param props - Component props
 * @returns React component rendering the table
 *
 * @example
 * ```tsx
 * <RecentPagesTable
 *   pages={stats.recentPages}
 *   loading={isLoading}
 * />
 * ```
 */
export function RecentPagesTable({ pages, loading }: RecentPagesTableProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
        <div className="animate-pulse space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 bg-gray-100 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="text-sm font-medium text-gray-900">Recently Crawled Pages</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                URL
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                Domain
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                Status
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                Duration
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                Time
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {pages.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                  No pages crawled yet
                </td>
              </tr>
            ) : (
              pages.map((page, index) => (
                <tr key={index} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <div className="max-w-xs truncate">
                      <a
                        href={page.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary-600 hover:text-primary-800"
                        title={page.url}
                      >
                        {page.title || page.url}
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-600">{page.domain}</td>
                  <td className="px-4 py-2">
                    <StatusBadge code={page.statusCode} />
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-600">{page.durationMs}ms</td>
                  <td className="px-4 py-2 text-sm text-gray-500">
                    {formatTimeAgo(page.crawledAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Badge component for displaying HTTP status codes.
 *
 * Color-coded based on status code range:
 * - 2xx: Green (success)
 * - 3xx: Yellow (redirect)
 * - 4xx/5xx: Red (error)
 *
 * @param props - Component props with status code
 * @returns React component rendering the badge
 */
function StatusBadge({ code }: { code: number }) {
  const color =
    code >= 200 && code < 300
      ? 'bg-green-100 text-green-800'
      : code >= 300 && code < 400
        ? 'bg-yellow-100 text-yellow-800'
        : code >= 400
          ? 'bg-red-100 text-red-800'
          : 'bg-gray-100 text-gray-800';

  return (
    <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${color}`}>
      {code || 'N/A'}
    </span>
  );
}

/**
 * Formats a timestamp as a relative "time ago" string.
 *
 * @param dateString - ISO date string to format
 * @returns Human-readable relative time (e.g., "5m ago")
 *
 * @example
 * ```typescript
 * formatTimeAgo('2024-01-16T12:00:00Z'); // "5m ago"
 * ```
 */
function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
