import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import {
  Search,
  Database,
  Activity,
  FileText,
  Link2,
  BarChart3,
  Play,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { adminApi } from '@/services/api';
import type { SystemStats } from '@/types';

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});

function AdminPage() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [seedUrls, setSeedUrls] = useState('');

  const loadStats = async () => {
    setIsLoading(true);
    try {
      const data = await adminApi.getStats();
      setStats(data);
    } catch (error) {
      console.error('Failed to load stats:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  const handleAction = async (
    action: () => Promise<{ message: string }>,
    successMessage: string
  ) => {
    try {
      setActionStatus('Processing...');
      const result = await action();
      setActionStatus(result.message || successMessage);
      setTimeout(() => loadStats(), 2000);
    } catch (error) {
      setActionStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleSeedUrls = async () => {
    const urls = seedUrls
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    if (urls.length === 0) {
      setActionStatus('Please enter at least one URL');
      return;
    }
    await handleAction(() => adminApi.seedUrls(urls), 'URLs added to frontier');
    setSeedUrls('');
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-search-blue flex items-center justify-center">
                <Search className="w-4 h-4 text-white" />
              </div>
              <span className="text-xl font-medium">Admin Dashboard</span>
            </Link>
          </div>
          <button
            onClick={loadStats}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Status message */}
        {actionStatus && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg text-blue-800">
            {actionStatus}
            <button
              onClick={() => setActionStatus(null)}
              className="ml-4 text-blue-600 hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Stats cards */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 text-search-blue animate-spin" />
          </div>
        ) : stats ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
              <StatCard
                icon={<Database className="w-6 h-6 text-blue-600" />}
                title="Total URLs"
                value={parseInt(stats.index.urls.total).toLocaleString()}
                subtitle={`${stats.index.urls.crawled} crawled, ${stats.index.urls.pending} pending`}
              />
              <StatCard
                icon={<FileText className="w-6 h-6 text-green-600" />}
                title="Documents"
                value={parseInt(stats.index.documents.total).toLocaleString()}
                subtitle={`Avg. ${Math.round(parseFloat(stats.index.documents.avg_content_length || '0'))} chars`}
              />
              <StatCard
                icon={<Link2 className="w-6 h-6 text-purple-600" />}
                title="Links"
                value={parseInt(stats.index.links.total).toLocaleString()}
                subtitle="Extracted links"
              />
              <StatCard
                icon={<Activity className="w-6 h-6 text-orange-600" />}
                title="Queries"
                value={parseInt(stats.queries.total_queries || '0').toLocaleString()}
                subtitle={`Avg. ${Math.round(parseFloat(stats.queries.avg_duration || '0'))}ms`}
              />
            </div>

            {/* Top pages by PageRank */}
            {stats.pageRank.topPages.length > 0 && (
              <div className="bg-white rounded-lg border border-gray-200 p-6 mb-8">
                <h2 className="text-lg font-medium mb-4 flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-gray-500" />
                  Top Pages by PageRank
                </h2>
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-sm text-gray-500 border-b">
                      <th className="pb-2">Title</th>
                      <th className="pb-2">URL</th>
                      <th className="pb-2 text-right">PageRank</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.pageRank.topPages.map((page) => (
                      <tr key={page.id} className="border-b last:border-0">
                        <td className="py-3 text-sm font-medium">
                          {page.title || 'Untitled'}
                        </td>
                        <td className="py-3 text-sm text-gray-500 truncate max-w-xs">
                          {page.url}
                        </td>
                        <td className="py-3 text-sm text-right font-mono">
                          {(parseFloat(page.page_rank) * 100).toFixed(4)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-12 text-gray-500">
            Failed to load statistics. Make sure the backend is running.
          </div>
        )}

        {/* Actions */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Seed URLs */}
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h2 className="text-lg font-medium mb-4">Add Seed URLs</h2>
            <textarea
              value={seedUrls}
              onChange={(e) => setSeedUrls(e.target.value)}
              placeholder="Enter URLs (one per line)&#10;https://example.com&#10;https://another-site.com"
              className="w-full h-32 p-3 border border-gray-300 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-search-blue"
            />
            <button
              onClick={handleSeedUrls}
              className="mt-4 flex items-center gap-2 px-4 py-2 bg-search-blue text-white rounded-lg hover:bg-search-blueHover"
            >
              <Play className="w-4 h-4" />
              Add URLs
            </button>
          </div>

          {/* Quick actions */}
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h2 className="text-lg font-medium mb-4">Quick Actions</h2>
            <div className="space-y-3">
              <ActionButton
                label="Start Crawler"
                description="Crawl pending URLs in the frontier"
                onClick={() => handleAction(() => adminApi.startCrawl(100), 'Crawler started')}
              />
              <ActionButton
                label="Build Index"
                description="Index crawled documents in Elasticsearch"
                onClick={() => handleAction(() => adminApi.buildIndex(), 'Indexing started')}
              />
              <ActionButton
                label="Calculate PageRank"
                description="Run PageRank algorithm on link graph"
                onClick={() =>
                  handleAction(() => adminApi.calculatePageRank(), 'PageRank calculation started')
                }
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function StatCard({
  icon,
  title,
  value,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  subtitle: string;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-center gap-3 mb-3">
        {icon}
        <span className="text-sm text-gray-500">{title}</span>
      </div>
      <p className="text-3xl font-semibold text-gray-900">{value}</p>
      <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
    </div>
  );
}

function ActionButton({
  label,
  description,
  onClick,
}: {
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between p-4 border border-gray-200 rounded-lg hover:bg-gray-50 text-left"
    >
      <div>
        <p className="font-medium text-gray-900">{label}</p>
        <p className="text-sm text-gray-500">{description}</p>
      </div>
      <Play className="w-5 h-5 text-gray-400" />
    </button>
  );
}
