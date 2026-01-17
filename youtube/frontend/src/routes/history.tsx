import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { Video, PaginatedResponse } from '../types';
import { api } from '../services/api';
import VideoCard from '../components/VideoCard';

interface HistoryVideo extends Video {
  watchedAt: string;
  watchPercentage: number;
  resumePosition: number;
}

export const Route = createFileRoute('/history')({
  component: HistoryPage,
});

function HistoryPage() {
  const { user } = useAuthStore();
  const [videos, setVideos] = useState<HistoryVideo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (user) {
      fetchHistory();
    }
  }, [user]);

  const fetchHistory = async () => {
    setIsLoading(true);
    try {
      const response = await api.get<PaginatedResponse<HistoryVideo>>('/feed/history');
      setVideos(response.videos || []);
    } catch (error) {
      console.error('Failed to fetch history:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (!user) {
    return <Navigate to="/" />;
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Watch history</h1>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(10)].map((_, i) => (
            <div key={i} className="flex gap-4 animate-pulse">
              <div className="bg-yt-dark-hover aspect-video w-64 rounded-xl" />
              <div className="flex-1">
                <div className="h-5 bg-yt-dark-hover rounded mb-2" />
                <div className="h-4 bg-yt-dark-hover rounded w-1/3 mb-2" />
                <div className="h-3 bg-yt-dark-hover rounded w-1/4" />
              </div>
            </div>
          ))}
        </div>
      ) : videos.length === 0 ? (
        <div className="text-center py-12">
          <svg className="w-24 h-24 text-gray-600 mx-auto mb-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
          </svg>
          <p className="text-gray-400 text-lg mb-2">No watch history</p>
          <p className="text-gray-500">
            Videos you watch will show up here
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {videos.map((video) => (
            <div key={video.id} className="relative">
              <VideoCard video={video} layout="list" />
              {video.watchPercentage > 0 && (
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-700">
                  <div
                    className="h-full bg-red-500"
                    style={{ width: `${Math.min(video.watchPercentage, 100)}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
