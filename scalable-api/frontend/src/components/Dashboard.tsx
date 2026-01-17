import { useEffect, useCallback } from 'react';
import { useDashboardStore } from '../stores/dashboard';
import { MetricsCard } from './MetricsCard';
import { CircuitBreakersCard } from './CircuitBreakersCard';
import { CacheCard } from './CacheCard';
import { RequestsCard } from './RequestsCard';
import { LoadBalancerCard } from './LoadBalancerCard';
import { ActionsCard } from './ActionsCard';

export function Dashboard() {
  const {
    data,
    loading,
    error,
    lastUpdated,
    autoRefresh,
    refreshInterval,
    fetchDashboard,
    fetchLbStatus,
    setAutoRefresh,
  } = useDashboardStore();

  const refresh = useCallback(() => {
    fetchDashboard();
    fetchLbStatus();
  }, [fetchDashboard, fetchLbStatus]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(refresh, refreshInterval);
    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, refresh]);

  return (
    <div className="space-y-6">
      {/* Header with controls */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
          {lastUpdated && (
            <p className="text-sm text-gray-500">
              Last updated: {lastUpdated.toLocaleTimeString()}
            </p>
          )}
        </div>

        <div className="flex items-center space-x-4">
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            <span className="text-sm text-gray-700">Auto-refresh ({refreshInterval / 1000}s)</span>
          </label>

          <button
            onClick={refresh}
            disabled={loading}
            className="btn btn-primary flex items-center space-x-2"
          >
            {loading ? (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            )}
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      {/* Main stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Uptime"
          value={data?.metrics?.uptime?.human || 'N/A'}
          icon="clock"
        />
        <StatCard
          title="Heap Used"
          value={formatBytes(data?.metrics?.memory?.heapUsed || 0)}
          subtitle={`of ${formatBytes(data?.metrics?.memory?.heapTotal || 0)}`}
          icon="memory"
        />
        <StatCard
          title="Cache Hit Rate"
          value={`${(data?.cache?.hitRate || 0).toFixed(1)}%`}
          subtitle={`${(data?.cache?.localHits || 0) + (data?.cache?.redisHits || 0)} hits, ${data?.cache?.misses || 0} misses`}
          icon="cache"
        />
        <StatCard
          title="Total Requests"
          value={Object.values(data?.metrics?.requests || {}).reduce((sum, r) => sum + r.total, 0).toString()}
          icon="requests"
        />
      </div>

      {/* Detailed cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <MetricsCard data={data?.metrics} />
        <RequestsCard requests={data?.metrics?.requests} durations={data?.metrics?.durations} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <CircuitBreakersCard breakers={data?.circuitBreakers} />
        <CacheCard cache={data?.cache} />
        <ActionsCard />
      </div>

      <LoadBalancerCard />
    </div>
  );
}

interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: string;
}

function StatCard({ title, value, subtitle, icon }: StatCardProps) {
  const iconPath = {
    clock: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
    memory: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z',
    cache: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
    requests: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  }[icon];

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
        </div>
        <div className="p-3 bg-primary-100 rounded-full">
          <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={iconPath} />
          </svg>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
