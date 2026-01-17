import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useVideoStore } from '../stores/videoStore';
import VideoCard from '../components/VideoCard';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const { recommendations, searchResults, searchQuery, isLoading, fetchRecommendations } = useVideoStore();

  useEffect(() => {
    if (!searchQuery) {
      fetchRecommendations();
    }
  }, [fetchRecommendations, searchQuery]);

  const displayVideos = searchQuery ? searchResults : recommendations;
  const title = searchQuery ? `Search results for "${searchQuery}"` : 'Recommended';

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">{title}</h1>

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
      ) : displayVideos.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-400 text-lg">
            {searchQuery ? 'No videos found' : 'No recommendations available'}
          </p>
          {!searchQuery && (
            <p className="text-gray-500 mt-2">
              Upload some videos to get started!
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {displayVideos.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
      )}
    </div>
  );
}
