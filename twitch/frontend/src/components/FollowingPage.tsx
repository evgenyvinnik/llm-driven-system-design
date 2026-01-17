import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { userApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import type { Channel } from '../types';
import { StreamCard } from './StreamCard';

export function FollowingPage() {
  const { user } = useAuthStore();
  const [following, setFollowing] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchFollowing() {
      if (!user) return;
      setLoading(true);
      try {
        const res = await userApi.getFollowing(user.username);
        setFollowing(res.following);
      } catch (error) {
        console.error('Failed to fetch following:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchFollowing();
  }, [user]);

  if (!user) {
    return (
      <div className="p-8">
        <div className="bg-surface-light rounded-lg p-8 text-center max-w-md mx-auto">
          <h2 className="text-xl font-bold text-white mb-2">Log in to see who you follow</h2>
          <p className="text-gray-400">Follow your favorite streamers to see when they go live.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-8">
          <div className="h-8 bg-gray-700 rounded w-48" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
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

  const liveChannels = following.filter((c) => c.isLive);
  const offlineChannels = following.filter((c) => !c.isLive);

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold text-white mb-6">Following</h1>

      {following.length === 0 ? (
        <div className="bg-surface-light rounded-lg p-8 text-center">
          <h2 className="text-xl font-bold text-white mb-2">You're not following anyone yet</h2>
          <p className="text-gray-400 mb-4">
            Find channels you love and follow them to get notified when they go live.
          </p>
          <Link
            to="/browse"
            className="inline-block px-4 py-2 bg-twitch-500 text-white rounded font-semibold hover:bg-twitch-600"
          >
            Browse Channels
          </Link>
        </div>
      ) : (
        <>
          {/* Live Channels */}
          {liveChannels.length > 0 && (
            <section className="mb-8">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                Live Now
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {liveChannels.map((channel) => (
                  <StreamCard key={channel.id} channel={channel} />
                ))}
              </div>
            </section>
          )}

          {/* Offline Channels */}
          {offlineChannels.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-gray-400 mb-4">Offline</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-4">
                {offlineChannels.map((channel) => (
                  <Link
                    key={channel.id}
                    to={`/${channel.name}`}
                    className="flex items-center gap-3 p-2 rounded hover:bg-surface-light"
                  >
                    <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center text-white font-bold">
                      {channel.user.displayName?.[0]?.toUpperCase() || channel.user.username[0].toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-semibold truncate">
                        {channel.user.displayName || channel.user.username}
                      </p>
                      <p className="text-gray-500 text-sm">Offline</p>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
