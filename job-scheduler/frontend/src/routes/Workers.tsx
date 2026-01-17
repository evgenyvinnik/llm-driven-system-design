/**
 * Workers monitoring page showing active and historical worker status.
 * Displays worker metrics and detailed status table.
 * @module routes/Workers
 */

import { useEffect } from 'react';
import { useMetricsStore } from '../stores';
import { Spinner, MetricCard } from '../components/UI';
import { Worker } from '../types';

/**
 * Workers status page with real-time updates.
 * Shows worker activity, job counts, and heartbeat status.
 * Auto-refreshes every 5 seconds.
 */
export function WorkersPage() {
  const { workers, loading, fetchWorkers } = useMetricsStore();

  useEffect(() => {
    fetchWorkers();

    // Auto-refresh every 5 seconds
    const interval = setInterval(fetchWorkers, 5000);
    return () => clearInterval(interval);
  }, [fetchWorkers]);

  if (loading && workers.length === 0) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  const activeWorkers = workers.filter((w) => {
    const lastHeartbeat = new Date(w.last_heartbeat);
    return Date.now() - lastHeartbeat.getTime() < 60000;
  });

  const totalCompleted = workers.reduce((sum, w) => sum + w.jobs_completed, 0);
  const totalFailed = workers.reduce((sum, w) => sum + w.jobs_failed, 0);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Workers</h1>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard title="Active Workers" value={activeWorkers.length} />
        <MetricCard title="Total Workers" value={workers.length} />
        <MetricCard title="Total Completed" value={totalCompleted} />
        <MetricCard title="Total Failed" value={totalFailed} />
      </div>

      {workers.length > 0 ? (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-300">
            <thead className="bg-gray-50">
              <tr>
                <th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900">
                  Worker ID
                </th>
                <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                  Status
                </th>
                <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                  Active Jobs
                </th>
                <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                  Completed
                </th>
                <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                  Failed
                </th>
                <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                  Last Heartbeat
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {workers.map((worker: Worker) => {
                const lastHeartbeat = new Date(worker.last_heartbeat);
                const isActive = Date.now() - lastHeartbeat.getTime() < 60000;
                const status = !isActive ? 'offline' : worker.status;

                return (
                  <tr key={worker.id}>
                    <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-mono text-gray-900">
                      {worker.id}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          status === 'offline'
                            ? 'bg-gray-100 text-gray-800'
                            : status === 'busy'
                            ? 'bg-yellow-100 text-yellow-800'
                            : 'bg-green-100 text-green-800'
                        }`}
                      >
                        {status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-900">
                      {worker.active_jobs || 0}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-green-600">
                      {worker.jobs_completed}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-red-600">
                      {worker.jobs_failed}
                    </td>
                    <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                      {lastHeartbeat.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-12 bg-white shadow rounded-lg">
          <h3 className="text-lg font-medium text-gray-900 mb-2">No workers found</h3>
          <p className="text-gray-500">
            Start a worker using <code className="font-mono bg-gray-100 px-2 py-1 rounded">npm run dev:worker1</code>
          </p>
        </div>
      )}
    </div>
  );
}
