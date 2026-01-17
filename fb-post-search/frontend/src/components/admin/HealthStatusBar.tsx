/**
 * @fileoverview System health status bar component.
 * Displays health indicators for backend services and provides reindex functionality.
 */

import { Activity, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';

/**
 * Health status data for backend services.
 */
export interface HealthStatus {
  /** Overall system status */
  status: string;
  /** PostgreSQL connection status */
  postgres: boolean;
  /** Elasticsearch connection status */
  elasticsearch: boolean;
  /** Redis connection status */
  redis: boolean;
}

/**
 * Props for the HealthStatusBar component.
 */
interface HealthStatusBarProps {
  /** Current health status of all services */
  health: HealthStatus;
  /** Whether a reindex operation is in progress */
  isReindexing: boolean;
  /** Callback to trigger post reindexing */
  onReindex: () => void;
}

/**
 * Props for the HealthIndicator sub-component.
 */
interface HealthIndicatorProps {
  /** Service name to display */
  label: string;
  /** Whether the service is healthy */
  status: boolean;
}

/**
 * Displays a single service health indicator with icon and label.
 * Shows green check for healthy services, red alert for unhealthy ones.
 *
 * @param props - HealthIndicator props
 * @returns Health indicator with icon and label
 */
function HealthIndicator({ label, status }: HealthIndicatorProps) {
  return (
    <div className="flex items-center gap-1.5">
      {status ? (
        <CheckCircle className="w-4 h-4 text-green-500" />
      ) : (
        <AlertCircle className="w-4 h-4 text-red-500" />
      )}
      <span className={`text-sm ${status ? 'text-green-600' : 'text-red-600'}`}>
        {label}
      </span>
    </div>
  );
}

/**
 * Renders the system health status bar with service indicators and reindex button.
 * Shows PostgreSQL, Elasticsearch, and Redis connection statuses.
 *
 * @param props - HealthStatusBar props
 * @returns Health status bar with indicators and reindex action
 */
export function HealthStatusBar({ health, isReindexing, onReindex }: HealthStatusBarProps) {
  return (
    <div className="mb-6 p-4 bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="flex items-center gap-4">
        <Activity className="w-5 h-5 text-gray-500" />
        <span className="font-medium text-gray-700">System Health:</span>
        <div className="flex items-center gap-4">
          <HealthIndicator label="PostgreSQL" status={health.postgres} />
          <HealthIndicator label="Elasticsearch" status={health.elasticsearch} />
          <HealthIndicator label="Redis" status={health.redis} />
        </div>
        <button
          onClick={onReindex}
          disabled={isReindexing}
          className="ml-auto flex items-center gap-2 px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isReindexing ? 'animate-spin' : ''}`} />
          {isReindexing ? 'Reindexing...' : 'Reindex Posts'}
        </button>
      </div>
    </div>
  );
}
