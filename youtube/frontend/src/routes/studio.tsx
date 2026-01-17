import { createFileRoute, Navigate, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { Video, PaginatedResponse } from '../types';
import { api } from '../services/api';
import { formatViewCount, formatDuration, timeAgo, getPlaceholderThumbnail } from '../utils/format';

export const Route = createFileRoute('/studio')({
  component: StudioPage,
});

function StudioPage() {
  const { user } = useAuthStore();
  const [videos, setVideos] = useState<Video[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (user) {
      fetchMyVideos();
    }
  }, [user]);

  const fetchMyVideos = async () => {
    setIsLoading(true);
    try {
      const response = await api.get<PaginatedResponse<Video>>(`/videos?channelId=${user!.id}`);
      setVideos(response.videos || []);
    } catch (error) {
      console.error('Failed to fetch videos:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (videoId: string) => {
    if (!confirm('Are you sure you want to delete this video?')) return;

    try {
      await api.delete(`/videos/${videoId}`);
      setVideos(videos.filter(v => v.id !== videoId));
    } catch (error) {
      console.error('Failed to delete video:', error);
    }
  };

  if (!user) {
    return <Navigate to="/" />;
  }

  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Channel content</h1>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex gap-4 animate-pulse bg-yt-dark-lighter p-4 rounded-lg">
                <div className="bg-yt-dark-hover w-40 h-24 rounded" />
                <div className="flex-1">
                  <div className="h-5 bg-yt-dark-hover rounded mb-2 w-3/4" />
                  <div className="h-4 bg-yt-dark-hover rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : videos.length === 0 ? (
          <div className="text-center py-12 bg-yt-dark-lighter rounded-lg">
            <svg className="w-24 h-24 text-gray-600 mx-auto mb-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>
            </svg>
            <p className="text-gray-400 text-lg mb-4">No videos uploaded yet</p>
            <p className="text-gray-500">
              Click the upload button in the header to upload your first video
            </p>
          </div>
        ) : (
          <div className="bg-yt-dark-lighter rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-700 text-left text-sm text-gray-400">
                  <th className="p-4">Video</th>
                  <th className="p-4">Visibility</th>
                  <th className="p-4">Status</th>
                  <th className="p-4">Date</th>
                  <th className="p-4">Views</th>
                  <th className="p-4">Likes</th>
                  <th className="p-4">Comments</th>
                  <th className="p-4"></th>
                </tr>
              </thead>
              <tbody>
                {videos.map((video) => (
                  <tr key={video.id} className="border-b border-gray-800 hover:bg-yt-dark-hover">
                    <td className="p-4">
                      <div className="flex gap-3">
                        <Link to="/watch/$videoId" params={{ videoId: video.id }}>
                          <div className="w-32 aspect-video bg-gray-800 rounded overflow-hidden flex-shrink-0">
                            <img
                              src={video.thumbnailUrl || getPlaceholderThumbnail(video.title)}
                              alt={video.title}
                              className="w-full h-full object-cover"
                            />
                          </div>
                        </Link>
                        <div className="min-w-0">
                          <Link to="/watch/$videoId" params={{ videoId: video.id }}>
                            <p className="font-medium line-clamp-2 hover:text-yt-blue">
                              {video.title}
                            </p>
                          </Link>
                          <p className="text-xs text-gray-400 mt-1">
                            {video.description?.substring(0, 100) || 'No description'}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="p-4">
                      <span className={`text-sm px-2 py-1 rounded ${
                        video.visibility === 'public' ? 'bg-green-900 text-green-300' :
                        video.visibility === 'unlisted' ? 'bg-yellow-900 text-yellow-300' :
                        'bg-gray-700 text-gray-300'
                      }`}>
                        {video.visibility}
                      </span>
                    </td>
                    <td className="p-4">
                      <span className={`text-sm ${
                        video.status === 'ready' ? 'text-green-400' :
                        video.status === 'processing' ? 'text-yellow-400' :
                        video.status === 'failed' ? 'text-red-400' :
                        'text-gray-400'
                      }`}>
                        {video.status}
                      </span>
                    </td>
                    <td className="p-4 text-sm text-gray-400">
                      {timeAgo(video.publishedAt || video.createdAt)}
                    </td>
                    <td className="p-4 text-sm">
                      {video.viewCount.toLocaleString()}
                    </td>
                    <td className="p-4 text-sm">
                      {video.likeCount.toLocaleString()}
                    </td>
                    <td className="p-4 text-sm">
                      {video.commentCount.toLocaleString()}
                    </td>
                    <td className="p-4">
                      <button
                        onClick={() => handleDelete(video.id)}
                        className="p-2 hover:bg-red-900/50 rounded text-red-400"
                        title="Delete video"
                      >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
