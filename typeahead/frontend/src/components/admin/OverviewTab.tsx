import { useState, useEffect } from 'react';
import { api } from '../../services/api';
import type { AnalyticsSummary, SystemStatus } from '../../types';
import { formatUptime, formatBytes } from '../../utils/formatters';
import { StatusCard } from './StatusCard';
import { StatCard } from './StatCard';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';
import { CheckCircleIcon, ServerIcon, DatabaseIcon } from '../icons';

/**
 * OverviewTab - The main dashboard overview tab displaying system status.
 * Shows service health indicators, key metrics, and system resource information.
 * Auto-refreshes data every 10 seconds.
 */
export function OverviewTab() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /**
     * Fetches system status and analytics summary data.
     * Called on mount and every 10 seconds for live updates.
     */
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
      {/* Service status cards */}
      <ServiceStatusSection status={status} />

      {/* Key metrics grid */}
      <MetricsGrid summary={summary} />

      {/* System resources section */}
      <SystemResourcesSection status={status} summary={summary} />
    </div>
  );
}

/**
 * ServiceStatusSection - Displays the health status of core services.
 */
interface ServiceStatusSectionProps {
  status: SystemStatus | null;
}

function ServiceStatusSection({ status }: ServiceStatusSectionProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <StatusCard
        title="System Status"
        value={status?.status || 'Unknown'}
        status={status?.status === 'healthy' ? 'success' : 'warning'}
        icon={<CheckCircleIcon className="w-6 h-6" />}
      />
      <StatusCard
        title="Redis"
        value={status?.services.redis || 'Unknown'}
        status={status?.services.redis === 'connected' ? 'success' : 'error'}
        icon={<ServerIcon className="w-6 h-6" />}
      />
      <StatusCard
        title="PostgreSQL"
        value={status?.services.postgres || 'Unknown'}
        status={status?.services.postgres === 'connected' ? 'success' : 'error'}
        icon={<DatabaseIcon className="w-6 h-6" />}
      />
    </div>
  );
}

/**
 * MetricsGrid - Displays key numeric metrics in a grid layout.
 */
interface MetricsGridProps {
  summary: AnalyticsSummary | null;
}

function MetricsGrid({ summary }: MetricsGridProps) {
  return (
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
  );
}

/**
 * SystemResourcesSection - Displays system resource metrics.
 */
interface SystemResourcesSectionProps {
  status: SystemStatus | null;
  summary: AnalyticsSummary | null;
}

function SystemResourcesSection({ status, summary }: SystemResourcesSectionProps) {
  return (
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
  );
}
