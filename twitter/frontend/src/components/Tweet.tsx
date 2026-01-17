import { Link } from '@tanstack/react-router';
import { Tweet as TweetType } from '../types';
import { formatRelativeTime, formatNumber, parseContent } from '../utils/format';
import { useAuthStore } from '../stores/authStore';
import { useTimelineStore } from '../stores/timelineStore';

interface TweetProps {
  tweet: TweetType;
  showActions?: boolean;
}

export function Tweet({ tweet, showActions = true }: TweetProps) {
  const { user } = useAuthStore();
  const { likeTweet, unlikeTweet, retweet, unretweet } = useTimelineStore();

  const displayTweet = tweet.originalTweet || tweet;
  const isRetweet = !!tweet.originalTweet;

  const handleLike = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user) return;

    if (displayTweet.isLiked) {
      await unlikeTweet(displayTweet.id);
    } else {
      await likeTweet(displayTweet.id);
    }
  };

  const handleRetweet = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user) return;

    if (displayTweet.isRetweeted) {
      await unretweet(displayTweet.id);
    } else {
      await retweet(displayTweet.id);
    }
  };

  return (
    <article className="border-b border-twitter-extraLightGray hover:bg-gray-50 transition-colors">
      {isRetweet && (
        <div className="flex items-center gap-2 px-4 pt-2 text-sm text-twitter-gray">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M23.77 15.67c-.292-.293-.767-.293-1.06 0l-2.22 2.22V7.65c0-2.068-1.683-3.75-3.75-3.75h-5.85c-.414 0-.75.336-.75.75s.336.75.75.75h5.85c1.24 0 2.25 1.01 2.25 2.25v10.24l-2.22-2.22c-.293-.293-.768-.293-1.06 0s-.294.768 0 1.06l3.5 3.5c.145.147.337.22.53.22s.383-.072.53-.22l3.5-3.5c.294-.292.294-.767 0-1.06zm-10.66 3.28H7.26c-1.24 0-2.25-1.01-2.25-2.25V6.46l2.22 2.22c.148.147.34.22.532.22s.384-.073.53-.22c.293-.293.293-.768 0-1.06l-3.5-3.5c-.293-.294-.768-.294-1.06 0l-3.5 3.5c-.294.292-.294.767 0 1.06s.767.293 1.06 0l2.22-2.22V16.7c0 2.068 1.683 3.75 3.75 3.75h5.85c.414 0 .75-.336.75-.75s-.337-.75-.75-.75z" />
          </svg>
          <span>{tweet.author.displayName} retweeted</span>
        </div>
      )}

      <div className="flex gap-3 p-4">
        <Link to={`/${displayTweet.author.username}`} className="flex-shrink-0">
          <div className="w-12 h-12 rounded-full bg-twitter-blue flex items-center justify-center text-white font-bold text-lg">
            {displayTweet.author.displayName.charAt(0).toUpperCase()}
          </div>
        </Link>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 flex-wrap">
            <Link
              to={`/${displayTweet.author.username}`}
              className="font-bold text-twitter-dark hover:underline"
            >
              {displayTweet.author.displayName}
            </Link>
            <Link
              to={`/${displayTweet.author.username}`}
              className="text-twitter-gray"
            >
              @{displayTweet.author.username}
            </Link>
            <span className="text-twitter-gray">·</span>
            <span className="text-twitter-gray">
              {formatRelativeTime(displayTweet.createdAt)}
            </span>
          </div>

          <div className="mt-1 text-twitter-dark break-words whitespace-pre-wrap">
            {parseContent(displayTweet.content)}
          </div>

          {displayTweet.quotedTweet && (
            <div className="mt-3 border border-twitter-extraLightGray rounded-xl p-3">
              <div className="flex items-center gap-1 text-sm">
                <span className="font-bold">{displayTweet.quotedTweet.author.displayName}</span>
                <span className="text-twitter-gray">@{displayTweet.quotedTweet.author.username}</span>
              </div>
              <div className="text-sm mt-1">{displayTweet.quotedTweet.content}</div>
            </div>
          )}

          {showActions && (
            <div className="flex items-center gap-8 mt-3 text-twitter-gray">
              <button className="flex items-center gap-2 hover:text-twitter-blue transition-colors group">
                <div className="p-2 rounded-full group-hover:bg-blue-50 transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                </div>
                <span className="text-sm">{formatNumber(displayTweet.replyCount)}</span>
              </button>

              <button
                onClick={handleRetweet}
                className={`flex items-center gap-2 transition-colors group ${
                  displayTweet.isRetweeted ? 'text-green-500' : 'hover:text-green-500'
                }`}
              >
                <div className="p-2 rounded-full group-hover:bg-green-50 transition-colors">
                  <svg className="w-5 h-5" fill={displayTweet.isRetweeted ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M23.77 15.67c-.292-.293-.767-.293-1.06 0l-2.22 2.22V7.65c0-2.068-1.683-3.75-3.75-3.75h-5.85c-.414 0-.75.336-.75.75s.336.75.75.75h5.85c1.24 0 2.25 1.01 2.25 2.25v10.24l-2.22-2.22c-.293-.293-.768-.293-1.06 0s-.294.768 0 1.06l3.5 3.5c.145.147.337.22.53.22s.383-.072.53-.22l3.5-3.5c.294-.292.294-.767 0-1.06z" />
                  </svg>
                </div>
                <span className="text-sm">{formatNumber(displayTweet.retweetCount)}</span>
              </button>

              <button
                onClick={handleLike}
                className={`flex items-center gap-2 transition-colors group ${
                  displayTweet.isLiked ? 'text-red-500' : 'hover:text-red-500'
                }`}
              >
                <div className="p-2 rounded-full group-hover:bg-red-50 transition-colors">
                  <svg
                    className="w-5 h-5"
                    fill={displayTweet.isLiked ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                    />
                  </svg>
                </div>
                <span className="text-sm">{formatNumber(displayTweet.likeCount)}</span>
              </button>

              <button className="flex items-center gap-2 hover:text-twitter-blue transition-colors group">
                <div className="p-2 rounded-full group-hover:bg-blue-50 transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                </div>
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
