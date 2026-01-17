import { useEffect, useState } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import { channelApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import type { Channel } from '../types';
import { VideoPlayer } from './VideoPlayer';
import { Chat } from './Chat';

export function ChannelPage() {
  const { channelName } = useParams({ from: '/$channelName' });
  const { user } = useAuthStore();
  const { joinChannel, leaveChannel, connected } = useChatStore();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);

  useEffect(() => {
    async function fetchChannel() {
      setLoading(true);
      setError(null);
      try {
        const res = await channelApi.getByName(channelName);
        setChannel(res.channel);
        setIsFollowing(res.channel.isFollowing || false);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }

    fetchChannel();
  }, [channelName]);

  useEffect(() => {
    if (channel && connected) {
      joinChannel(channel.id);
      return () => leaveChannel(channel.id);
    }
  }, [channel, connected, joinChannel, leaveChannel]);

  const handleFollow = async () => {
    if (!channel) return;
    try {
      if (isFollowing) {
        await channelApi.unfollow(channel.name);
        setIsFollowing(false);
      } else {
        await channelApi.follow(channel.name);
        setIsFollowing(true);
      }
    } catch (err) {
      console.error('Failed to follow/unfollow:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-56px)]">
        <div className="flex-1 animate-pulse">
          <div className="aspect-video bg-gray-800" />
          <div className="p-4 space-y-4">
            <div className="h-6 bg-gray-700 rounded w-1/2" />
            <div className="h-4 bg-gray-700 rounded w-1/3" />
          </div>
        </div>
        <div className="w-80 bg-surface-darker animate-pulse" />
      </div>
    );
  }

  if (error || !channel) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-56px)]">
        <div className="bg-surface-light rounded-lg p-8 text-center max-w-md">
          <h2 className="text-xl font-bold text-white mb-2">Channel Not Found</h2>
          <p className="text-gray-400 mb-4">
            {error || "The channel you're looking for doesn't exist."}
          </p>
          <Link to="/" className="text-twitch-400 hover:underline">
            Go back home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-56px)]">
      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Video Player */}
        <VideoPlayer channel={channel} />

        {/* Channel Info */}
        <div className="p-4 bg-surface-darker">
          <div className="flex items-start gap-4">
            {/* Avatar */}
            <div className="flex-shrink-0">
              <div className="w-16 h-16 rounded-full bg-twitch-500 flex items-center justify-center text-white text-2xl font-bold">
                {channel.user.displayName?.[0]?.toUpperCase() || channel.user.username[0].toUpperCase()}
              </div>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-xl font-bold text-white">
                  {channel.user.displayName || channel.user.username}
                </h1>
                {channel.isLive && <span className="live-indicator">LIVE</span>}
              </div>
              <h2 className="text-white mb-1">{channel.title}</h2>
              {channel.category && (
                <Link
                  to={`/category/${channel.category.slug}`}
                  className="text-twitch-400 hover:underline text-sm"
                >
                  {channel.category.name}
                </Link>
              )}
              <div className="flex gap-4 text-gray-400 text-sm mt-2">
                <span>{channel.followerCount.toLocaleString()} followers</span>
                {channel.isLive && (
                  <span>{channel.viewerCount.toLocaleString()} watching</span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              {user && user.username !== channel.name && (
                <>
                  <button
                    onClick={handleFollow}
                    className={`px-4 py-2 rounded font-semibold ${
                      isFollowing
                        ? 'bg-surface-light text-white hover:bg-gray-600'
                        : 'bg-twitch-500 text-white hover:bg-twitch-600'
                    }`}
                  >
                    {isFollowing ? 'Following' : 'Follow'}
                  </button>
                  <button className="px-4 py-2 bg-twitch-500 text-white rounded font-semibold hover:bg-twitch-600">
                    Subscribe
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* About Section */}
        {channel.description && (
          <div className="p-4 bg-surface-light border-t border-gray-800">
            <h3 className="text-lg font-bold text-white mb-2">About {channel.user.displayName || channel.user.username}</h3>
            <p className="text-gray-300">{channel.description}</p>
          </div>
        )}
      </div>

      {/* Chat Sidebar */}
      <div className="w-80 flex-shrink-0 border-l border-gray-800">
        <Chat channelId={channel.id} channelName={channel.name} />
      </div>
    </div>
  );
}
