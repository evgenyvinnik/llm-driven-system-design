import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useCallback } from 'react';
import { StoryList, TopicBadges } from '../components';
import { feedApi } from '../services/api';
import { useFeedStore } from '../stores';
import type { Topic } from '../types';
import { RefreshCw, Zap } from 'lucide-react';

export const Route = createFileRoute('/')({
  loader: async () => {
    const [feedResponse, topicsResponse, breakingResponse] = await Promise.all([
      feedApi.getFeed(),
      feedApi.getTopics(),
      feedApi.getBreaking(),
    ]);
    return {
      initialFeed: feedResponse,
      topics: topicsResponse.topics,
      breaking: breakingResponse.stories,
    };
  },
  component: HomePage,
});

function HomePage() {
  const { initialFeed, topics, breaking } = Route.useLoaderData();
  const {
    stories,
    cursor,
    hasMore,
    isLoading,
    selectedTopic,
    setStories,
    appendStories,
    setLoading,
    setSelectedTopic,
  } = useFeedStore();

  useEffect(() => {
    if (stories.length === 0 && !selectedTopic) {
      setStories(initialFeed.stories, initialFeed.next_cursor, initialFeed.has_more);
    }
  }, [initialFeed, stories.length, selectedTopic, setStories]);

  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore) return;

    setLoading(true);
    try {
      const response = selectedTopic
        ? await feedApi.getTopicFeed(selectedTopic, cursor || undefined)
        : await feedApi.getFeed(cursor || undefined);
      appendStories(response.stories, response.next_cursor, response.has_more);
    } finally {
      setLoading(false);
    }
  }, [isLoading, hasMore, cursor, selectedTopic, setLoading, appendStories]);

  const handleTopicChange = async (topic: string | null) => {
    setSelectedTopic(topic);
    setLoading(true);
    try {
      const response = topic
        ? await feedApi.getTopicFeed(topic)
        : await feedApi.getFeed();
      setStories(response.stories, response.next_cursor, response.has_more);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const response = selectedTopic
        ? await feedApi.getTopicFeed(selectedTopic)
        : await feedApi.getFeed();
      setStories(response.stories, response.next_cursor, response.has_more);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Breaking News Banner */}
      {breaking.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-5 h-5 text-red-600" />
            <h2 className="font-bold text-red-800">Breaking News</h2>
          </div>
          <ul className="space-y-1">
            {breaking.slice(0, 3).map((story) => (
              <li key={story.id}>
                <a
                  href={`/story/${story.id}`}
                  className="text-red-700 hover:text-red-900 hover:underline"
                >
                  {story.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Topic Filter */}
      <div className="flex items-center justify-between">
        <TopicBadges
          topics={topics}
          selected={selectedTopic}
          onSelect={handleTopicChange}
        />
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className="btn btn-outline"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Story List */}
      <StoryList stories={stories} loading={isLoading} />

      {/* Load More */}
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
