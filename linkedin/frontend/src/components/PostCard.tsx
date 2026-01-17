/**
 * Post card component for displaying feed posts.
 * Handles displaying post content, author info, and engagement features.
 * Supports liking, commenting, and viewing post details.
 *
 * @module components/PostCard
 */
import { useState } from 'react';
import { ThumbsUp, MessageCircle, Share2, Send } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { Post, PostComment } from '../types';
import { feedApi } from '../services/api';

/**
 * Props for the PostCard component.
 */
interface PostCardProps {
  post: Post;
  onLikeToggle?: (postId: number, liked: boolean) => void;
}

/**
 * Displays a single post in the feed with engagement features.
 * Includes author info, post content, like/comment counts, and action buttons.
 * Comments section expands on demand with lazy loading.
 *
 * @param post - The post data to display
 * @param onLikeToggle - Optional callback when like state changes
 */
export function PostCard({ post, onLikeToggle }: PostCardProps) {
  const [liked, setLiked] = useState(post.has_liked || false);
  const [likeCount, setLikeCount] = useState(post.like_count);
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState<PostComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loadingComments, setLoadingComments] = useState(false);

  const handleLike = async () => {
    try {
      if (liked) {
        await feedApi.unlikePost(post.id);
        setLikeCount((c) => c - 1);
      } else {
        await feedApi.likePost(post.id);
        setLikeCount((c) => c + 1);
      }
      setLiked(!liked);
      onLikeToggle?.(post.id, !liked);
    } catch (error) {
      console.error('Failed to toggle like:', error);
    }
  };

  const handleShowComments = async () => {
    if (!showComments && comments.length === 0) {
      setLoadingComments(true);
      try {
        const { comments: fetchedComments } = await feedApi.getComments(post.id);
        setComments(fetchedComments);
      } catch (error) {
        console.error('Failed to load comments:', error);
      }
      setLoadingComments(false);
    }
    setShowComments(!showComments);
  };

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    try {
      const { comment } = await feedApi.addComment(post.id, newComment);
      setComments([...comments, comment]);
      setNewComment('');
    } catch (error) {
      console.error('Failed to add comment:', error);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) return 'Just now';
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    return date.toLocaleDateString();
  };

  return (
    <div className="card">
      <div className="p-4">
        {/* Author */}
        <Link
          to="/profile/$userId"
          params={{ userId: String(post.user_id) }}
          className="flex items-start gap-3"
        >
          <div className="w-12 h-12 rounded-full bg-gray-300 flex items-center justify-center font-bold text-lg">
            {post.author?.first_name?.[0]}
          </div>
          <div className="flex-1">
            <div className="font-semibold hover:text-linkedin-blue hover:underline">
              {post.author?.first_name} {post.author?.last_name}
            </div>
            <div className="text-sm text-gray-600">{post.author?.headline}</div>
            <div className="text-xs text-gray-500">{formatDate(post.created_at)}</div>
          </div>
        </Link>

        {/* Content */}
        <div className="mt-3 whitespace-pre-wrap">{post.content}</div>

        {post.image_url && (
          <img
            src={post.image_url}
            alt=""
            className="mt-3 w-full rounded-lg"
          />
        )}

        {/* Engagement stats */}
        {(likeCount > 0 || post.comment_count > 0) && (
          <div className="flex items-center justify-between mt-3 pt-2 text-sm text-gray-600">
            {likeCount > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-4 h-4 bg-linkedin-blue rounded-full flex items-center justify-center">
                  <ThumbsUp className="w-2.5 h-2.5 text-white" />
                </span>
                {likeCount}
              </span>
            )}
            {post.comment_count > 0 && (
              <button onClick={handleShowComments} className="hover:underline hover:text-linkedin-blue">
                {post.comment_count} comments
              </button>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="border-t border-gray-200 px-4 py-1 flex items-center justify-around">
        <button
          onClick={handleLike}
          className={`flex items-center gap-2 py-3 px-4 rounded hover:bg-gray-100 ${
            liked ? 'text-linkedin-blue' : 'text-gray-600'
          }`}
        >
          <ThumbsUp className="w-5 h-5" fill={liked ? 'currentColor' : 'none'} />
          <span className="font-semibold text-sm">Like</span>
        </button>
        <button
          onClick={handleShowComments}
          className="flex items-center gap-2 py-3 px-4 rounded hover:bg-gray-100 text-gray-600"
        >
          <MessageCircle className="w-5 h-5" />
          <span className="font-semibold text-sm">Comment</span>
        </button>
        <button className="flex items-center gap-2 py-3 px-4 rounded hover:bg-gray-100 text-gray-600">
          <Share2 className="w-5 h-5" />
          <span className="font-semibold text-sm">Share</span>
        </button>
        <button className="flex items-center gap-2 py-3 px-4 rounded hover:bg-gray-100 text-gray-600">
          <Send className="w-5 h-5" />
          <span className="font-semibold text-sm">Send</span>
        </button>
      </div>

      {/* Comments */}
      {showComments && (
        <div className="border-t border-gray-200 p-4">
          {/* Add comment */}
          <form onSubmit={handleAddComment} className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-gray-300 flex-shrink-0" />
            <div className="flex-1 flex gap-2">
              <input
                type="text"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add a comment..."
                className="flex-1 border border-gray-300 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-linkedin-blue"
              />
              <button
                type="submit"
                disabled={!newComment.trim()}
                className="text-linkedin-blue font-semibold text-sm disabled:opacity-50"
              >
                Post
              </button>
            </div>
          </form>

          {/* Comments list */}
          {loadingComments ? (
            <div className="text-center text-gray-500">Loading comments...</div>
          ) : (
            <div className="space-y-3">
              {comments.map((comment) => (
                <div key={comment.id} className="flex items-start gap-3">
                  <Link to="/profile/$userId" params={{ userId: String(comment.user_id) }}>
                    <div className="w-8 h-8 rounded-full bg-gray-300 flex items-center justify-center text-xs font-bold">
                      {comment.author?.first_name?.[0]}
                    </div>
                  </Link>
                  <div className="flex-1 bg-gray-100 rounded-lg p-3">
                    <Link
                      to="/profile/$userId"
                      params={{ userId: String(comment.user_id) }}
                      className="font-semibold text-sm hover:text-linkedin-blue hover:underline"
                    >
                      {comment.author?.first_name} {comment.author?.last_name}
                    </Link>
                    <div className="text-xs text-gray-500">{comment.author?.headline}</div>
                    <div className="mt-1 text-sm">{comment.content}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
