import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { feedApi } from '@/services/api';
import { Video } from '@/types';

export const Route = createFileRoute('/discover')({
  component: DiscoverPage,
});

function DiscoverPage() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Video[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    setHasSearched(true);

    try {
      const response = await feedApi.search(searchQuery.trim()) as { videos: Video[] };
      setSearchResults(response.videos);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const trendingHashtags = [
    'dance', 'funny', 'viral', 'fyp', 'trending',
    'comedy', 'music', 'pet', 'food', 'travel'
  ];

  return (
    <div className="flex-1 flex flex-col pb-14 overflow-y-auto">
      {/* Search Header */}
      <div className="p-4 bg-black sticky top-0 z-10">
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search videos and users"
            className="input flex-1"
          />
          <button type="submit" className="btn-primary px-4">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
        </form>
      </div>

      {isSearching ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="spinner"></div>
        </div>
      ) : hasSearched ? (
        <div className="p-4">
          <h2 className="text-lg font-semibold mb-4">
            Results for "{searchQuery}"
          </h2>
          {searchResults.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No results found</p>
          ) : (
            <div className="grid grid-cols-3 gap-0.5">
              {searchResults.map((video) => (
                <VideoThumbnail key={video.id} video={video} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="p-4">
          {/* Trending Hashtags */}
          <h2 className="text-lg font-semibold mb-4">Trending Hashtags</h2>
          <div className="flex flex-wrap gap-2 mb-8">
            {trendingHashtags.map((tag) => (
              <button
                key={tag}
                onClick={() => {
                  setSearchQuery(`#${tag}`);
                  setHasSearched(true);
                  feedApi.getHashtag(tag).then((response) => {
                    setSearchResults((response as { videos: Video[] }).videos);
                  });
                }}
                className="px-3 py-1.5 bg-gray-800 rounded-full text-sm hover:bg-gray-700 transition-colors"
              >
                #{tag}
              </button>
            ))}
          </div>

          {/* Categories */}
          <h2 className="text-lg font-semibold mb-4">Browse</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              { name: 'Trending', icon: '🔥', color: 'from-orange-600 to-red-600' },
              { name: 'Comedy', icon: '😂', color: 'from-yellow-600 to-orange-600' },
              { name: 'Dance', icon: '💃', color: 'from-pink-600 to-purple-600' },
              { name: 'Music', icon: '🎵', color: 'from-purple-600 to-blue-600' },
              { name: 'Sports', icon: '⚽', color: 'from-green-600 to-teal-600' },
              { name: 'Food', icon: '🍕', color: 'from-red-600 to-pink-600' },
            ].map((category) => (
              <button
                key={category.name}
                onClick={() => {
                  setSearchQuery(category.name.toLowerCase());
                  setHasSearched(true);
                  feedApi.search(category.name.toLowerCase()).then((response) => {
                    setSearchResults((response as { videos: Video[] }).videos);
                  });
                }}
                className={`p-4 rounded-lg bg-gradient-to-br ${category.color} flex items-center gap-3`}
              >
                <span className="text-2xl">{category.icon}</span>
                <span className="font-semibold">{category.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function VideoThumbnail({ video }: { video: Video }) {
  const formatCount = (count: number): string => {
    if (count >= 1000000) {
      return (count / 1000000).toFixed(1) + 'M';
    }
    if (count >= 1000) {
      return (count / 1000).toFixed(1) + 'K';
    }
    return count.toString();
  };

  return (
    <div className="aspect-[9/16] bg-gray-800 relative group cursor-pointer">
      {video.thumbnailUrl ? (
        <img
          src={video.thumbnailUrl}
          alt={video.description}
          className="w-full h-full object-cover"
        />
      ) : (
        <video
          src={video.videoUrl}
          className="w-full h-full object-cover"
          muted
          preload="metadata"
        />
      )}
      <div className="absolute bottom-1 left-1 flex items-center gap-1 text-xs text-white">
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 5v14l11-7z" />
        </svg>
        {formatCount(video.viewCount)}
      </div>
      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
        <p className="text-xs text-white truncate">{video.description || 'No description'}</p>
      </div>
    </div>
  );
}
