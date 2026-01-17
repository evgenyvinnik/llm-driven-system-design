import { createFileRoute, Link } from '@tanstack/react-router';
import { feedApi } from '../services/api';
import { StoryList } from '../components';
import { ArrowLeft, Tag } from 'lucide-react';
import { useState } from 'react';

export const Route = createFileRoute('/topics/$topic')({
  loader: async ({ params }) => {
    const response = await feedApi.getTopicFeed(params.topic);
    return {
      topic: params.topic,
      initialFeed: response,
    };
  },
  component: TopicPage,
});

function TopicPage() {
  const { topic, initialFeed } = Route.useLoaderData();
  const [stories, setStories] = useState(initialFeed.stories);
  const [cursor, setCursor] = useState(initialFeed.next_cursor);
  const [hasMore, setHasMore] = useState(initialFeed.has_more);
  const [isLoading, setIsLoading] = useState(false);

  const loadMore = async () => {
    if (isLoading || !hasMore || !cursor) return;

    setIsLoading(true);
    try {
      const response = await feedApi.getTopicFeed(topic, cursor);
      setStories([...stories, ...response.stories]);
      setCursor(response.next_cursor);
      setHasMore(response.has_more);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <Link to="/topics" className="inline-flex items-center text-gray-600 hover:text-gray-900">
        <ArrowLeft className="w-4 h-4 mr-2" />
        All Topics
      </Link>

      <div className="flex items-center gap-3">
        <Tag className="w-8 h-8 text-primary-500" />
        <h1 className="text-2xl font-bold text-gray-900 capitalize">{topic}</h1>
      </div>

      <StoryList stories={stories} loading={isLoading} />

      {hasMore && stories.length > 0 && (
        <div className="text-center">
          <button
            onClick={loadMore}
            disabled={isLoading}
            className="btn btn-primary"
          >
            {isLoading ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}
    </div>
  );
}
