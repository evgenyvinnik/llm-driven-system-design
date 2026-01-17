import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Channel, Video, PaginatedResponse } from '../types';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import VideoCard from '../components/VideoCard';
import { formatSubscriberCount, getAvatarUrl } from '../utils/format';

export const Route = createFileRoute('/channel/$channelId')({
  component: ChannelPage,
});

function ChannelPage() {
  const { channelId } = Route.useParams();
  const { user } = useAuthStore();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubscribed, setIsSubscribed] = useState(false);

  useEffect(() => {
    fetchChannel();
    fetchChannelVideos();
  }, [channelId]);

  const fetchChannel = async () => {
    try {
      const ch = await api.get<Channel>(`/channels/${channelId}`);
      setChannel(ch);
      setIsSubscribed(ch.isSubscribed || false);
    } catch (error) {
      console.error('Failed to fetch channel:', error);
    }
  };

  const fetchChannelVideos = async () => {
    setIsLoading(true);
    try {
      const response = await api.get<PaginatedResponse<Video>>(`/channels/${channelId}/videos`);
      setVideos(response.videos || []);
    } catch (error) {
      console.error('Failed to fetch channel videos:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubscribe = async () => {
    if (!user || !channel) return;

    try {
      if (isSubscribed) {
        await api.delete(`/channels/${channel.id}/subscribe`);
        setIsSubscribed(false);
        setChannel({ ...channel, subscriberCount: channel.subscriberCount - 1 });
      } else {
        await api.post(`/channels/${channel.id}/subscribe`);
        setIsSubscribed(true);
        setChannel({ ...channel, subscriberCount: channel.subscriberCount + 1 });
      }
    } catch (error) {
      console.error('Failed to toggle subscription:', error);
    }
  };

  if (!channel) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-white border-t-transparent rounded-full" />
      </div>
    );
  }

  const isOwnChannel = user?.id === channel.id;

  return (
    <div>
      {/* Channel header */}
      <div className="bg-yt-dark-lighter">
        {/* Banner placeholder */}
        <div className="h-32 bg-gradient-to-r from-gray-800 to-gray-700" />

        {/* Channel info */}
        <div className="max-w-6xl mx-auto px-6 py-4">
          <div className="flex items-start gap-6">
            <img
              src={getAvatarUrl(channel.avatarUrl, channel.username)}
              alt={channel.name}
              className="w-20 h-20 rounded-full -mt-8"
            />

            <div className="flex-1">
              <h1 className="text-2xl font-bold">{channel.name}</h1>
              <div className="flex items-center gap-2 text-sm text-gray-400 mt-1">
                <span>@{channel.username}</span>
                <span>-</span>
                <span>{formatSubscriberCount(channel.subscriberCount)}</span>
                <span>-</span>
                <span>{channel.videoCount || 0} videos</span>
              </div>
              {channel.description && (
                <p className="text-sm text-gray-400 mt-2 line-clamp-2">{channel.description}</p>
              )}
            </div>

            {isOwnChannel ? (
              <Link to="/studio" className="btn-secondary">
                Customize channel
              </Link>
            ) : user ? (
              <button
                onClick={handleSubscribe}
                className={isSubscribed ? 'btn-subscribed' : 'btn-subscribe'}
              >
                {isSubscribed ? 'Subscribed' : 'Subscribe'}
              </button>
            ) : null}
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-6xl mx-auto px-6 border-b border-gray-700">
          <nav className="flex gap-6">
            <button className="py-3 border-b-2 border-white font-medium">Videos</button>
            <button className="py-3 text-gray-400 hover:text-white">About</button>
          </nav>
        </div>
      </div>

      {/* Videos grid */}
      <div className="max-w-6xl mx-auto px-6 py-6">
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="animate-pulse">
                <div className="bg-yt-dark-hover aspect-video rounded-xl mb-3" />
                <div className="h-4 bg-yt-dark-hover rounded mb-2" />
                <div className="h-3 bg-yt-dark-hover rounded w-2/3" />
              </div>
            ))}
          </div>
        ) : videos.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 text-lg">No videos uploaded yet</p>
            {isOwnChannel && (
              <p className="text-gray-500 mt-2">
                Upload your first video to get started!
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {videos.map((video) => (
              <VideoCard key={video.id} video={video} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
