/**
 * @fileoverview Domains route component for domain-level statistics.
 *
 * The Domains view provides insights into crawling activity at the domain level.
 * It shows:
 * - All domains that have been crawled
 * - Page counts per domain
 * - Crawl delay settings (from robots.txt or defaults)
 * - Allow/block status for each domain
 * - Ability to view cached robots.txt content
 *
 * This view helps operators understand the crawler's reach and compliance
 * with domain-specific crawling policies.
 *
 * @module routes/Domains
 */

import { useEffect, useState } from 'react';
import { useCrawlerStore } from '../stores/crawlerStore';
import { api } from '../services/api';

/**
 * Domains route component for viewing domain-level crawl statistics.
 *
 * Features:
 * - Paginated domain list (25 per page)
 * - Expandable robots.txt viewer for each domain
 * - Color-coded allow/block status
 * - Crawl delay display in seconds
 * - Direct links to domain homepages
 *
 * @returns Paginated domains browser with robots.txt viewer
 */
export function Domains() {
  const { domains, domainsTotal, domainsLoading, fetchDomains } = useCrawlerStore();
  const [offset, setOffset] = useState(0);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [robotsTxt, setRobotsTxt] = useState<string | null>(null);
  const limit = 25;

  useEffect(() => {
    fetchDomains(limit, offset);
  }, [fetchDomains, offset]);

  /**
   * Toggles display of a domain's robots.txt content.
   * Fetches from the API on first view, then caches in component state.
   *
   * @param domain - Domain hostname to fetch robots.txt for
   */
  const handleViewRobots = async (domain: string) => {
    if (selectedDomain === domain) {
      setSelectedDomain(null);
      setRobotsTxt(null);
      return;
    }

    try {
      const result = await api.getDomainRobots(domain);
      setSelectedDomain(domain);
      setRobotsTxt(result.robotsTxt || 'No robots.txt found');
    } catch (error) {
      console.error('Failed to fetch robots.txt:', error);
      setRobotsTxt('Failed to fetch robots.txt');
    }
  };

  const totalPages = Math.ceil(domainsTotal / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Domains</h1>
        <span className="text-sm text-gray-500">{domainsTotal.toLocaleString()} domains</span>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        {domainsLoading ? (
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
                      Domain
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Pages
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Crawl Delay
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Status
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {domains.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                        No domains crawled yet
                      </td>
                    </tr>
                  ) : (
                    domains.map((domain) => (
                      <>
                        <tr key={domain.domain} className="hover:bg-gray-50">
                          <td className="px-4 py-2">
                            <a
                              href={`https://${domain.domain}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm font-medium text-primary-600 hover:text-primary-800"
                            >
                              {domain.domain}
                            </a>
                          </td>
                          <td className="px-4 py-2 text-sm text-gray-600">
                            {domain.pageCount.toLocaleString()}
                          </td>
                          <td className="px-4 py-2 text-sm text-gray-600">
                            {domain.crawlDelay}s
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                                domain.isAllowed
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {domain.isAllowed ? 'Allowed' : 'Blocked'}
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            <button
                              onClick={() => handleViewRobots(domain.domain)}
                              className="text-sm text-primary-600 hover:text-primary-800"
                            >
                              {selectedDomain === domain.domain ? 'Hide' : 'View'} robots.txt
                            </button>
                          </td>
                        </tr>
                        {selectedDomain === domain.domain && (
                          <tr>
                            <td colSpan={5} className="px-4 py-2 bg-gray-50">
                              <pre className="text-xs text-gray-700 whitespace-pre-wrap overflow-x-auto max-h-64">
                                {robotsTxt}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
              <div className="text-sm text-gray-500">
                Showing {offset + 1} to {Math.min(offset + limit, domainsTotal)} of {domainsTotal}
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
                  disabled={offset + limit >= domainsTotal}
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
