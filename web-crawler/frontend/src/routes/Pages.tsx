/**
 * @fileoverview Pages route component for browsing crawled content.
 *
 * The Pages view provides a searchable, paginated interface for exploring
 * all pages that have been crawled by the system. Operators can:
 * - Search pages by URL or title
 * - Filter by domain
 * - View page metadata (status code, size, links, duration)
 * - Navigate through paginated results
 *
 * This view is useful for verifying crawl results, debugging issues,
 * and understanding the scope of indexed content.
 *
 * @module routes/Pages
 */

import { useEffect, useState } from 'react';
import { useCrawlerStore } from '../stores/crawlerStore';

/**
 * Pages route component for browsing crawled page records.
 *
 * Features:
 * - Debounced search (300ms delay)
 * - Domain filtering
 * - Paginated table with 25 items per page
 * - Status code badges (2xx green, 3xx yellow, 4xx/5xx red)
 * - Clickable URLs that open in new tabs
 *
 * @returns Paginated pages browser
 */
export function Pages() {
  const { pages, pagesTotal, pagesLoading, fetchPages } = useCrawlerStore();
  const [search, setSearch] = useState('');
  const [domain, setDomain] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 25;

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      fetchPages(limit, offset, domain || undefined, search || undefined);
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [fetchPages, offset, domain, search]);

  /**
   * Formats byte count into human-readable string.
   *
   * @param bytes - Raw byte count
   * @returns Formatted string with KB/MB/B suffix
   */
  const formatBytes = (bytes: number): string => {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
    return `${bytes} B`;
  };

  /**
   * Formats ISO date string into localized display format.
   *
   * @param dateString - ISO date string from the API
   * @returns Localized date/time string
   */
  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const totalPages = Math.ceil(pagesTotal / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Crawled Pages</h1>
        <span className="text-sm text-gray-500">{pagesTotal.toLocaleString()} total pages</span>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="search" className="block text-sm font-medium text-gray-700 mb-1">
              Search
            </label>
            <input
              type="text"
              id="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
              placeholder="Search by URL or title..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
            />
          </div>
          <div>
            <label htmlFor="domain" className="block text-sm font-medium text-gray-700 mb-1">
              Filter by Domain
            </label>
            <input
              type="text"
              id="domain"
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value);
                setOffset(0);
              }}
              placeholder="example.com"
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
            />
          </div>
        </div>
      </div>

      {/* Pages Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        {pagesLoading ? (
          <div className="p-8 text-center">
            <div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full mx-auto"></div>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Page
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Domain
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Status
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Size
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Links
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Duration
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Crawled At
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {pages.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                        No pages found
                      </td>
                    </tr>
                  ) : (
                    pages.map((page) => (
                      <tr key={page.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2">
                          <div className="max-w-xs">
                            <a
                              href={page.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm font-medium text-primary-600 hover:text-primary-800 truncate block"
                              title={page.url}
                            >
                              {page.title || page.url}
                            </a>
                            <p className="text-xs text-gray-500 truncate" title={page.url}>
                              {page.url}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-600">{page.domain}</td>
                        <td className="px-4 py-2">
                          <span
                            className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                              page.statusCode >= 200 && page.statusCode < 300
                                ? 'bg-green-100 text-green-800'
                                : page.statusCode >= 300 && page.statusCode < 400
                                  ? 'bg-yellow-100 text-yellow-800'
                                  : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {page.statusCode}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-600">
                          {formatBytes(page.contentLength)}
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-600">{page.linksCount}</td>
                        <td className="px-4 py-2 text-sm text-gray-600">
                          {page.crawlDurationMs}ms
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-500">
                          {formatDate(page.crawledAt)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
              <div className="text-sm text-gray-500">
                Showing {offset + 1} to {Math.min(offset + limit, pagesTotal)} of {pagesTotal}
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                  disabled={offset === 0}
                  className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded disabled:opacity-50"
                >
                  Previous
                </button>
                <span className="px-3 py-1 text-sm text-gray-600">
                  Page {currentPage} of {totalPages || 1}
                </span>
                <button
                  onClick={() => setOffset(offset + limit)}
                  disabled={offset + limit >= pagesTotal}
                  className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
