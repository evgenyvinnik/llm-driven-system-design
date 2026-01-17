/**
 * Admin dashboard page route.
 * Provides system statistics and news source management.
 * @module routes/admin
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores';
import { adminApi } from '../services/api';
import type { AdminStats, Source } from '../types';
import {
  Shield,
  Database,
  Newspaper,
  Users,
  Clock,
  Plus,
  RefreshCw,
  Trash2,
  Play,
} from 'lucide-react';

/**
 * Admin page route configuration.
 * Protected route - requires admin role.
 */
export const Route = createFileRoute('/admin')({
  component: AdminPage,
});

/**
 * Admin dashboard component.
 * Shows system statistics and provides source management.
 * Requires admin role - redirects to home if not admin.
 * @returns Admin dashboard with stats and source table
 */
function AdminPage() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCrawling, setIsCrawling] = useState(false);
  const [crawlMessage, setCrawlMessage] = useState<string | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSource, setNewSource] = useState({ name: '', feed_url: '', category: 'general' });

  // Redirect non-admins and load data on mount
  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate({ to: '/' });
      return;
    }

    loadData();
  }, [user, navigate]);

  /**
   * Load stats and sources from API.
   * Called on mount and after mutations.
   */
  const loadData = async () => {
    setIsLoading(true);
    try {
      const [statsResponse, sourcesResponse] = await Promise.all([
        adminApi.getStats(),
        adminApi.getSources(),
      ]);
      setStats(statsResponse);
      setSources(sourcesResponse.sources);
    } catch (error) {
      console.error('Failed to load admin data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Trigger crawl of all due sources.
   * Shows result message and refreshes data.
   */
  const handleTriggerCrawl = async () => {
    setIsCrawling(true);
    setCrawlMessage(null);
    try {
      const result = await adminApi.triggerCrawl();
      setCrawlMessage(`Crawl completed: ${result.sources_crawled} sources, ${result.total_articles_new} new articles`);
      loadData();
    } catch (error) {
      setCrawlMessage('Crawl failed: ' + (error as Error).message);
    } finally {
      setIsCrawling(false);
    }
  };

  /**
   * Handle add source form submission.
   * Creates source and updates table.
   */
  const handleAddSource = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const source = await adminApi.addSource(newSource.name, newSource.feed_url, newSource.category);
      setSources([...sources, source]);
      setNewSource({ name: '', feed_url: '', category: 'general' });
      setShowAddSource(false);
    } catch (error) {
      console.error('Failed to add source:', error);
    }
  };

  /**
   * Delete a source after confirmation.
   * @param id - Source UUID to delete
   */
  const handleDeleteSource = async (id: string) => {
    if (!confirm('Are you sure you want to delete this source?')) return;
    try {
      await adminApi.deleteSource(id);
      setSources(sources.filter((s) => s.id !== id));
    } catch (error) {
      console.error('Failed to delete source:', error);
    }
  };

  /**
   * Manually trigger crawl for a single source.
   * @param id - Source UUID to crawl
   */
  const handleCrawlSource = async (id: string) => {
    try {
      const result = await adminApi.crawlSource(id);
      setCrawlMessage(`Crawled: ${result.articles_found} found, ${result.articles_new} new`);
      loadData();
    } catch (error) {
      setCrawlMessage('Crawl failed: ' + (error as Error).message);
    }
  };

  if (!user || user.role !== 'admin') {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="w-8 h-8 text-primary-500" />
          <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
        </div>
        <button
          onClick={handleTriggerCrawl}
          disabled={isCrawling}
          className="btn btn-primary"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${isCrawling ? 'animate-spin' : ''}`} />
          {isCrawling ? 'Crawling...' : 'Trigger Crawl'}
        </button>
      </div>

      {crawlMessage && (
        <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-lg">
          {crawlMessage}
        </div>
      )}

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <Database className="w-8 h-8 text-blue-500" />
              <div>
                <p className="text-2xl font-bold">{stats.sources}</p>
                <p className="text-sm text-gray-500">Sources</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <Newspaper className="w-8 h-8 text-green-500" />
              <div>
                <p className="text-2xl font-bold">{stats.articles.toLocaleString()}</p>
                <p className="text-sm text-gray-500">Articles</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <Newspaper className="w-8 h-8 text-purple-500" />
              <div>
                <p className="text-2xl font-bold">{stats.stories.toLocaleString()}</p>
                <p className="text-sm text-gray-500">Stories</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <Users className="w-8 h-8 text-orange-500" />
              <div>
                <p className="text-2xl font-bold">{stats.users}</p>
                <p className="text-sm text-gray-500">Users</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <div className="flex items-center gap-3">
              <Clock className="w-8 h-8 text-red-500" />
              <div>
                <p className="text-2xl font-bold">{stats.articles_last_24h}</p>
                <p className="text-sm text-gray-500">24h Articles</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sources Management */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">News Sources</h2>
          <button
            onClick={() => setShowAddSource(!showAddSource)}
            className="btn btn-outline"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Source
          </button>
        </div>

        {showAddSource && (
          <form onSubmit={handleAddSource} className="p-4 border-b border-gray-200 bg-gray-50">
            <div className="grid grid-cols-3 gap-4">
              <input
                type="text"
                placeholder="Source Name"
                value={newSource.name}
                onChange={(e) => setNewSource({ ...newSource, name: e.target.value })}
                className="input"
                required
              />
              <input
                type="url"
                placeholder="RSS Feed URL"
                value={newSource.feed_url}
                onChange={(e) => setNewSource({ ...newSource, feed_url: e.target.value })}
                className="input"
                required
              />
              <div className="flex gap-2">
                <select
                  value={newSource.category}
                  onChange={(e) => setNewSource({ ...newSource, category: e.target.value })}
                  className="input"
                >
                  <option value="technology">Technology</option>
                  <option value="world">World</option>
                  <option value="business">Business</option>
                  <option value="sports">Sports</option>
                  <option value="entertainment">Entertainment</option>
                  <option value="science">Science</option>
                  <option value="health">Health</option>
                  <option value="general">General</option>
                </select>
                <button type="submit" className="btn btn-primary">
                  Add
                </button>
              </div>
            </div>
          </form>
        )}

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Name</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Domain</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Category</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sources.map((source) => (
                <tr key={source.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{source.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{source.domain}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className="topic-badge">{source.category}</span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        source.is_active
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {source.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleCrawlSource(source.id)}
                        className="text-blue-600 hover:text-blue-800"
                        title="Crawl now"
                      >
                        <Play className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteSource(source.id)}
                        className="text-red-600 hover:text-red-800"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
