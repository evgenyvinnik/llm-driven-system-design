import { useEffect, useState } from 'react';
import { adminApi } from '../services/api';
import { AdminStats } from '../types';

export function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const data = await adminApi.getStats() as AdminStats;
        setStats(data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="spinner"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center text-apple-red">
        <p>Failed to load admin stats: {error}</p>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-2xl font-semibold text-gray-800">Admin Dashboard</h2>

      {/* Overview Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Total Users"
          value={stats.users.total}
          subtitle={`${stats.users.thisWeek} this week`}
          icon="&#128101;"
        />
        <StatCard
          title="Active Devices"
          value={stats.devices.active}
          subtitle={`${stats.devices.total} total`}
          icon="&#128205;"
        />
        <StatCard
          title="Lost Devices"
          value={stats.lostMode.active}
          subtitle="In lost mode"
          icon="&#128270;"
          highlight
        />
        <StatCard
          title="Location Reports"
          value={stats.reports.last24h}
          subtitle="Last 24 hours"
          icon="&#127760;"
        />
      </div>

      {/* Device Types */}
      <div className="bg-white rounded-xl p-6 shadow">
        <h3 className="text-lg font-medium mb-4">Devices by Type</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {Object.entries(stats.devices.byType).map(([type, count]) => (
            <div
              key={type}
              className="text-center p-4 bg-gray-50 rounded-lg"
            >
              <div className="text-2xl mb-1">
                {type === 'airtag' && '&#9898;'}
                {type === 'iphone' && '&#128241;'}
                {type === 'macbook' && '&#128187;'}
                {type === 'ipad' && '&#128241;'}
                {type === 'airpods' && '&#127911;'}
              </div>
              <div className="text-xl font-semibold">{count}</div>
              <div className="text-sm text-gray-500 capitalize">{type}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Anti-Stalking Stats */}
      <div className="bg-white rounded-xl p-6 shadow">
        <h3 className="text-lg font-medium mb-4">Anti-Stalking Protection</h3>
        <div className="grid grid-cols-3 gap-4">
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <div className="text-2xl font-semibold text-apple-blue">
              {stats.antiStalking.totalSightings}
            </div>
            <div className="text-sm text-gray-500">Total Sightings</div>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <div className="text-2xl font-semibold text-apple-orange">
              {stats.antiStalking.uniqueTrackers}
            </div>
            <div className="text-sm text-gray-500">Unique Trackers</div>
          </div>
          <div className="text-center p-4 bg-gray-50 rounded-lg">
            <div className="text-2xl font-semibold text-apple-red">
              {stats.antiStalking.alertsTriggered}
            </div>
            <div className="text-sm text-gray-500">Alerts Triggered</div>
          </div>
        </div>
      </div>

      {/* Notifications Stats */}
      <div className="bg-white rounded-xl p-6 shadow">
        <h3 className="text-lg font-medium mb-4">Notifications</h3>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-3xl font-semibold">{stats.notifications.total}</div>
            <div className="text-gray-500">Total Notifications</div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold text-apple-blue">
              {stats.notifications.unread}
            </div>
            <div className="text-gray-500">Unread</div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
          {Object.entries(stats.notifications.byType).map(([type, count]) => (
            <div
              key={type}
              className="text-center p-2 bg-gray-50 rounded text-sm"
            >
              <span className="font-medium">{count}</span>{' '}
              <span className="text-gray-500">{type.replace('_', ' ')}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  subtitle,
  icon,
  highlight = false,
}: {
  title: string;
  value: number;
  subtitle: string;
  icon: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-4 shadow ${
        highlight ? 'bg-apple-red text-white' : 'bg-white'
      }`}
    >
      <div className="flex justify-between items-start">
        <div>
          <p className={`text-sm ${highlight ? 'text-red-100' : 'text-gray-500'}`}>
            {title}
          </p>
          <p className="text-3xl font-semibold mt-1">{value}</p>
          <p className={`text-xs mt-1 ${highlight ? 'text-red-200' : 'text-gray-400'}`}>
            {subtitle}
          </p>
        </div>
        <span
          className="text-2xl"
          dangerouslySetInnerHTML={{ __html: icon }}
        />
      </div>
    </div>
  );
}
