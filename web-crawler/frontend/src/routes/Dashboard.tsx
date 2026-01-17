/**
 * @fileoverview Dashboard route component for the web crawler.
 *
 * The Dashboard is the main landing page that provides a real-time overview
 * of the crawler's activity and performance. It displays:
 * - Crawl statistics (pages crawled, failed, links discovered)
 * - Frontier status (pending, in-progress, completed URLs)
 * - Worker health and heartbeat status
 * - Top domains by page count
 * - Recently crawled pages
 *
 * The dashboard auto-polls the API every 5 seconds to provide live updates.
 *
 * @module routes/Dashboard
 */

import { useEffect } from 'react';
import { useCrawlerStore } from '../stores/crawlerStore';
import { StatCard } from '../components/StatCard';
import { RecentPagesTable } from '../components/RecentPagesTable';
import { WorkerStatus } from '../components/WorkerStatus';

/**
 * Dashboard route component displaying real-time crawler statistics.
 *
 * Features:
 * - Auto-polling for live updates (5-second interval)
 * - Loading skeleton while fetching initial data
 * - Responsive grid layout for stat cards
 * - Worker health monitoring
 * - Top domains visualization
 * - Recent pages table with status badges
 *
 * @returns Dashboard page with live crawler metrics
 */
export function Dashboard() {
  const { stats, statsLoading, fetchStats, startPolling, stopPolling } = useCrawlerStore();

  useEffect(() => {
    fetchStats();
    startPolling();
    return () => stopPolling();
  }, [fetchStats, startPolling, stopPolling]);

  /**
   * Formats byte count into human-readable string.
   * Uses decimal units (KB, MB, GB) for display.
   *
   * @param bytes - Raw byte count
   * @returns Formatted string with appropriate unit
   */
  const formatBytes = (bytes: number): string => {
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
    if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(2)} KB`;
    return `${bytes} B`;
  };

  if (statsLoading && !stats) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Crawler Dashboard</h1>
        <div className="flex items-center space-x-2">
          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
          <span className="text-sm text-gray-600">Live</span>
        </div>
      </div>

      {/* Crawl Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Pages Crawled"
          value={stats?.pagesCrawled ?? 0}
          color="green"
        />
        <StatCard
          title="Pages Failed"
          value={stats?.pagesFailed ?? 0}
          color="red"
        />
        <StatCard
          title="Links Discovered"
          value={stats?.linksDiscovered ?? 0}
          color="blue"
        />
        <StatCard
          title="Duplicates Skipped"
          value={stats?.duplicatesSkipped ?? 0}
          color="gray"
        />
      </div>

      {/* Frontier Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          title="Pending URLs"
          value={stats?.frontierPending ?? 0}
          color="yellow"
        />
        <StatCard
          title="In Progress"
          value={stats?.frontierInProgress ?? 0}
          color="blue"
        />
        <StatCard
          title="Completed"
          value={stats?.frontierCompleted ?? 0}
          color="green"
        />
        <StatCard
          title="Failed"
          value={stats?.frontierFailed ?? 0}
          color="red"
        />
        <StatCard
          title="Total Domains"
          value={stats?.totalDomains ?? 0}
          color="purple"
        />
      </div>

      {/* Data Downloaded */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <StatCard
            title="Data Downloaded"
            value={formatBytes(stats?.bytesDownloaded ?? 0)}
            color="blue"
          />
        </div>
        <div className="lg:col-span-2">
          <WorkerStatus
            workers={stats?.activeWorkers ?? []}
            heartbeats={stats?.workerHeartbeats ?? []}
          />
        </div>
      </div>

      {/* Top Domains */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <h3 className="text-sm font-medium text-gray-900 mb-3">Top Domains by Pages</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {stats?.topDomains?.slice(0, 10).map((domain) => (
            <div
              key={domain.domain}
              className="p-2 bg-gray-50 rounded text-sm"
            >
              <div className="font-medium text-gray-800 truncate" title={domain.domain}>
                {domain.domain}
              </div>
              <div className="text-gray-500">{domain.pageCount} pages</div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Pages */}
      <RecentPagesTable pages={stats?.recentPages ?? []} loading={statsLoading} />
    </div>
  );
}
