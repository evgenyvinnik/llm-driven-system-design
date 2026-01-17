import { createFileRoute, useParams, Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Timeline } from '../../components/Timeline';
import { useTimelineStore } from '../../stores/timelineStore';

export const Route = createFileRoute('/_layout/hashtag/$tag')({
  component: HashtagPage,
});

function HashtagPage() {
  const { tag } = useParams({ from: '/_layout/hashtag/$tag' });
  const { tweets, isLoading, error, nextCursor, fetchHashtagTimeline, loadMore } = useTimelineStore();

  useEffect(() => {
    fetchHashtagTimeline(tag);
  }, [tag, fetchHashtagTimeline]);

  return (
    <div>
      <header className="sticky top-0 bg-white/80 backdrop-blur border-b border-twitter-extraLightGray z-10">
        <div className="flex items-center gap-4 p-4">
          <Link to="/" className="p-2 hover:bg-gray-100 rounded-full">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </Link>
          <h1 className="text-xl font-bold">#{tag}</h1>
        </div>
      </header>

      <Timeline
        tweets={tweets}
        isLoading={isLoading}
        error={error}
        onLoadMore={loadMore}
        hasMore={!!nextCursor}
        emptyMessage={`No tweets with #${tag} yet`}
      />
    </div>
  );
}
