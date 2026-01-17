/**
 * @fileoverview Frontier route component for URL queue management.
 *
 * The Frontier page displays and manages the URL queue (frontier) of the crawler.
 * It allows operators to:
 * - View URLs by status (pending, in_progress, completed, failed)
 * - Add new URLs to the crawl queue
 * - Monitor URL metadata (priority, depth, domain)
 *
 * The frontier is a core concept in web crawling - it represents all discovered
 * URLs that are scheduled for crawling, organized by priority and status.
 *
 * @module routes/Frontier
 */

import { useEffect, useState } from 'react';
import { useCrawlerStore } from '../stores/crawlerStore';
import { AddUrlsForm } from '../components/AddUrlsForm';

/**
 * Frontier route component for managing the URL crawl queue.
 *
 * Displays a filterable list of frontier URLs with their metadata:
 * - Priority level (high/medium/low)
 * - Crawl depth from seed URL
 * - Current status
 * - Domain information
 *
 * Includes an AddUrlsForm for adding new URLs to the queue.
 *
 * @returns Frontier management page
 */
export function Frontier() {
  const { frontierUrls, frontierLoading, fetchFrontierUrls, addUrls } = useCrawlerStore();
  const [filter, setFilter] = useState<string>('pending');

  useEffect(() => {
    fetchFrontierUrls(filter);
  }, [fetchFrontierUrls, filter]);

  /**
   * Handles adding URLs to the frontier.
   * Delegates to the store's addUrls action.
   *
   * @param urls - Array of URL strings to add
   * @param priority - Optional priority level (1-3)
   */
  const handleAddUrls = async (urls: string[], priority?: number) => {
    await addUrls(urls, priority);
  };

  /**
   * Renders a colored badge for priority level.
   * High priority (3) is red, medium (2) is yellow, low (1) is gray.
   *
   * @param priority - Priority level (1, 2, or 3)
   * @returns JSX badge element with appropriate color
   */
  const getPriorityBadge = (priority: number) => {
    const colors = {
      3: 'bg-red-100 text-red-800',
      2: 'bg-yellow-100 text-yellow-800',
      1: 'bg-gray-100 text-gray-800',
    };
    const labels = { 3: 'High', 2: 'Medium', 1: 'Low' };
    return (
      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${colors[priority as keyof typeof colors] || colors[1]}`}>
        {labels[priority as keyof typeof labels] || 'Low'}
      </span>
    );
  };

  /**
   * Renders a colored badge for URL status.
   * Each status has a distinct color for quick visual identification.
   *
   * @param status - URL status (pending, in_progress, completed, failed)
   * @returns JSX badge element with status-appropriate color
   */
  const getStatusBadge = (status: string) => {
    const colors: Record<string, string> = {
      pending: 'bg-yellow-100 text-yellow-800',
      in_progress: 'bg-blue-100 text-blue-800',
      completed: 'bg-green-100 text-green-800',
      failed: 'bg-red-100 text-red-800',
    };
    return (
      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${colors[status] || colors.pending}`}>
        {status.replace('_', ' ')}
      </span>
    );
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">URL Frontier</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Add URLs Form */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h2 className="text-lg font-medium text-gray-900 mb-4">Add URLs</h2>
          <AddUrlsForm onSubmit={handleAddUrls} />
        </div>

        {/* URL List */}
        <div className="lg:col-span-2 bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="p-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-lg font-medium text-gray-900">Frontier URLs</h2>
            <div className="flex space-x-2">
              {['pending', 'in_progress', 'completed', 'failed'].map((status) => (
                <button
                  key={status}
                  onClick={() => setFilter(status)}
                  className={`px-3 py-1 text-sm rounded-md ${
                    filter === status
                      ? 'bg-primary-100 text-primary-700'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {status.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            {frontierLoading ? (
              <div className="p-8 text-center">
                <div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full mx-auto"></div>
              </div>
            ) : (
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
                      Priority
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Depth
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {frontierUrls.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                        No URLs in frontier with status: {filter}
                      </td>
                    </tr>
                  ) : (
                    frontierUrls.map((url) => (
                      <tr key={url.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2">
                          <a
                            href={url.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-primary-600 hover:text-primary-800 max-w-md truncate block"
                            title={url.url}
                          >
                            {url.url}
                          </a>
                        </td>
                        <td className="px-4 py-2 text-sm text-gray-600">{url.domain}</td>
                        <td className="px-4 py-2">{getPriorityBadge(url.priority)}</td>
                        <td className="px-4 py-2 text-sm text-gray-600">{url.depth}</td>
                        <td className="px-4 py-2">{getStatusBadge(url.status)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
