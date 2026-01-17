/**
 * @fileoverview Health Status component for displaying backend service health.
 *
 * Shows Redis connection status, ping latency, and server uptime.
 * Auto-refreshes every 5 seconds to provide real-time health monitoring.
 */

import { useEffect } from 'react';
import { useRateLimiterStore } from '../stores/rateLimiterStore';

/**
 * Displays the current health status of the rate limiter backend.
 * Uses color coding to indicate healthy (green) or unhealthy (red) status.
 *
 * @returns Health status card with connection details
 */
export function HealthStatus() {
  const { health, fetchHealth } = useRateLimiterStore();

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  if (!health) {
    return (
      <div className="bg-gray-200 rounded-lg p-4">
        <p className="text-gray-600">Loading health status...</p>
      </div>
    );
  }

  const isHealthy = health.status === 'healthy';

  return (
    <div className={`rounded-lg p-4 ${isHealthy ? 'bg-green-100' : 'bg-red-100'}`}>
      <div className="flex items-center gap-2">
        <div
          className={`w-3 h-3 rounded-full ${isHealthy ? 'bg-green-500' : 'bg-red-500'}`}
        />
        <h3 className="font-semibold">
          {isHealthy ? 'System Healthy' : 'System Unhealthy'}
        </h3>
      </div>
      <div className="mt-2 text-sm space-y-1">
        <p>
          <span className="text-gray-600">Redis:</span>{' '}
          {health.redis.connected ? (
            <span className="text-green-700">Connected ({health.redis.pingMs}ms ping)</span>
          ) : (
            <span className="text-red-700">Disconnected - {health.redis.error}</span>
          )}
        </p>
        <p>
          <span className="text-gray-600">Uptime:</span>{' '}
          {Math.floor(health.uptime / 60)} minutes
        </p>
      </div>
    </div>
  );
}
