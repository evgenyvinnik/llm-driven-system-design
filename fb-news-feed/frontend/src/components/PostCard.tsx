/**
 * @fileoverview PostCard component for displaying individual posts in the feed.
 * Includes author info, content, engagement stats, and interactive actions.
 * Supports likes, comments, and sharing with expandable comment section.
 */

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Post } from '@/types';
import { Avatar } from './Avatar';
import { Button } from './Button';
import { formatRelativeTime, formatNumber, cn } from '@/utils';
import { useFeedStore } from '@/stores/feedStore';
import { useAuthStore } from '@/stores/authStore';
import { postsApi } from '@/services/api';

/**
 * Props for the PostCard component.
 */
interface PostCardProps {
  /** Post data to display */
  post: Post;
  /** Optional callback when post is deleted */
  onDelete?: () => void;
}

/**
 * Renders a single post with full interactivity.
 * Displays author, content, image (if any), engagement stats, and action buttons.
 * Manages local state for comments section expansion and comment submission.
 *
 * @param props - PostCard props including post data and delete callback
 * @returns JSX element rendering the post card
 */
export function PostCard({ post, onDelete }: PostCardProps) {
  const [showComments, setShowComments] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [comments, setComments] = useState<Array<{
    id: string;
    content: string;
    created_at: string;
    author: { id: string; username: string; display_name: string; avatar_url: string | null };
  }>>([]);
  const [loadingComments, setLoadingComments] = useState(false);

  const { likePost, unlikePost } = useFeedStore();
  const { user, isAuthenticated } = useAuthStore();

  const handleLike = async () => {
    if (!isAuthenticated) return;
    if (post.is_liked) {
      await unlikePost(post.id);
    } else {
      await likePost(post.id);
    }
  };

  const handleToggleComments = async () => {
    if (!showComments && comments.length === 0) {
      setLoadingComments(true);
      try {
        const response = await postsApi.getComments(post.id);
        setComments(response.comments);
      } catch (error) {
        console.error('Failed to load comments:', error);
      } finally {
        setLoadingComments(false);
      }
    }
    setShowComments(!showComments);
  };

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim() || !isAuthenticated) return;

    setIsSubmitting(true);
    try {
      const newComment = await postsApi.addComment(post.id, commentText.trim());
      setComments((prev) => [...prev, newComment]);
      setCommentText('');
    } catch (error) {
      console.error('Failed to add comment:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isOwner = user?.id === post.author.id;

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Header */}
      <div className="p-4 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link to="/profile/$username" params={{ username: post.author.username }}>
            <Avatar
              src={post.author.avatar_url}
              name={post.author.display_name}
              size="md"
            />
          </Link>
          <div>
            <Link
              to="/profile/$username"
              params={{ username: post.author.username }}
              className="font-semibold text-facebook-text hover:underline"
            >
              {post.author.display_name}
            </Link>
            {post.author.is_celebrity && (
              <span className="ml-1 text-facebook-blue">
                <svg className="w-4 h-4 inline" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
              </span>
            )}
            <div className="flex items-center gap-1 text-sm text-facebook-darkGray">
              <span>{formatRelativeTime(post.created_at)}</span>
              <span>·</span>
              <span>{post.privacy === 'public' ? '🌐' : '👥'}</span>
            </div>
          </div>
        </div>
        {isOwner && (
          <button
            onClick={onDelete}
            className="text-facebook-darkGray hover:bg-gray-100 p-2 rounded-full"
            title="Delete post"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Content */}
      <div className="px-4 pb-3">
        {post.content && (
          <p className="text-facebook-text whitespace-pre-wrap">{post.content}</p>
        )}
      </div>

      {/* Image */}
      {post.image_url && (
        <div className="w-full">
          <img
            src={post.image_url}
            alt="Post image"
            className="w-full object-cover max-h-96"
          />
        </div>
      )}

      {/* Stats */}
      {(post.like_count > 0 || post.comment_count > 0) && (
        <div className="px-4 py-2 flex items-center justify-between text-facebook-darkGray text-sm border-b border-gray-200">
          <div className="flex items-center gap-1">
            {post.like_count > 0 && (
              <>
                <span className="bg-facebook-blue text-white rounded-full p-1">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" />
                  </svg>
                </span>
                <span>{formatNumber(post.like_count)}</span>
              </>
            )}
          </div>
          <div>
            {post.comment_count > 0 && (
              <button
                onClick={handleToggleComments}
                className="hover:underline"
              >
                {formatNumber(post.comment_count)} comments
              </button>
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="px-4 py-1 flex items-center border-b border-gray-200">
        <button
          onClick={handleLike}
          disabled={!isAuthenticated}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 py-2 rounded-md transition-colors',
            post.is_liked
              ? 'text-facebook-blue'
              : 'text-facebook-darkGray hover:bg-gray-100'
          )}
        >
          <svg
            className="w-5 h-5"
            fill={post.is_liked ? 'currentColor' : 'none'}
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"
            />
          </svg>
          <span className="font-medium">Like</span>
        </button>
        <button
          onClick={handleToggleComments}
          className="flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-facebook-darkGray hover:bg-gray-100 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <span className="font-medium">Comment</span>
        </button>
        <button className="flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-facebook-darkGray hover:bg-gray-100 transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
            />
          </svg>
          <span className="font-medium">Share</span>
        </button>
      </div>

      {/* Comments Section */}
      {showComments && (
        <div className="p-4">
          {loadingComments ? (
            <div className="flex justify-center py-4">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-facebook-blue" />
            </div>
          ) : (
            <>
              {/* Comments List */}
              <div className="space-y-3 mb-4">
                {comments.map((comment) => (
                  <div key={comment.id} className="flex gap-2">
                    <Link to="/profile/$username" params={{ username: comment.author.username }}>
                      <Avatar
                        src={comment.author.avatar_url}
                        name={comment.author.display_name}
                        size="sm"
                      />
                    </Link>
                    <div className="flex-1">
                      <div className="bg-gray-100 rounded-2xl px-3 py-2">
                        <Link
                          to="/profile/$username"
                          params={{ username: comment.author.username }}
                          className="font-semibold text-sm text-facebook-text hover:underline"
                        >
                          {comment.author.display_name}
                        </Link>
                        <p className="text-sm text-facebook-text">{comment.content}</p>
                      </div>
                      <div className="flex items-center gap-3 mt-1 ml-3 text-xs text-facebook-darkGray">
                        <button className="font-semibold hover:underline">Like</button>
                        <button className="font-semibold hover:underline">Reply</button>
                        <span>{formatRelativeTime(comment.created_at)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Comment Input */}
              {isAuthenticated && (
                <form onSubmit={handleSubmitComment} className="flex gap-2">
                  <Avatar src={user?.avatar_url} name={user?.display_name || 'User'} size="sm" />
                  <div className="flex-1 flex items-center bg-gray-100 rounded-full px-4">
                    <input
                      type="text"
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder="Write a comment..."
                      className="flex-1 bg-transparent py-2 text-sm focus:outline-none"
                    />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      disabled={!commentText.trim() || isSubmitting}
                      className="p-1"
                    >
                      <svg className="w-5 h-5 text-facebook-blue" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                      </svg>
                    </Button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
