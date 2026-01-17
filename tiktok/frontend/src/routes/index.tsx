import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useCallback } from 'react';
import { useFeedStore } from '@/stores/feedStore';
import VideoPlayer from '@/components/VideoPlayer';
import VideoActions from '@/components/VideoActions';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const { videos, currentIndex, isLoading, feedType, setFeedType, loadMore, setCurrentIndex } = useFeedStore();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (videos.length === 0) {
      loadMore();
    }
  }, [videos.length, loadMore]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const scrollTop = container.scrollTop;
    const itemHeight = container.clientHeight;
    const newIndex = Math.round(scrollTop / itemHeight);

    if (newIndex !== currentIndex && newIndex >= 0 && newIndex < videos.length) {
      setCurrentIndex(newIndex);
    }
  }, [currentIndex, videos.length, setCurrentIndex]);

  return (
    <div className="flex-1 relative pb-14">
      {/* Feed Type Tabs */}
      <div className="absolute top-0 left-0 right-0 z-40 flex justify-center gap-4 pt-4 pb-2 bg-gradient-to-b from-black/80 to-transparent">
        <button
          onClick={() => setFeedType('following')}
          className={`text-sm font-semibold px-2 py-1 ${
            feedType === 'following' ? 'text-white border-b-2 border-white' : 'text-gray-400'
          }`}
        >
          Following
        </button>
        <span className="text-gray-600">|</span>
        <button
          onClick={() => setFeedType('fyp')}
          className={`text-sm font-semibold px-2 py-1 ${
            feedType === 'fyp' ? 'text-white border-b-2 border-white' : 'text-gray-400'
          }`}
        >
          For You
        </button>
      </div>

      {/* Video Feed */}
      <div
        ref={containerRef}
        className="video-scroll hide-scrollbar h-full"
        onScroll={handleScroll}
      >
        {videos.length === 0 && !isLoading ? (
          <div className="h-full flex items-center justify-center text-gray-500">
            <div className="text-center">
              <p className="text-lg mb-2">No videos yet</p>
              <p className="text-sm">Be the first to upload!</p>
            </div>
          </div>
        ) : (
          videos.map((video, index) => (
            <div key={video.id} className="video-item h-full relative">
              <VideoPlayer
                video={video}
                isActive={index === currentIndex}
              />
              <VideoActions video={video} />
              <VideoInfo video={video} />
            </div>
          ))
        )}

        {isLoading && (
          <div className="h-full flex items-center justify-center">
            <div className="spinner"></div>
          </div>
        )}
      </div>
    </div>
  );
}

function VideoInfo({ video }: { video: { creatorUsername: string; creatorDisplayName: string; description: string; hashtags: string[] } }) {
  return (
    <div className="absolute bottom-16 left-0 right-16 p-4 bg-gradient-to-t from-black/60 to-transparent">
      <p className="font-bold text-white">@{video.creatorUsername}</p>
      <p className="text-sm text-white mt-1">{video.description}</p>
      {video.hashtags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {video.hashtags.slice(0, 5).map((tag) => (
            <span key={tag} className="text-xs text-white/80">
              #{tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
