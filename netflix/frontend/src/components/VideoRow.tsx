/**
 * VideoRow Component
 *
 * Horizontal scrollable row of video cards.
 * Used for displaying content categories on the homepage.
 * Features: row title, horizontal scroll with arrow navigation.
 */
import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { VideoCard } from './VideoCard';
import type { Video } from '../types';

/** Props for VideoRow component */
interface VideoRowProps {
  /** Row title displayed above the cards */
  title: string;
  /** Videos to display in the row */
  videos: Video[];
  /** Whether to show progress bars on cards */
  showProgress?: boolean;
  /** Map of video IDs to progress percentages */
  progressMap?: Record<string, number>;
}

/**
 * Horizontal scrollable row of video cards.
 * Supports arrow-based navigation when content overflows.
 */
export function VideoRow({ title, videos, showProgress, progressMap }: VideoRowProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [showLeftArrow, setShowLeftArrow] = React.useState(false);
  const [showRightArrow, setShowRightArrow] = React.useState(true);

  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
      setShowLeftArrow(scrollLeft > 0);
      setShowRightArrow(scrollLeft < scrollWidth - clientWidth - 10);
    }
  };

  const scroll = (direction: 'left' | 'right') => {
    if (scrollRef.current) {
      const scrollAmount = scrollRef.current.clientWidth * 0.8;
      scrollRef.current.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth',
      });
    }
  };

  React.useEffect(() => {
    handleScroll();
  }, [videos]);

  if (videos.length === 0) return null;

  return (
    <div className="relative group py-4">
      {/* Title */}
      <h2 className="row-title">{title}</h2>

      {/* Scroll container */}
      <div className="relative">
        {/* Left arrow */}
        {showLeftArrow && (
          <button
            onClick={() => scroll('left')}
            className="absolute left-0 top-0 bottom-0 z-10 w-12 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <ChevronLeft size={40} className="text-white" />
          </button>
        )}

        {/* Videos */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex gap-2 overflow-x-auto scrollbar-hide px-4 md:px-12"
        >
          {videos.map((video) => (
            <VideoCard
              key={video.id}
              video={video}
              showProgress={showProgress}
              progressPercent={progressMap?.[video.id]}
            />
          ))}
        </div>

        {/* Right arrow */}
        {showRightArrow && (
          <button
            onClick={() => scroll('right')}
            className="absolute right-0 top-0 bottom-0 z-10 w-12 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <ChevronRight size={40} className="text-white" />
          </button>
        )}
      </div>
    </div>
  );
}
