/**
 * @fileoverview Admin dashboard route.
 * Provides system statistics, user management, and administrative controls.
 * Orchestrates the admin sub-components and manages state.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import {
  AdminTabs,
  HealthStatusBar,
  OverviewTab,
  UsersTable,
  PostsTable,
  SearchHistoryTable,
  type AdminTabId,
  type HealthStatus,
} from '../components/admin';
import type { AdminStats, User, Post, SearchHistoryEntry } from '../types';

/**
 * Admin dashboard component.
 * Displays system stats, health status, and management tables.
 * Restricted to users with admin role.
 *
 * @returns Admin dashboard page with tabs for different admin sections
 */
function AdminPage() {
  const { user, isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<AdminTabId>('overview');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>([]);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isReindexing, setIsReindexing] = useState(false);

  /**
   * Checks authentication and loads initial data on mount.
   */
  useEffect(() => {
    if (!isAuthenticated || user?.role !== 'admin') {
      navigate({ to: '/login' });
      return;
    }

    loadData();
  }, [isAuthenticated, user, navigate]);

  /**
   * Loads tab-specific data when the active tab changes.
   */
  useEffect(() => {
    if (activeTab === 'users' && users.length === 0) {
      loadUsers();
    } else if (activeTab === 'posts' && posts.length === 0) {
      loadPosts();
    } else if (activeTab === 'searches' && searchHistory.length === 0) {
      loadSearchHistory();
    }
  }, [activeTab, users.length, posts.length, searchHistory.length]);

  /**
   * Fetches admin statistics and system health data.
   */
  const loadData = async () => {
    setIsLoading(true);
    try {
      const [statsData, healthData] = await Promise.all([
        api.getAdminStats(),
        api.getAdminHealth(),
      ]);
      setStats(statsData);
      setHealth(healthData);
    } catch (error) {
      console.error('Failed to load admin data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Fetches the list of registered users.
   */
  const loadUsers = async () => {
    try {
      const { users } = await api.getAdminUsers();
      setUsers(users);
    } catch (error) {
      console.error('Failed to load users:', error);
    }
  };

  /**
   * Fetches the list of posts for admin review.
   */
  const loadPosts = async () => {
    try {
      const { posts } = await api.getAdminPosts();
      setPosts(posts);
    } catch (error) {
      console.error('Failed to load posts:', error);
    }
  };

  /**
   * Fetches the search history for analytics.
   */
  const loadSearchHistory = async () => {
    try {
      const { history } = await api.getAdminSearchHistory();
      setSearchHistory(history);
    } catch (error) {
      console.error('Failed to load search history:', error);
    }
  };

  /**
   * Triggers a full reindex of posts to Elasticsearch.
   */
  const handleReindex = async () => {
    setIsReindexing(true);
    try {
      const result = await api.reindexPosts();
      alert(`Successfully reindexed ${result.indexed_count} posts`);
      loadData();
    } catch (error) {
      alert('Reindex failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsReindexing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center">
        <div className="animate-pulse text-gray-500">Loading admin panel...</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
        <p className="text-gray-500">Manage users, posts, and system settings</p>
      </div>

      {/* Health Status */}
      {health && (
        <HealthStatusBar
          health={health}
          isReindexing={isReindexing}
          onReindex={handleReindex}
        />
      )}

      {/* Tab Navigation */}
      <AdminTabs activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab Content */}
      {activeTab === 'overview' && stats && <OverviewTab stats={stats} />}
      {activeTab === 'users' && <UsersTable users={users} />}
      {activeTab === 'posts' && <PostsTable posts={posts} />}
      {activeTab === 'searches' && <SearchHistoryTable history={searchHistory} />}
    </div>
  );
}

/**
 * TanStack Router file route for the admin dashboard.
 */
export const Route = createFileRoute('/admin')({
  component: AdminPage,
});
