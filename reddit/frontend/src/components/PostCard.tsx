import { Link } from '@tanstack/react-router';
import type { Post } from '../types';
import { VoteButtons } from './VoteButtons';
import { formatTimeAgo } from '../utils/format';

interface PostCardProps {
  post: Post;
}

export function PostCard({ post }: PostCardProps) {
  return (
    <div className="flex bg-white rounded border border-gray-200 hover:border-gray-400 transition-colors">
      <div className="w-10 bg-gray-50 rounded-l flex flex-col items-center py-2">
        <VoteButtons
          type="post"
          id={post.id}
          score={post.score}
          userVote={post.userVote}
        />
      </div>

      <div className="flex-1 p-2">
        <div className="text-xs text-gray-500 mb-1">
          <Link
            to="/r/$subreddit"
            params={{ subreddit: post.subreddit_name }}
            className="font-bold text-gray-900 hover:underline"
          >
            r/{post.subreddit_name}
          </Link>
          {' '}
          <span>Posted by u/{post.author_username}</span>
          {' '}
          <span>{formatTimeAgo(post.created_at)}</span>
        </div>

        <Link
          to="/r/$subreddit/comments/$postId"
          params={{ subreddit: post.subreddit_name, postId: post.id.toString() }}
          className="block"
        >
          <h2 className="text-lg font-medium text-gray-900 hover:text-reddit-blue mb-1">
            {post.title}
          </h2>
        </Link>

        {post.url && (
          <a
            href={post.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-reddit-blue hover:underline"
          >
            {new URL(post.url).hostname}
          </a>
        )}

        {post.content && !post.url && (
          <p className="text-sm text-gray-700 line-clamp-3 mt-1">{post.content}</p>
        )}

        <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
          <Link
            to="/r/$subreddit/comments/$postId"
            params={{ subreddit: post.subreddit_name, postId: post.id.toString() }}
            className="flex items-center gap-1 hover:bg-gray-100 p-1 rounded"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            <span>{post.comment_count} comments</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
