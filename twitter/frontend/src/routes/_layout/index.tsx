import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ComposeTweet } from '../../components/ComposeTweet';
import { Timeline } from '../../components/Timeline';
import { useTimelineStore } from '../../stores/timelineStore';
import { useAuthStore } from '../../stores/authStore';

export const Route = createFileRoute('/_layout/')({
  component: HomePage,
});

function HomePage() {
  const { user } = useAuthStore();
  const { tweets, isLoading, error, nextCursor, fetchHomeTimeline, fetchExploreTimeline, loadMore } = useTimelineStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) {
      fetchHomeTimeline();
    } else {
      fetchExploreTimeline();
    }
  }, [user, fetchHomeTimeline, fetchExploreTimeline]);

  return (
    <div>
      <header className="sticky top-0 bg-white/80 backdrop-blur border-b border-twitter-extraLightGray z-10">
        <h1 className="text-xl font-bold p-4">Home</h1>
      </header>

      {user && <ComposeTweet />}

      <Timeline
        tweets={tweets}
        isLoading={isLoading}
        error={error}
        onLoadMore={loadMore}
        hasMore={!!nextCursor}
        emptyMessage={user ? "No tweets yet. Follow some people to see their tweets here!" : "Welcome! Sign up or log in to see your personalized timeline."}
      />
    </div>
  );
}
