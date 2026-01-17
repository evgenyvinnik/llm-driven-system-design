/**
 * Story detail page route.
 * Displays full story information with all source articles.
 * @module routes/story.$storyId
 */

import { createFileRoute, Link } from '@tanstack/react-router';
import { feedApi } from '../services/api';
import { Clock, ExternalLink, Newspaper, TrendingUp, Zap, ArrowLeft } from 'lucide-react';

/**
 * Story page route configuration.
 * Loads story by ID from URL parameter.
 */
export const Route = createFileRoute('/story/$storyId')({
  loader: async ({ params }) => {
    const story = await feedApi.getStory(params.storyId);
    return { story };
  },
  component: StoryPage,
});

/**
 * Format a date as a human-readable string.
 * @param dateString - ISO 8601 timestamp string
 * @returns Formatted date string (e.g., "Monday, January 1, 2024, 12:00 PM")
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Story detail page component.
 * Shows story headline, summary, topics, and all article sources.
 * @returns Story detail page with article list
 */
function StoryPage() {
  const { story } = Route.useLoaderData();

  return (
    <div className="max-w-4xl mx-auto">
      <Link to="/" className="inline-flex items-center text-gray-600 hover:text-gray-900 mb-6">
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Feed
      </Link>

      <article className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-8">
        <div className="flex items-center gap-2 mb-4">
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
          {story.topics.map((topic) => (
            <Link
              key={topic}
              to="/topics/$topic"
              params={{ topic }}
              className="topic-badge hover:bg-primary-200"
            >
              {topic}
            </Link>
          ))}
        </div>

        <h1 className="text-3xl font-bold text-gray-900 mb-4">{story.title}</h1>

        <p className="text-lg text-gray-600 mb-6">{story.summary}</p>

        <div className="flex items-center gap-6 text-sm text-gray-500 border-t border-gray-100 pt-4">
          <span className="flex items-center gap-1">
            <Newspaper className="w-4 h-4" />
            {story.article_count} article{story.article_count !== 1 ? 's' : ''}
          </span>
          <span>{story.source_count} source{story.source_count !== 1 ? 's' : ''}</span>
          <span className="flex items-center gap-1">
            <Clock className="w-4 h-4" />
            {formatDate(story.created_at)}
          </span>
        </div>
      </article>

      <h2 className="text-xl font-bold text-gray-900 mb-4">
        Coverage from {story.source_count} source{story.source_count !== 1 ? 's' : ''}
      </h2>

      <div className="space-y-4">
        {story.articles?.map((article) => (
          <a
            key={article.id}
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="card block hover:border-primary-300"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="text-sm font-medium text-primary-600 mb-1">
                  {article.source_name}
                </div>
                <h3 className="font-semibold text-gray-900 mb-2">{article.title}</h3>
                <p className="text-sm text-gray-600 line-clamp-2">{article.summary}</p>
                <div className="mt-2 text-xs text-gray-500">
                  {formatDate(article.published_at)}
                </div>
              </div>
              <ExternalLink className="w-5 h-5 text-gray-400 flex-shrink-0" />
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
