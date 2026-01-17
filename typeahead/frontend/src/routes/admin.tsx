import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import type { AnalyticsSummary, HourlyStats, TopPhrase, SystemStatus } from '../types';

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});

function AdminPage() {
  const [activeTab, setActiveTab] = useState<'overview' | 'analytics' | 'management'>('overview');

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
        <p className="text-gray-600 mt-2">Monitor and manage the typeahead service</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="-mb-px flex space-x-8">
          <TabButton
            active={activeTab === 'overview'}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </TabButton>
          <TabButton
            active={activeTab === 'analytics'}
            onClick={() => setActiveTab('analytics')}
          >
            Analytics
          </TabButton>
          <TabButton
            active={activeTab === 'management'}
            onClick={() => setActiveTab('management')}
          >
            Management
          </TabButton>
        </nav>
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && <OverviewTab />}
      {activeTab === 'analytics' && <AnalyticsTab />}
      {activeTab === 'management' && <ManagementTab />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`py-4 px-1 border-b-2 font-medium text-sm ${
        active
          ? 'border-blue-500 text-blue-600'
          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
      }`}
    >
      {children}
    </button>
  );
}

function OverviewTab() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statusData, summaryData] = await Promise.all([
          api.getSystemStatus(),
          api.getAnalyticsSummary(),
        ]);
        setStatus(statusData);
        setSummary(summaryData);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  if (isLoading) {
    return <LoadingState />;
  }

  if (error) {
    return <ErrorState message={error} />;
  }

  return (
    <div className="space-y-6">
      {/* Status cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatusCard
          title="System Status"
          value={status?.status || 'Unknown'}
          status={status?.status === 'healthy' ? 'success' : 'warning'}
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <StatusCard
          title="Redis"
          value={status?.services.redis || 'Unknown'}
          status={status?.services.redis === 'connected' ? 'success' : 'error'}
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
          }
        />
        <StatusCard
          title="PostgreSQL"
          value={status?.services.postgres || 'Unknown'}
          status={status?.services.postgres === 'connected' ? 'success' : 'error'}
          icon={
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
          }
        />
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total Phrases"
          value={summary?.trie.phraseCount.toLocaleString() || '0'}
        />
        <StatCard
          label="Trie Nodes"
          value={summary?.trie.nodeCount.toLocaleString() || '0'}
        />
        <StatCard
          label="Today's Queries"
          value={summary?.today.totalQueries.toLocaleString() || '0'}
        />
        <StatCard
          label="Unique Users Today"
          value={summary?.today.uniqueUsers.toLocaleString() || '0'}
        />
      </div>

      {/* Memory & Uptime */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="font-semibold text-gray-900 mb-4">System Resources</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-gray-500">Uptime</p>
            <p className="text-lg font-medium">
              {formatUptime(status?.uptime || 0)}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Heap Used</p>
            <p className="text-lg font-medium">
              {formatBytes(status?.memory.heapUsed || 0)}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Buffer Size</p>
            <p className="text-lg font-medium">
              {summary?.aggregation.bufferSize || 0}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Aggregation</p>
            <p className="text-lg font-medium">
              {summary?.aggregation.isRunning ? 'Running' : 'Stopped'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function AnalyticsTab() {
  const [hourly, setHourly] = useState<HourlyStats[]>([]);
  const [topPhrases, setTopPhrases] = useState<TopPhrase[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [hourlyData, phrasesData] = await Promise.all([
          api.getHourlyStats(),
          api.getTopPhrases(20),
        ]);
        setHourly(hourlyData.hourly);
        setTopPhrases(phrasesData.phrases);
      } catch (err) {
        console.error('Failed to load analytics:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-6">
      {/* Hourly chart */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Query Volume (Last 24 Hours)</h3>
        {hourly.length > 0 ? (
          <div className="h-64 flex items-end gap-1">
            {hourly.slice(0, 24).reverse().map((h, i) => {
              const maxCount = Math.max(...hourly.map(x => x.queryCount));
              const height = maxCount > 0 ? (h.queryCount / maxCount) * 100 : 0;
              return (
                <div
                  key={i}
                  className="flex-1 bg-blue-500 rounded-t hover:bg-blue-600 transition-colors cursor-pointer group relative"
                  style={{ height: `${Math.max(height, 2)}%` }}
                >
                  <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                    {h.queryCount} queries
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-gray-500 text-center py-8">No data yet</p>
        )}
      </div>

      {/* Top phrases */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Top Phrases</h3>
        {topPhrases.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left border-b">
                  <th className="pb-3 text-sm font-medium text-gray-500">Rank</th>
                  <th className="pb-3 text-sm font-medium text-gray-500">Phrase</th>
                  <th className="pb-3 text-sm font-medium text-gray-500 text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {topPhrases.map((phrase, index) => (
                  <tr key={phrase.phrase} className="border-b last:border-0">
                    <td className="py-3 text-sm text-gray-500">{index + 1}</td>
                    <td className="py-3 text-sm text-gray-900">{phrase.phrase}</td>
                    <td className="py-3 text-sm text-gray-600 text-right">
                      {phrase.count.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-500 text-center py-8">No phrases yet</p>
        )}
      </div>
    </div>
  );
}

function ManagementTab() {
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [newPhrase, setNewPhrase] = useState('');
  const [newCount, setNewCount] = useState('1');
  const [filterPhrase, setFilterPhrase] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  };

  const handleRebuildTrie = async () => {
    if (!confirm('Are you sure you want to rebuild the trie? This may take a few seconds.')) {
      return;
    }

    setIsRebuilding(true);
    try {
      const result = await api.rebuildTrie();
      showMessage('success', result.message);
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to rebuild trie');
    } finally {
      setIsRebuilding(false);
    }
  };

  const handleClearCache = async () => {
    setIsClearing(true);
    try {
      const result = await api.clearCache();
      showMessage('success', result.message);
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to clear cache');
    } finally {
      setIsClearing(false);
    }
  };

  const handleAddPhrase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPhrase.trim()) return;

    try {
      await api.addPhrase(newPhrase.trim(), parseInt(newCount) || 1);
      showMessage('success', `Added phrase: ${newPhrase}`);
      setNewPhrase('');
      setNewCount('1');
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to add phrase');
    }
  };

  const handleFilterPhrase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!filterPhrase.trim()) return;

    try {
      await api.filterPhrase(filterPhrase.trim());
      showMessage('success', `Filtered phrase: ${filterPhrase}`);
      setFilterPhrase('');
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to filter phrase');
    }
  };

  return (
    <div className="space-y-6">
      {/* Message */}
      {message && (
        <div
          className={`p-4 rounded-lg ${
            message.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Actions */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="font-semibold text-gray-900 mb-4">System Actions</h3>
        <div className="flex flex-wrap gap-4">
          <button
            onClick={handleRebuildTrie}
            disabled={isRebuilding}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRebuilding ? 'Rebuilding...' : 'Rebuild Trie'}
          </button>
          <button
            onClick={handleClearCache}
            disabled={isClearing}
            className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isClearing ? 'Clearing...' : 'Clear Cache'}
          </button>
        </div>
      </div>

      {/* Add phrase */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Add Phrase</h3>
        <form onSubmit={handleAddPhrase} className="flex flex-wrap gap-4">
          <input
            type="text"
            value={newPhrase}
            onChange={(e) => setNewPhrase(e.target.value)}
            placeholder="Phrase"
            className="flex-1 min-w-[200px] px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="number"
            value={newCount}
            onChange={(e) => setNewCount(e.target.value)}
            placeholder="Count"
            className="w-24 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
          >
            Add
          </button>
        </form>
      </div>

      {/* Filter phrase */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="font-semibold text-gray-900 mb-4">Filter Phrase</h3>
        <p className="text-sm text-gray-500 mb-4">
          Remove inappropriate or unwanted phrases from suggestions
        </p>
        <form onSubmit={handleFilterPhrase} className="flex flex-wrap gap-4">
          <input
            type="text"
            value={filterPhrase}
            onChange={(e) => setFilterPhrase(e.target.value)}
            placeholder="Phrase to filter"
            className="flex-1 min-w-[200px] px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
          >
            Filter
          </button>
        </form>
      </div>
    </div>
  );
}

function StatusCard({
  title,
  value,
  status,
  icon,
}: {
  title: string;
  value: string;
  status: 'success' | 'warning' | 'error';
  icon: React.ReactNode;
}) {
  const colors = {
    success: 'bg-green-50 text-green-600',
    warning: 'bg-yellow-50 text-yellow-600',
    error: 'bg-red-50 text-red-600',
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center gap-4">
        <div className={`p-3 rounded-lg ${colors[status]}`}>{icon}</div>
        <div>
          <p className="text-sm text-gray-500">{title}</p>
          <p className="text-lg font-semibold text-gray-900 capitalize">{value}</p>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
      <p className="text-red-600">{message}</p>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) {
    return `${(bytes / 1073741824).toFixed(1)} GB`;
  }
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}
