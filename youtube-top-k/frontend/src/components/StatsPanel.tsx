import { useEffect, useState } from 'react';
import type { StatsResponse } from '../types';
import { fetchStats } from '../services/api';

export function StatsPanel() {
  const [stats, setStats] = useState<StatsResponse | null>(null);

  useEffect(() => {
    const loadStats = async () => {
      try {
        const data = await fetchStats();
        setStats(data);
      } catch (error) {
        console.error('Failed to load stats:', error);
      }
    };

    loadStats();
    const interval = setInterval(loadStats, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!stats) {
    return null;
  }

  const statItems = [
    { label: 'Total Views', value: stats.totalViews.toLocaleString(), icon: '👁️' },
    { label: 'Unique Videos', value: stats.uniqueVideos.toLocaleString(), icon: '🎬' },
    { label: 'Active Categories', value: stats.activeCategories.toLocaleString(), icon: '📂' },
    { label: 'Connected Clients', value: stats.connectedClients.toLocaleString(), icon: '📡' },
  ];

  return (
    <div className="bg-youtube-gray rounded-lg p-4">
      <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3">
        Live Statistics
      </h3>
      <div className="grid grid-cols-2 gap-3">
        {statItems.map((item) => (
          <div key={item.label} className="bg-youtube-dark rounded-lg p-3">
            <div className="flex items-center gap-2 text-gray-400 text-xs mb-1">
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </div>
            <div className="text-xl font-bold text-white">{item.value}</div>
          </div>
        ))}
      </div>
      {stats.lastUpdate && (
        <div className="mt-3 text-xs text-gray-500 text-center">
          Last Update: {new Date(stats.lastUpdate).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
