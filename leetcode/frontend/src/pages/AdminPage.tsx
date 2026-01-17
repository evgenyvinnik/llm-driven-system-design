import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { StatusBadge } from '../components/StatusBadge';

interface Stats {
  overview: {
    total_users: string;
    total_problems: string;
    total_submissions: string;
    accepted_submissions: string;
    submissions_24h: string;
    new_users_24h: string;
  };
  submissionsByStatus: Array<{ status: string; count: string }>;
  problemsByDifficulty: Array<{ difficulty: string; count: string }>;
}

interface LeaderboardEntry {
  id: string;
  username: string;
  solved_count: string;
  easy_solved: string;
  medium_solved: string;
  hard_solved: string;
  avg_runtime: string;
}

export function AdminPage() {
  const { user, isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  const [stats, setStats] = useState<Stats | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'leaderboard'>('overview');

  useEffect(() => {
    if (!isAuthenticated || user?.role !== 'admin') {
      navigate('/');
      return;
    }
    loadData();
  }, [isAuthenticated, user, navigate]);

  const loadData = async () => {
    try {
      const [statsData, leaderboardData] = await Promise.all([
        adminApi.getStats(),
        adminApi.getLeaderboard(),
      ]);
      setStats(statsData);
      setLeaderboard(leaderboardData.leaderboard);
    } catch (err) {
      console.error('Failed to load admin data:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthenticated || user?.role !== 'admin') {
    return null;
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Admin Dashboard</h1>
        <p className="text-gray-400">System overview and management</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
            activeTab === 'overview'
              ? 'bg-primary-500 text-white'
              : 'bg-dark-300 text-gray-400 hover:text-white'
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('leaderboard')}
          className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
            activeTab === 'leaderboard'
              ? 'bg-primary-500 text-white'
              : 'bg-dark-300 text-gray-400 hover:text-white'
          }`}
        >
          Leaderboard
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin inline-block w-8 h-8 border-2 border-current border-t-transparent text-primary-500 rounded-full"></div>
        </div>
      ) : activeTab === 'overview' && stats ? (
        <>
          {/* Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
            <div className="bg-dark-300 rounded-lg p-4">
              <div className="text-2xl font-bold text-white">{stats.overview.total_users}</div>
              <div className="text-gray-400 text-sm">Total Users</div>
            </div>
            <div className="bg-dark-300 rounded-lg p-4">
              <div className="text-2xl font-bold text-white">{stats.overview.new_users_24h}</div>
              <div className="text-gray-400 text-sm">New Users (24h)</div>
            </div>
            <div className="bg-dark-300 rounded-lg p-4">
              <div className="text-2xl font-bold text-white">{stats.overview.total_problems}</div>
              <div className="text-gray-400 text-sm">Total Problems</div>
            </div>
            <div className="bg-dark-300 rounded-lg p-4">
              <div className="text-2xl font-bold text-white">{stats.overview.total_submissions}</div>
              <div className="text-gray-400 text-sm">Total Submissions</div>
            </div>
            <div className="bg-dark-300 rounded-lg p-4">
              <div className="text-2xl font-bold text-green-400">{stats.overview.accepted_submissions}</div>
              <div className="text-gray-400 text-sm">Accepted</div>
            </div>
            <div className="bg-dark-300 rounded-lg p-4">
              <div className="text-2xl font-bold text-yellow-400">{stats.overview.submissions_24h}</div>
              <div className="text-gray-400 text-sm">Submissions (24h)</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Submissions by Status */}
            <div className="bg-dark-300 rounded-lg p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Submissions by Status</h3>
              <div className="space-y-3">
                {stats.submissionsByStatus.map((item) => (
                  <div key={item.status} className="flex items-center justify-between">
                    <StatusBadge status={item.status} />
                    <span className="text-gray-300">{item.count}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Problems by Difficulty */}
            <div className="bg-dark-300 rounded-lg p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Problems by Difficulty</h3>
              <div className="space-y-3">
                {stats.problemsByDifficulty.map((item) => (
                  <div key={item.difficulty} className="flex items-center justify-between">
                    <span className={`capitalize ${
                      item.difficulty === 'easy' ? 'text-green-400' :
                      item.difficulty === 'medium' ? 'text-yellow-400' :
                      'text-red-400'
                    }`}>
                      {item.difficulty}
                    </span>
                    <span className="text-gray-300">{item.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : (
        /* Leaderboard */
        <div className="bg-dark-300 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-dark-100">
                <th className="px-4 py-3 text-left text-gray-400 font-medium w-12">#</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Username</th>
                <th className="px-4 py-3 text-center text-gray-400 font-medium">Solved</th>
                <th className="px-4 py-3 text-center text-green-400 font-medium">Easy</th>
                <th className="px-4 py-3 text-center text-yellow-400 font-medium">Medium</th>
                <th className="px-4 py-3 text-center text-red-400 font-medium">Hard</th>
                <th className="px-4 py-3 text-center text-gray-400 font-medium">Avg Runtime</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((entry, index) => (
                <tr
                  key={entry.id}
                  className="border-b border-dark-100 hover:bg-dark-200 transition-colors"
                >
                  <td className="px-4 py-3 text-gray-400">{index + 1}</td>
                  <td className="px-4 py-3 text-white font-medium">{entry.username}</td>
                  <td className="px-4 py-3 text-center text-white">{entry.solved_count}</td>
                  <td className="px-4 py-3 text-center text-green-400">{entry.easy_solved}</td>
                  <td className="px-4 py-3 text-center text-yellow-400">{entry.medium_solved}</td>
                  <td className="px-4 py-3 text-center text-red-400">{entry.hard_solved}</td>
                  <td className="px-4 py-3 text-center text-gray-400">
                    {parseFloat(entry.avg_runtime).toFixed(0)}ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {leaderboard.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              No data available
            </div>
          )}
        </div>
      )}
    </div>
  );
}
