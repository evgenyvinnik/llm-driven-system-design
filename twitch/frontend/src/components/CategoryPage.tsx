import { useEffect, useState } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import { categoryApi } from '../services/api';
import type { Channel, Category } from '../types';
import { StreamCard } from './StreamCard';

export function CategoryPage() {
  const { slug } = useParams({ from: '/category/$slug' });
  const [category, setCategory] = useState<Category | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        const [categoryRes, channelsRes] = await Promise.all([
          categoryApi.getBySlug(slug),
          categoryApi.getChannels(slug, { limit: 24 }),
        ]);
        setCategory(categoryRes.category);
        setChannels(channelsRes.channels);
      } catch (error) {
        console.error('Failed to fetch category:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [slug]);

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-8">
          <div className="flex gap-6">
            <div className="w-48 h-64 bg-gray-700 rounded" />
            <div className="flex-1 space-y-4">
              <div className="h-8 bg-gray-700 rounded w-64" />
              <div className="h-4 bg-gray-700 rounded w-48" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="aspect-video bg-gray-700 rounded" />
                <div className="h-4 bg-gray-700 rounded w-3/4" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!category) {
    return (
      <div className="p-8">
        <div className="bg-surface-light rounded-lg p-8 text-center">
          <h2 className="text-xl font-bold text-white mb-2">Category Not Found</h2>
          <p className="text-gray-400 mb-4">The category you're looking for doesn't exist.</p>
          <Link to="/browse" className="text-twitch-400 hover:underline">
            Browse all categories
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Category Header */}
      <div className="flex gap-6 mb-8">
        <div className="w-48 h-64 bg-gradient-to-br from-twitch-500 to-twitch-700 rounded-lg flex items-center justify-center flex-shrink-0">
          <span className="text-6xl font-bold text-white/80">{category.name[0]}</span>
        </div>
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">{category.name}</h1>
          <div className="flex gap-4 text-gray-400">
            <span>{category.viewerCount?.toLocaleString() || 0} viewers</span>
            <span>{category.liveChannels || 0} live channels</span>
          </div>
        </div>
      </div>

      {/* Live Channels */}
      <h2 className="text-xl font-bold text-white mb-4">Live Channels</h2>
      {channels.length === 0 ? (
        <div className="bg-surface-light rounded-lg p-8 text-center">
          <p className="text-gray-400">No one is streaming {category.name} right now</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {channels.map((channel) => (
            <StreamCard key={channel.id} channel={channel} />
          ))}
        </div>
      )}
    </div>
  );
}
