import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { categoryApi, streamApi } from '../services/api';
import type { Category } from '../types';

export function DashboardPage() {
  const { user } = useAuthStore();
  const [categories, setCategories] = useState<Category[]>([]);
  const [streamTitle, setStreamTitle] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function fetchCategories() {
      try {
        const res = await categoryApi.getAll({ limit: 50 });
        setCategories(res.categories);
      } catch (error) {
        console.error('Failed to fetch categories:', error);
      }
    }

    fetchCategories();

    if (user?.channel?.isLive) {
      setIsLive(true);
    }
  }, [user]);

  if (!user) {
    return (
      <div className="p-8">
        <div className="bg-surface-light rounded-lg p-8 text-center max-w-md mx-auto">
          <h2 className="text-xl font-bold text-white mb-2">Log in to access your dashboard</h2>
          <p className="text-gray-400">Manage your stream and channel settings.</p>
        </div>
      </div>
    );
  }

  const handleStartStream = async () => {
    setLoading(true);
    try {
      await streamApi.start(streamTitle || 'Live Stream', selectedCategory || undefined);
      setIsLive(true);
    } catch (error) {
      console.error('Failed to start stream:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleStopStream = async () => {
    setLoading(true);
    try {
      await streamApi.stop();
      setIsLive(false);
    } catch (error) {
      console.error('Failed to stop stream:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold text-white mb-8">Creator Dashboard</h1>

      {/* Stream Status */}
      <div className="bg-surface-darker rounded-lg p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">Stream Status</h2>
          <div className="flex items-center gap-2">
            {isLive ? (
              <>
                <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                <span className="text-red-400 font-semibold">LIVE</span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 bg-gray-500 rounded-full" />
                <span className="text-gray-400">Offline</span>
              </>
            )}
          </div>
        </div>

        {isLive ? (
          <div className="space-y-4">
            <div className="bg-surface-light rounded p-4">
              <p className="text-gray-400 text-sm mb-1">Currently streaming as</p>
              <p className="text-white font-semibold">{streamTitle || 'Live Stream'}</p>
            </div>
            <div className="flex gap-4">
              <Link
                to={`/${user.username}`}
                className="px-4 py-2 bg-twitch-500 text-white rounded font-semibold hover:bg-twitch-600"
              >
                View Your Stream
              </Link>
              <button
                onClick={handleStopStream}
                disabled={loading}
                className="px-4 py-2 bg-red-600 text-white rounded font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {loading ? 'Stopping...' : 'End Stream'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-300 mb-2">
                Stream Title
              </label>
              <input
                type="text"
                value={streamTitle}
                onChange={(e) => setStreamTitle(e.target.value)}
                placeholder="Enter your stream title"
                className="w-full bg-surface-light border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-twitch-500"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-300 mb-2">
                Category
              </label>
              <select
                value={selectedCategory || ''}
                onChange={(e) => setSelectedCategory(e.target.value ? parseInt(e.target.value) : null)}
                className="w-full bg-surface-light border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-twitch-500"
              >
                <option value="">Select a category</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={handleStartStream}
              disabled={loading}
              className="px-6 py-2 bg-twitch-500 text-white rounded font-semibold hover:bg-twitch-600 disabled:opacity-50"
            >
              {loading ? 'Starting...' : 'Start Simulated Stream'}
            </button>
            <p className="text-gray-500 text-sm">
              Note: This simulates going live. In production, you would use OBS with your stream key.
            </p>
          </div>
        )}
      </div>

      {/* Stream Key */}
      <div className="bg-surface-darker rounded-lg p-6 mb-6">
        <h2 className="text-xl font-bold text-white mb-4">Stream Key</h2>
        <div className="bg-surface-light rounded p-4">
          <p className="text-gray-400 text-sm mb-2">
            Use this key in OBS or your streaming software
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-black rounded px-3 py-2 text-green-400 font-mono text-sm">
              {user.channel?.streamKey || 'Stream key not available'}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(user.channel?.streamKey || '')}
              className="px-3 py-2 bg-gray-700 text-white rounded hover:bg-gray-600"
            >
              Copy
            </button>
          </div>
          <p className="text-red-400 text-xs mt-2">
            Never share your stream key with anyone!
          </p>
        </div>
      </div>

      {/* Quick Links */}
      <div className="bg-surface-darker rounded-lg p-6">
        <h2 className="text-xl font-bold text-white mb-4">Quick Links</h2>
        <div className="grid grid-cols-2 gap-4">
          <Link
            to={`/${user.username}`}
            className="flex items-center gap-3 p-4 bg-surface-light rounded-lg hover:bg-gray-700 transition-colors"
          >
            <svg className="w-6 h-6 text-twitch-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <span className="text-white font-semibold">Your Channel</span>
          </Link>
          <Link
            to="/following"
            className="flex items-center gap-3 p-4 bg-surface-light rounded-lg hover:bg-gray-700 transition-colors"
          >
            <svg className="w-6 h-6 text-twitch-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
            <span className="text-white font-semibold">Following</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
