/**
 * Admin dashboard route - platform statistics and management.
 * Provides admins with overview of platform metrics and activity.
 */
import { createFileRoute, Navigate, Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useState, useEffect } from 'react';
import { adminApi } from '../services/api';
import type { AdminStats } from '../types';

/**
 * Admin dashboard page component.
 * Displays platform statistics including user counts, match rates,
 * messaging activity, and recent signups/matches.
 * Restricted to admin users only.
 * @returns Admin dashboard element with statistics and activity feed
 */
function AdminPage() {
  const { isAuthenticated, user } = useAuthStore();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [activity, setActivity] = useState<{
    recentMatches: Array<{
      id: string;
      matched_at: string;
      user1_name: string;
      user2_name: string;
    }>;
    recentSignups: Array<{
      id: string;
      name: string;
      email: string;
      created_at: string;
      gender: string;
    }>;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (isAuthenticated && user?.is_admin) {
      loadData();
    }
  }, [isAuthenticated, user]);

  const loadData = async () => {
    try {
      const [statsData, activityData] = await Promise.all([
        adminApi.getStats(),
        adminApi.getActivity(),
      ]);
      setStats(statsData);
      setActivity(activityData);
    } catch (error) {
      console.error('Failed to load admin data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  if (!user?.is_admin) {
    return <Navigate to="/" />;
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="w-8 h-8 border-4 border-gradient-start border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm px-4 py-3 flex items-center">
        <Link to="/profile" className="mr-3">
          <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <h1 className="text-xl font-bold">Admin Dashboard</h1>
      </header>

      {/* Content */}
      <main className="p-4 space-y-4">
        {/* Stats Grid */}
        {stats && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <StatCard
                title="Total Users"
                value={stats.users.total}
                subtitle={`+${stats.users.newToday} today`}
              />
              <StatCard
                title="Active Today"
                value={stats.users.activeToday}
                subtitle={`${stats.users.onlineNow} online now`}
              />
              <StatCard
                title="Total Matches"
                value={stats.matches.totalMatches}
                subtitle={`+${stats.matches.matchesToday} today`}
              />
              <StatCard
                title="Like Rate"
                value={`${stats.matches.likeRate.toFixed(1)}%`}
                subtitle={`${stats.matches.totalSwipes} swipes`}
              />
            </div>

            {/* Gender Distribution */}
            <div className="card p-4">
              <h3 className="font-semibold mb-3">Gender Distribution</h3>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="flex justify-between text-sm mb-1">
                    <span>Male</span>
                    <span>{stats.users.maleCount}</span>
                  </div>
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500"
                      style={{
                        width: `${(stats.users.maleCount / stats.users.total) * 100}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex justify-between text-sm mb-1">
                    <span>Female</span>
                    <span>{stats.users.femaleCount}</span>
                  </div>
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-pink-500"
                      style={{
                        width: `${(stats.users.femaleCount / stats.users.total) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Messages Stats */}
            <div className="card p-4">
              <h3 className="font-semibold mb-3">Messaging</h3>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold text-gradient-start">
                    {stats.messages.totalMessages}
                  </p>
                  <p className="text-sm text-gray-500">Total Messages</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-gradient-start">
                    {stats.messages.messagesToday}
                  </p>
                  <p className="text-sm text-gray-500">Today</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-gradient-start">
                    {stats.messages.avgMessagesPerMatch.toFixed(1)}
                  </p>
                  <p className="text-sm text-gray-500">Avg/Match</p>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Recent Activity */}
        {activity && (
          <>
            {/* Recent Signups */}
            <div className="card p-4">
              <h3 className="font-semibold mb-3">Recent Signups</h3>
              <div className="space-y-2">
                {activity.recentSignups.map((signup) => (
                  <div
                    key={signup.id}
                    className="flex items-center justify-between py-2 border-b last:border-0"
                  >
                    <div>
                      <p className="font-medium">{signup.name}</p>
                      <p className="text-sm text-gray-500">{signup.email}</p>
                    </div>
                    <div className="text-right">
                      <span
                        className={`text-xs px-2 py-1 rounded-full ${
                          signup.gender === 'male'
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-pink-100 text-pink-700'
                        }`}
                      >
                        {signup.gender}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Recent Matches */}
            <div className="card p-4">
              <h3 className="font-semibold mb-3">Recent Matches</h3>
              <div className="space-y-2">
                {activity.recentMatches.map((match) => (
                  <div
                    key={match.id}
                    className="flex items-center justify-between py-2 border-b last:border-0"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{match.user1_name}</span>
                      <svg className="w-4 h-4 text-gradient-start" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                      </svg>
                      <span className="font-medium">{match.user2_name}</span>
                    </div>
                    <span className="text-sm text-gray-500">
                      {new Date(match.matched_at).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* User Management Link */}
        <Link to="/admin/users" className="card p-4 flex items-center justify-between">
          <span className="font-medium">User Management</span>
          <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </main>
    </div>
  );
}

/**
 * Reusable statistics card component for the admin dashboard.
 * Displays a metric with title, value, and subtitle.
 * @param props - StatCard props
 * @param props.title - Label for the statistic
 * @param props.value - Main value to display
 * @param props.subtitle - Additional context or comparison
 * @returns Stat card element
 */
function StatCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: number | string;
  subtitle: string;
}) {
  return (
    <div className="card p-4">
      <p className="text-sm text-gray-500">{title}</p>
      <p className="text-2xl font-bold text-gradient-start">{value}</p>
      <p className="text-xs text-gray-400">{subtitle}</p>
    </div>
  );
}

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});
