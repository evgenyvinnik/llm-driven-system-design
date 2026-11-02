/**
 * Admin dashboard route - platform statistics and management.
 * Provides admins with overview of platform metrics and activity.
 */
import { createFileRoute, Navigate, Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useState, useEffect } from 'react';
import { adminApi } from '../services/api';
import type { AdminStats } from '../types';
import {
  StatCard,
  GenderDistribution,
  MessagingStats,
  RecentSignups,
  RecentMatches,
  type RecentSignup,
  type RecentMatch,
} from '../components/admin';

/**
 * Activity data structure from the API.
 */
interface ActivityData {
  recentMatches: RecentMatch[];
  recentSignups: RecentSignup[];
}

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
  const [activity, setActivity] = useState<ActivityData | null>(null);
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

            <GenderDistribution
              maleCount={stats.users.maleCount}
              femaleCount={stats.users.femaleCount}
              total={stats.users.total}
            />

            <MessagingStats
              totalMessages={stats.messages.totalMessages}
              messagesToday={stats.messages.messagesToday}
              avgMessagesPerMatch={stats.messages.avgMessagesPerMatch}
            />
          </>
        )}

        {/* Recent Activity */}
        {activity && (
          <>
            <RecentSignups signups={activity.recentSignups} />
            <RecentMatches matches={activity.recentMatches} />
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

export const Route = createFileRoute('/admin')({
  component: AdminPage,
});
