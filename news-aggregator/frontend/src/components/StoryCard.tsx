import { Link } from '@tanstack/react-router';
import { Clock, Newspaper, TrendingUp, Zap } from 'lucide-react';
import type { Story } from '../types';

interface StoryCardProps {
  story: Story;
  featured?: boolean;
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function StoryCard({ story, featured = false }: StoryCardProps) {
  return (
    <Link
      to="/story/$storyId"
      params={{ storyId: story.id }}
      className={`card block ${featured ? 'col-span-2 row-span-2' : ''}`}
    >
      <div className="flex flex-col h-full">
        <div className="flex items-start gap-2 mb-2">
          {story.is_breaking && (
            <span className="breaking-badge">
              <Zap className="w-3 h-3 inline mr-1" />
              Breaking
            </span>
          )}
          {story.velocity > 0.5 && !story.is_breaking && (
            <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full bg-orange-100 text-orange-700">
              <TrendingUp className="w-3 h-3 mr-1" />
              Trending
            </span>
          )}
          <span className="topic-badge">{story.primary_topic || 'general'}</span>
        </div>

        <h3 className={`font-semibold text-gray-900 mb-2 ${featured ? 'text-xl' : 'text-base'} line-clamp-2`}>
          {story.title}
        </h3>

        <p className={`text-gray-600 mb-3 ${featured ? 'text-base' : 'text-sm'} line-clamp-${featured ? 4 : 2}`}>
          {story.summary}
        </p>

        <div className="mt-auto flex items-center justify-between text-xs text-gray-500">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Newspaper className="w-3 h-3" />
              {story.article_count} article{story.article_count !== 1 ? 's' : ''}
            </span>
            <span>{story.source_count} source{story.source_count !== 1 ? 's' : ''}</span>
          </div>
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatTimeAgo(story.created_at)}
          </span>
        </div>

        {story.articles && story.articles.length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="text-xs text-gray-500 mb-1">From:</div>
            <div className="flex flex-wrap gap-1">
              {story.articles.slice(0, 3).map((article) => (
                <span
                  key={article.id}
                  className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded"
                >
                  {article.source_name}
                </span>
              ))}
              {story.articles.length > 3 && (
                <span className="text-xs text-gray-400">
                  +{story.articles.length - 3} more
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </Link>
  );
}

interface StoryListProps {
  stories: Story[];
  loading?: boolean;
}

export function StoryList({ stories, loading }: StoryListProps) {
  if (loading && stories.length === 0) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="card animate-pulse">
            <div className="h-4 bg-gray-200 rounded w-20 mb-3"></div>
            <div className="h-6 bg-gray-200 rounded mb-2"></div>
            <div className="h-4 bg-gray-200 rounded w-3/4 mb-4"></div>
            <div className="h-3 bg-gray-200 rounded w-1/2"></div>
          </div>
        ))}
      </div>
    );
  }

  if (stories.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Newspaper className="w-12 h-12 mx-auto mb-4 opacity-50" />
        <p>No stories found</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {stories.map((story, index) => (
        <StoryCard key={story.id} story={story} featured={index === 0} />
      ))}
    </div>
  );
}
