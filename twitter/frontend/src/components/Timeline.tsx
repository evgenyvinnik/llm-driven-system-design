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
  if (error) {
    return (
      <div className="p-8 text-center">
        <p className="text-red-500">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 px-4 py-2 bg-twitter-blue text-white rounded-full hover:bg-blue-600"
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
        <p className="mt-4 text-twitter-gray">Loading tweets...</p>
      </div>
    );
  }

  if (tweets.length === 0) {
    return (
      <div className="p-8 text-center text-twitter-gray">
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div>
      {tweets.map((tweet) => (
        <Tweet key={tweet.id} tweet={tweet} />
      ))}

      {hasMore && onLoadMore && (
        <div className="p-4 text-center">
          <button
            onClick={onLoadMore}
            disabled={isLoading}
            className="px-6 py-2 text-twitter-blue hover:bg-blue-50 rounded-full transition-colors disabled:opacity-50"
          >
            {isLoading ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
