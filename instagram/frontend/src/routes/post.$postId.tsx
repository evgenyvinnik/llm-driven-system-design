import { useState, useEffect } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { postsApi, commentsApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import type { Post, Comment } from '../types';
import { Avatar } from '../components/Avatar';
import { formatTimeAgo, formatNumber } from '../utils/format';
import { useOptimisticToggle } from '../hooks/useOptimisticToggle';

export const Route = createFileRoute('/post/$postId')({
  component: PostPage,
});

function PostPage() {
  const { postId } = Route.useParams();
  const { user, isAuthenticated } = useAuthStore();
  const [post, setPost] = useState<Post | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentMediaIndex, setCurrentMediaIndex] = useState(0);
  const [commentText, setCommentText] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);

  useEffect(() => {
    loadPost();
    loadComments();
  }, [postId]);

  const loadPost = async () => {
    try {
      setLoading(true);
      const response = await postsApi.get(postId);
      setPost(response.post);
    } catch (error) {
      console.error('Error loading post:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadComments = async () => {
    try {
      const response = await commentsApi.getComments(postId);
      setComments(response.comments);
    } catch (error) {
      console.error('Error loading comments:', error);
    }
  };

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim() || !isAuthenticated) return;

    setSubmittingComment(true);
    try {
      const response = await commentsApi.addComment(postId, commentText.trim());
      setComments((prev) => [response.comment, ...prev]);
      setCommentText('');
    } catch (error) {
      console.error('Error adding comment:', error);
    } finally {
      setSubmittingComment(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      await commentsApi.deleteComment(commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (error) {
      console.error('Error deleting comment:', error);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-primary" />
      </div>
    );
  }

  if (!post) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold mb-2">Post not found</h2>
        <p className="text-text-secondary">This post may have been deleted.</p>
      </div>
    );
  }

  const currentMedia = post.media[currentMediaIndex];
  const filterClass = currentMedia?.filterApplied ? `filter-${currentMedia.filterApplied}` : '';

  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-white border border-border-gray rounded-lg overflow-hidden flex flex-col md:flex-row">
        {/* Media section */}
        <div className="relative aspect-square md:w-1/2 bg-black flex-shrink-0">
          {currentMedia?.mediaType === 'image' ? (
            <img
              src={currentMedia.mediaUrl}
              alt=""
              className={`w-full h-full object-contain ${filterClass}`}
            />
          ) : (
            <video
              src={currentMedia?.mediaUrl}
              className={`w-full h-full object-contain ${filterClass}`}
              controls
            />
          )}

          {/* Carousel navigation */}
          {post.media.length > 1 && (
            <>
              {currentMediaIndex > 0 && (
                <button
                  className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/80 rounded-full p-1"
                  onClick={() => setCurrentMediaIndex((prev) => prev - 1)}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              )}
              {currentMediaIndex < post.media.length - 1 && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/80 rounded-full p-1"
                  onClick={() => setCurrentMediaIndex((prev) => prev + 1)}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              )}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1">
                {post.media.map((_, idx) => (
                  <div
                    key={idx}
                    className={`w-1.5 h-1.5 rounded-full ${
                      idx === currentMediaIndex ? 'bg-primary' : 'bg-white/50'
                    }`}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Details section */}
        <div className="md:w-1/2 flex flex-col">
          {/* Header */}
          <div className="flex items-center gap-3 p-4 border-b border-border-gray">
            <Link to="/profile/$username" params={{ username: post.username }}>
              <Avatar src={post.profilePictureUrl} alt={post.username} size="sm" />
            </Link>
            <Link
              to="/profile/$username"
              params={{ username: post.username }}
              className="font-semibold text-sm hover:underline"
            >
              {post.username}
            </Link>
          </div>

          {/* Comments */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 max-h-80 md:max-h-none">
            {/* Caption as first comment */}
            {post.caption && (
              <div className="flex gap-3">
                <Link to="/profile/$username" params={{ username: post.username }}>
                  <Avatar src={post.profilePictureUrl} alt={post.username} size="sm" />
                </Link>
                <div>
                  <p className="text-sm">
                    <Link
                      to="/profile/$username"
                      params={{ username: post.username }}
                      className="font-semibold mr-1"
                    >
                      {post.username}
                    </Link>
                    {post.caption}
                  </p>
                  <p className="text-xs text-text-secondary mt-1">{formatTimeAgo(post.createdAt)}</p>
                </div>
              </div>
            )}

            {/* Comments list */}
            {comments.map((comment) => (
              <div key={comment.id} className="flex gap-3 group">
                <Link to="/profile/$username" params={{ username: comment.username }}>
                  <Avatar src={comment.profilePictureUrl} alt={comment.username} size="sm" />
                </Link>
                <div className="flex-1">
                  <p className="text-sm">
                    <Link
                      to="/profile/$username"
                      params={{ username: comment.username }}
                      className="font-semibold mr-1"
                    >
                      {comment.username}
                    </Link>
                    {comment.content}
                  </p>
                  <div className="flex items-center gap-3 text-xs text-text-secondary mt-1">
                    <span>{formatTimeAgo(comment.createdAt)}</span>
                    {comment.likeCount > 0 && (
                      <span>{formatNumber(comment.likeCount)} likes</span>
                    )}
                    {(comment.userId === user?.id || post.userId === user?.id) && (
                      <button
                        onClick={() => handleDeleteComment(comment.id)}
                        className="opacity-0 group-hover:opacity-100 text-like-red transition-opacity"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Actions */}
          <PostDetailActions key={post.id} post={post} />

          {/* Comment input */}
          {isAuthenticated && (
            <form onSubmit={handleSubmitComment} className="flex items-center gap-2 p-4 border-t border-border-gray">
              <input
                type="text"
                placeholder="Add a comment..."
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                className="flex-1 text-sm outline-none"
              />
              <button
                type="submit"
                disabled={!commentText.trim() || submittingComment}
                className="text-primary hover:text-primary-hover font-semibold text-sm disabled:opacity-50 transition-colors"
              >
                Post
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

/** Like/save bar for the detail page; optimistic with rollback (see useOptimisticToggle). */
function PostDetailActions({ post }: { post: Post }) {
  const { isAuthenticated } = useAuthStore();
  const like = useOptimisticToggle({
    initialActive: post.isLiked || false,
    initialCount: post.likeCount,
    activate: () => postsApi.like(post.id),
    deactivate: () => postsApi.unlike(post.id),
  });
  const save = useOptimisticToggle({
    initialActive: post.isSaved || false,
    activate: () => postsApi.save(post.id),
    deactivate: () => postsApi.unsave(post.id),
  });

  return (
    <div className="p-4 border-t border-border-gray">
      {post.status === 'processing' && (
        <p className="text-xs text-text-secondary mb-2" role="status">
          Your photos are still processing. They will appear here in a few seconds.
        </p>
      )}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => isAuthenticated && void like.toggle()}
            aria-label={like.active ? 'Unlike' : 'Like'}
            aria-pressed={like.active}
          >
            <svg
              className={`w-6 h-6 ${like.active ? 'text-like-red fill-current' : ''}`}
              fill={like.active ? 'currentColor' : 'none'}
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              />
            </svg>
          </button>
        </div>
        <button
          type="button"
          onClick={() => isAuthenticated && void save.toggle()}
          aria-label={save.active ? 'Remove from saved' : 'Save'}
          aria-pressed={save.active}
        >
          <svg
            className={`w-6 h-6 ${save.active ? 'fill-current' : ''}`}
            fill={save.active ? 'currentColor' : 'none'}
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
            />
          </svg>
        </button>
      </div>

      <p className="font-semibold text-sm mb-1">
        {formatNumber(like.count)} {like.count === 1 ? 'like' : 'likes'}
      </p>
      <p className="text-xs text-text-secondary uppercase">{formatTimeAgo(post.createdAt)}</p>
      <p role="status" aria-live="polite" className="text-xs text-like-red mt-1">
        {like.error || save.error}
      </p>
    </div>
  );
}
