import { useTrendingStore } from '../stores/trendingStore';
import { VideoCard } from './VideoCard';

export function TrendingList() {
  const { trending, selectedCategory } = useTrendingStore();
  const categoryData = trending[selectedCategory];
  const videos = categoryData?.videos || [];

  if (videos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <svg
          className="w-16 h-16 mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
          />
        </svg>
        <p className="text-lg font-medium">No trending videos yet</p>
        <p className="text-sm mt-1">Click "Simulate Views" to generate activity</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">
          Top {videos.length} Trending
          {selectedCategory !== 'all' && (
            <span className="text-gray-400 font-normal capitalize">
              {' '}in {selectedCategory}
            </span>
          )}
        </h2>
        {categoryData?.updatedAt && (
          <span className="text-xs text-gray-500">
            Updated: {new Date(categoryData.updatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {videos.map((video, index) => (
        <VideoCard key={video.id} video={video} rank={index + 1} />
      ))}
    </div>
  );
}
