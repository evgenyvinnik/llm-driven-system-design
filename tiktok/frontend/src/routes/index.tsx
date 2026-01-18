import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useCallback, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useFeedStore } from '@/stores/feedStore';
import VideoPlayer from '@/components/VideoPlayer';
import VideoActions from '@/components/VideoActions';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const { videos, currentIndex, isLoading, feedType, setFeedType, loadMore, setCurrentIndex } = useFeedStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(0);

  // Measure container height for full-screen video items
  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        setContainerHeight(containerRef.current.clientHeight);
      }
    };
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  useEffect(() => {
    if (videos.length === 0) {
      loadMore();
    }
  }, [videos.length, loadMore]);

  // Virtual list for full-screen video scrolling
  const virtualizer = useVirtualizer({
    count: videos.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => containerHeight || window.innerHeight,
    overscan: 1, // Only render 1 extra video above/below for smooth transitions
  });

  // Handle scroll to update current video index
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || containerHeight === 0) return;

    const scrollTop = container.scrollTop;
    const newIndex = Math.round(scrollTop / containerHeight);

    if (newIndex !== currentIndex && newIndex >= 0 && newIndex < videos.length) {
      setCurrentIndex(newIndex);
    }

    // Load more when approaching the end
    if (newIndex >= videos.length - 3 && !isLoading) {
      loadMore();
    }
  }, [currentIndex, videos.length, containerHeight, setCurrentIndex, isLoading, loadMore]);

  const virtualItems = virtualizer.getVirtualItems();

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

      {/* Video Feed - Virtualized */}
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
        ) : containerHeight > 0 ? (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((virtualItem) => {
              const video = videos[virtualItem.index];
              if (!video) return null;

              return (
                <div
                  key={video.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${containerHeight}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                  className="video-item relative"
                >
                  <VideoPlayer
                    video={video}
                    isActive={virtualItem.index === currentIndex}
                  />
                  <VideoActions video={video} />
                  <VideoInfo video={video} />
                </div>
              );
            })}
          </div>
        ) : null}

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
