import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Users, Music, Disc, Mic2, ListMusic, BarChart3 } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';

interface AdminStats {
  counts: {
    users: number;
    tracks: number;
    albums: number;
    artists: number;
    playlists: number;
    totalPlays: number;
  };
  activeUsers: number;
  playsPerDay: { date: string; plays: number }[];
  topTracksToday: { id: string; title: string; artist_name: string; plays: number }[];
}

export const Route = createFileRoute('/admin')({
  component: AdminDashboard,
});

function AdminDashboard() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate({ to: '/' });
      return;
    }

    const fetchStats = async () => {
      try {
        const response = await fetch('/api/admin/stats', {
          credentials: 'include',
        });
        if (!response.ok) throw new Error('Failed to fetch stats');
        const data = await response.json();
        setStats(data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchStats();
  }, [user, navigate]);

  if (!user || user.role !== 'admin') {
    return null;
  }

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-apple-red border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-500/20 border border-red-500 text-red-200 px-4 py-3 rounded-lg">
          {error}
        </div>
      </div>
    );
  }

  const statCards = [
    { label: 'Total Users', value: stats?.counts.users || 0, icon: Users, color: 'bg-blue-500' },
    { label: 'Active Users (7d)', value: stats?.activeUsers || 0, icon: Users, color: 'bg-green-500' },
    { label: 'Tracks', value: stats?.counts.tracks || 0, icon: Music, color: 'bg-purple-500' },
    { label: 'Albums', value: stats?.counts.albums || 0, icon: Disc, color: 'bg-pink-500' },
    { label: 'Artists', value: stats?.counts.artists || 0, icon: Mic2, color: 'bg-orange-500' },
    { label: 'Playlists', value: stats?.counts.playlists || 0, icon: ListMusic, color: 'bg-cyan-500' },
    { label: 'Total Plays', value: stats?.counts.totalPlays || 0, icon: BarChart3, color: 'bg-red-500' },
  ];

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Admin Dashboard</h1>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-8">
        {statCards.map((stat) => (
          <div key={stat.label} className="bg-apple-card rounded-xl p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className={`p-2 rounded-lg ${stat.color}`}>
                <stat.icon className="w-5 h-5 text-white" />
              </div>
              <span className="text-sm text-apple-text-secondary">{stat.label}</span>
            </div>
            <p className="text-3xl font-bold">{stat.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* Plays Per Day Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        <div className="bg-apple-card rounded-xl p-6">
          <h2 className="text-xl font-semibold mb-4">Plays Per Day (Last 7 Days)</h2>
          {stats?.playsPerDay && stats.playsPerDay.length > 0 ? (
            <div className="space-y-3">
              {stats.playsPerDay.map((day) => (
                <div key={day.date} className="flex items-center gap-4">
                  <span className="text-sm text-apple-text-secondary w-24">
                    {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  </span>
                  <div className="flex-1 bg-apple-border rounded-full h-4 overflow-hidden">
                    <div
                      className="h-full bg-apple-red rounded-full"
                      style={{
                        width: `${Math.min(100, (day.plays / Math.max(...stats.playsPerDay.map(d => d.plays))) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="text-sm font-medium w-16 text-right">{day.plays}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-apple-text-secondary">No play data available</p>
          )}
        </div>

        {/* Top Tracks Today */}
        <div className="bg-apple-card rounded-xl p-6">
          <h2 className="text-xl font-semibold mb-4">Top Tracks Today</h2>
          {stats?.topTracksToday && stats.topTracksToday.length > 0 ? (
            <div className="space-y-3">
              {stats.topTracksToday.map((track, index) => (
                <div key={track.id} className="flex items-center gap-4">
                  <span className="text-lg font-bold text-apple-text-secondary w-8">
                    {index + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{track.title}</p>
                    <p className="text-sm text-apple-text-secondary truncate">{track.artist_name}</p>
                  </div>
                  <span className="text-sm font-medium">{track.plays} plays</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-apple-text-secondary">No plays today</p>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-apple-card rounded-xl p-6">
        <h2 className="text-xl font-semibold mb-4">Quick Actions</h2>
        <div className="flex flex-wrap gap-4">
          <button className="px-4 py-2 bg-apple-bg border border-apple-border rounded-lg hover:bg-white/5 transition">
            Add Artist
          </button>
          <button className="px-4 py-2 bg-apple-bg border border-apple-border rounded-lg hover:bg-white/5 transition">
            Add Album
          </button>
          <button className="px-4 py-2 bg-apple-bg border border-apple-border rounded-lg hover:bg-white/5 transition">
            Add Track
          </button>
          <button className="px-4 py-2 bg-apple-bg border border-apple-border rounded-lg hover:bg-white/5 transition">
            Create Radio Station
          </button>
          <button
            onClick={async () => {
              await fetch('/api/admin/cache/clear', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              alert('Cache cleared');
            }}
            className="px-4 py-2 bg-red-600/20 border border-red-600 text-red-400 rounded-lg hover:bg-red-600/30 transition"
          >
            Clear Cache
          </button>
        </div>
      </div>
    </div>
  );
}
