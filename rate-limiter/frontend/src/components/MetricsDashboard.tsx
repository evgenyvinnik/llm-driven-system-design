/**
 * @fileoverview Metrics Dashboard component for displaying rate limiting statistics.
 *
 * Shows aggregated metrics from the last 5 minutes including:
 * - Total, allowed, and denied request counts
 * - Success rate percentage
 * - Average and P99 latency
 * - Active identifier count
 *
 * Auto-refreshes every 2 seconds for near real-time updates.
 */

import { useEffect } from 'react';
import { useRateLimiterStore } from '../stores/rateLimiterStore';

/**
 * Dashboard component showing rate limiting metrics.
 * Displays key performance indicators in a grid layout.
 *
 * @returns Metrics dashboard with auto-refreshing statistics
 */
export function MetricsDashboard() {
  const { metrics, fetchMetrics } = useRateLimiterStore();

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 2000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  if (!metrics) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Metrics</h2>
        <p className="text-gray-600">Loading metrics...</p>
      </div>
    );
  }

  const successRate =
    metrics.totalRequests > 0
      ? ((metrics.allowedRequests / metrics.totalRequests) * 100).toFixed(1)
      : '0';

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Metrics (Last 5 Minutes)</h2>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <MetricCard label="Total Requests" value={metrics.totalRequests.toLocaleString()} />
        <MetricCard
          label="Allowed"
          value={metrics.allowedRequests.toLocaleString()}
          color="green"
        />
        <MetricCard
          label="Denied"
          value={metrics.deniedRequests.toLocaleString()}
          color="red"
        />
        <MetricCard label="Success Rate" value={`${successRate}%`} />
        <MetricCard
          label="Avg Latency"
          value={`${metrics.averageLatencyMs.toFixed(2)}ms`}
        />
        <MetricCard
          label="P99 Latency"
          value={`${metrics.p99LatencyMs.toFixed(2)}ms`}
        />
      </div>
      <div className="mt-4 pt-4 border-t">
        <p className="text-sm text-gray-600">
          Active Identifiers: <span className="font-medium">{metrics.activeIdentifiers}</span>
        </p>
      </div>
    </div>
  );
}

/**
 * Props for the MetricCard component.
 */
interface MetricCardProps {
  /** Label text displayed above the value */
  label: string;
  /** Value to display */
  value: string;
  /** Color theme for the value text */
  color?: 'green' | 'red' | 'default';
}

/**
 * Individual metric card for displaying a single statistic.
 * Used within the MetricsDashboard grid.
 *
 * @param props - Card properties
 * @returns Styled metric card
 */
function MetricCard({ label, value, color = 'default' }: MetricCardProps) {
  const colorClasses = {
    green: 'text-green-600',
    red: 'text-red-600',
    default: 'text-gray-900',
  };

  return (
    <div className="bg-gray-50 rounded p-3">
      <p className="text-xs text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold ${colorClasses[color]}`}>{value}</p>
    </div>
  );
}
