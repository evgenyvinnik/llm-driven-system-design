import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { Video, PaginatedResponse } from '../types';
import { api } from '../services/api';
import VideoCard from '../components/VideoCard';

export const Route = createFileRoute('/subscriptions')({
  component: SubscriptionsPage,
});

function SubscriptionsPage() {
  const { user } = useAuthStore();
  const [videos, setVideos] = useState<Video[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (user) {
      fetchSubscriptionFeed();
    }
  }, [user]);

  const fetchSubscriptionFeed = async () => {
    setIsLoading(true);
    try {
      const response = await api.get<PaginatedResponse<Video>>('/feed/subscriptions');
      setVideos(response.videos || []);
    } catch (error) {
      console.error('Failed to fetch subscription feed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (!user) {
    return <Navigate to="/" />;
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Subscriptions</h1>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="animate-pulse">
              <div className="bg-yt-dark-hover aspect-video rounded-xl mb-3" />
              <div className="flex gap-3">
                <div className="w-9 h-9 bg-yt-dark-hover rounded-full" />
                <div className="flex-1">
                  <div className="h-4 bg-yt-dark-hover rounded mb-2" />
                  <div className="h-3 bg-yt-dark-hover rounded w-2/3" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : videos.length === 0 ? (
        <div className="text-center py-12">
          <svg className="w-24 h-24 text-gray-600 mx-auto mb-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M10 18v-6l5 3-5 3zm7-15H7v2h10V3zm3 4H4v2h16V7zm2 4H2v10h20V11z"/>
          </svg>
          <p className="text-gray-400 text-lg mb-2">No subscription videos</p>
          <p className="text-gray-500">
            Videos from channels you subscribe to will show up here
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {videos.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
      )}
    </div>
  );
}
