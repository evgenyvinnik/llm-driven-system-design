import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { channelApi, categoryApi } from '../services/api';
import type { Channel, Category } from '../types';
import { StreamCard } from './StreamCard';

export function HomePage() {
  const [liveChannels, setLiveChannels] = useState<Channel[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [channelsRes, categoriesRes] = await Promise.all([
          channelApi.getLive({ limit: 12 }),
          categoryApi.getAll({ limit: 8 }),
        ]);
        setLiveChannels(channelsRes.channels);
        setCategories(categoriesRes.categories);
      } catch (error) {
        console.error('Failed to fetch home data:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-8">
          <div className="h-8 bg-gray-700 rounded w-48" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="aspect-video bg-gray-700 rounded" />
                <div className="h-4 bg-gray-700 rounded w-3/4" />
                <div className="h-3 bg-gray-700 rounded w-1/2" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Live Channels Section */}
      <section className="mb-12">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">Live Channels</h2>
          <Link to="/browse" className="text-twitch-400 hover:underline text-sm">
            Show more
          </Link>
        </div>

        {liveChannels.length === 0 ? (
          <div className="bg-surface-light rounded-lg p-8 text-center">
            <p className="text-gray-400">No live channels right now</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {liveChannels.map((channel) => (
              <StreamCard key={channel.id} channel={channel} />
            ))}
          </div>
        )}
      </section>

      {/* Categories Section */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">Browse Categories</h2>
          <Link to="/browse" className="text-twitch-400 hover:underline text-sm">
            Show more
          </Link>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
          {categories.map((category) => (
            <Link
              key={category.slug}
              to={`/category/${category.slug}`}
              className="group"
            >
              <div className="aspect-[3/4] bg-surface-light rounded-lg overflow-hidden mb-2 group-hover:ring-2 ring-twitch-500 transition-all">
                <div className="w-full h-full bg-gradient-to-br from-twitch-500 to-twitch-700 flex items-center justify-center">
                  <span className="text-3xl font-bold text-white/80">
                    {category.name[0]}
                  </span>
                </div>
              </div>
              <h3 className="text-white font-semibold text-sm truncate group-hover:text-twitch-400">
                {category.name}
              </h3>
              <p className="text-gray-400 text-xs">
                {category.viewerCount?.toLocaleString() || 0} viewers
              </p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
