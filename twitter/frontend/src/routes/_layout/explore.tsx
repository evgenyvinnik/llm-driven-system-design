import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Timeline } from '../../components/Timeline';
import { useTimelineStore } from '../../stores/timelineStore';

export const Route = createFileRoute('/_layout/explore')({
  component: ExplorePage,
});

function ExplorePage() {
  const { tweets, isLoading, error, nextCursor, fetchExploreTimeline, loadMore } = useTimelineStore();

  useEffect(() => {
    fetchExploreTimeline();
  }, [fetchExploreTimeline]);

  return (
    <div>
      <header className="sticky top-0 bg-white/80 backdrop-blur border-b border-twitter-extraLightGray z-10">
        <h1 className="text-xl font-bold p-4">Explore</h1>
      </header>

      <Timeline
        tweets={tweets}
        isLoading={isLoading}
        error={error}
        onLoadMore={loadMore}
        hasMore={!!nextCursor}
        emptyMessage="No tweets to explore yet. Be the first to tweet!"
      />
    </div>
  );
}
