import { useRef, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Tweet } from './Tweet';
import { Tweet as TweetType } from '../types';

interface TimelineProps {
  tweets: TweetType[];
  isLoading: boolean;
  error: string | null;
  onLoadMore?: () => void;
  hasMore?: boolean;
  emptyMessage?: string;
}

export function Timeline({
  tweets,
  isLoading,
  error,
  onLoadMore,
  hasMore,
  emptyMessage = 'No tweets yet',
}: TimelineProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Virtual list for tweets with dynamic height measurement
  const virtualizer = useVirtualizer({
    count: tweets.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150, // Estimate tweet height
    overscan: 5, // Render 5 extra items above/below
    measureElement: (element) => {
      return element.getBoundingClientRect().height;
    },
  });

  // Infinite scroll: load more when near bottom
  const handleScroll = useCallback(() => {
    if (!parentRef.current || isLoading || !hasMore || !onLoadMore) return;

    const { scrollTop, scrollHeight, clientHeight } = parentRef.current;
    if (scrollHeight - scrollTop - clientHeight < 500) {
      onLoadMore();
    }
  }, [isLoading, hasMore, onLoadMore]);

  useEffect(() => {
    const parent = parentRef.current;
    if (parent) {
      parent.addEventListener('scroll', handleScroll);
      return () => parent.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  if (error) {
    return (
      <div className="p-8 text-center">
        <p className="text-twitter-like text-[15px]">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 px-5 py-2 bg-twitter-blue text-white rounded-full font-bold text-[15px] hover:bg-twitter-blueHover transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  if (isLoading && tweets.length === 0) {
    return (
      <div className="p-8 text-center">
        <div className="inline-block w-8 h-8 border-4 border-twitter-blue border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-4 text-twitter-gray text-[15px]">Loading tweets...</p>
      </div>
    );
  }

  if (tweets.length === 0) {
    return (
      <div className="p-8 text-center text-twitter-gray text-[15px]">
        <p>{emptyMessage}</p>
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className="h-[calc(100vh-120px)] overflow-auto"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualItem) => {
          const tweet = tweets[virtualItem.index];
          if (!tweet) return null;

          return (
            <div
              key={tweet.id}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <Tweet tweet={tweet} />
            </div>
          );
        })}
      </div>

      {/* Loading indicator */}
      {isLoading && tweets.length > 0 && (
        <div className="p-4 text-center">
          <div className="inline-block w-6 h-6 border-3 border-twitter-blue border-t-transparent rounded-full animate-spin"></div>
        </div>
      )}
    </div>
  );
}
