import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAdminStore } from '../../stores/adminStore';

function AdminOverview() {
  const { stats, fetchStats, isLoading } = useAdminStore();
  const [timeRange, setTimeRange] = useState('24 hours');

  useEffect(() => {
    fetchStats(timeRange);
  }, [fetchStats, timeRange]);

  if (isLoading && !stats) {
    return <div className="text-center py-12 text-gray-500">Loading stats...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Time Range Selector */}
      <div className="flex justify-end">
        <select
          value={timeRange}
          onChange={(e) => setTimeRange(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm"
        >
          <option value="1 hour">Last hour</option>
          <option value="24 hours">Last 24 hours</option>
          <option value="7 days">Last 7 days</option>
          <option value="30 days">Last 30 days</option>
        </select>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm font-medium text-gray-500">Total Notifications</div>
          <div className="mt-2 text-3xl font-bold text-gray-900">{stats?.notifications.total || 0}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm font-medium text-gray-500">Delivered</div>
          <div className="mt-2 text-3xl font-bold text-green-600">{stats?.notifications.delivered || 0}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm font-medium text-gray-500">Pending</div>
          <div className="mt-2 text-3xl font-bold text-yellow-600">{stats?.notifications.pending || 0}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm font-medium text-gray-500">Failed</div>
          <div className="mt-2 text-3xl font-bold text-red-600">{stats?.notifications.failed || 0}</div>
        </div>
      </div>

      {/* User Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm font-medium text-gray-500">Total Users</div>
          <div className="mt-2 text-3xl font-bold text-gray-900">{stats?.users.total_users || 0}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <div className="text-sm font-medium text-gray-500">New Users ({timeRange})</div>
          <div className="mt-2 text-3xl font-bold text-indigo-600">{stats?.users.new_users || 0}</div>
        </div>
      </div>

      {/* Delivery by Channel */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">Delivery by Channel</h3>
        {stats?.deliveryByChannel && Object.keys(stats.deliveryByChannel).length > 0 ? (
          <div className="grid grid-cols-3 gap-4">
            {Object.entries(stats.deliveryByChannel).map(([channel, statuses]) => (
              <div key={channel} className="border rounded-lg p-4">
                <div className="text-sm font-medium text-gray-500 capitalize mb-2">{channel}</div>
                <div className="space-y-1">
                  {Object.entries(statuses as Record<string, number>).map(([status, count]) => (
                    <div key={status} className="flex justify-between text-sm">
                      <span className="capitalize">{status}</span>
                      <span className="font-medium">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-gray-500 text-sm">No delivery data available</div>
        )}
      </div>

      {/* Queue Depth */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">Queue Depth</h3>
        {stats?.queueDepth && Object.keys(stats.queueDepth).length > 0 ? (
          <div className="grid grid-cols-3 gap-4">
            {Object.entries(stats.queueDepth).map(([channel, priorities]) => (
              <div key={channel} className="border rounded-lg p-4">
                <div className="text-sm font-medium text-gray-500 capitalize mb-2">{channel}</div>
                <div className="space-y-1">
                  {Object.entries(priorities as Record<string, number>).map(([priority, count]) => (
                    <div key={priority} className="flex justify-between text-sm">
                      <span className="capitalize">{priority}</span>
                      <span className={`font-medium ${count > 0 ? 'text-yellow-600' : 'text-gray-400'}`}>{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-gray-500 text-sm">No queue data available</div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/admin/')({
  component: AdminOverview,
});
