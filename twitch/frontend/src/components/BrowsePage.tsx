import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { channelApi, categoryApi } from '../services/api';
import type { Channel, Category } from '../types';
import { StreamCard } from './StreamCard';

export function BrowsePage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeTab, setActiveTab] = useState<'channels' | 'categories'>('channels');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        if (activeTab === 'channels') {
          const res = await channelApi.getLive({ limit: 24 });
          setChannels(res.channels);
        } else {
          const res = await categoryApi.getAll({ limit: 24 });
          setCategories(res.categories);
        }
      } catch (error) {
        console.error('Failed to fetch browse data:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [activeTab]);

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold text-white mb-6">Browse</h1>

      {/* Tabs */}
      <div className="flex gap-6 mb-6 border-b border-gray-800">
        <button
          onClick={() => setActiveTab('channels')}
          className={`pb-4 text-lg font-semibold border-b-2 transition-colors ${
            activeTab === 'channels'
              ? 'text-twitch-500 border-twitch-500'
              : 'text-gray-400 border-transparent hover:text-white'
          }`}
        >
          Live Channels
        </button>
        <button
          onClick={() => setActiveTab('categories')}
          className={`pb-4 text-lg font-semibold border-b-2 transition-colors ${
            activeTab === 'categories'
              ? 'text-twitch-500 border-twitch-500'
              : 'text-gray-400 border-transparent hover:text-white'
          }`}
        >
          Categories
        </button>
      </div>

      {loading ? (
        <div className="animate-pulse">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[...Array(12)].map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="aspect-video bg-gray-700 rounded" />
                <div className="h-4 bg-gray-700 rounded w-3/4" />
                <div className="h-3 bg-gray-700 rounded w-1/2" />
              </div>
            ))}
          </div>
        </div>
      ) : activeTab === 'channels' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {channels.length === 0 ? (
            <div className="col-span-full bg-surface-light rounded-lg p-8 text-center">
              <p className="text-gray-400">No live channels right now</p>
            </div>
          ) : (
            channels.map((channel) => (
              <StreamCard key={channel.id} channel={channel} />
            ))
          )}
        </div>
      ) : (
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
              <p className="text-gray-500 text-xs">
                {category.liveChannels || 0} live
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
