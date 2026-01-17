import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Post } from '../types';
import { Avatar } from './Avatar';
import { postsApi } from '../services/api';
import { formatTimeAgo, formatNumber } from '../utils/format';
import { useAuthStore } from '../stores/authStore';

interface PostCardProps {
  post: Post;
  onUpdate?: (post: Post) => void;
}

export function PostCard({ post, onUpdate }: PostCardProps) {
  const { isAuthenticated } = useAuthStore();
  const [currentMediaIndex, setCurrentMediaIndex] = useState(0);
  const [showLikeAnimation, setShowLikeAnimation] = useState(false);
  const [isLiked, setIsLiked] = useState(post.isLiked || false);
  const [isSaved, setIsSaved] = useState(post.isSaved || false);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [commentText, setCommentText] = useState('');

  const handleLike = async () => {
    if (!isAuthenticated) return;
    try {
      if (isLiked) {
        await postsApi.unlike(post.id);
        setIsLiked(false);
        setLikeCount((prev) => prev - 1);
      } else {
        await postsApi.like(post.id);
        setIsLiked(true);
        setLikeCount((prev) => prev + 1);
      }
      onUpdate?.({ ...post, isLiked: !isLiked, likeCount: isLiked ? likeCount - 1 : likeCount + 1 });
    } catch (error) {
      console.error('Like error:', error);
    }
  };

  const handleDoubleClick = async () => {
    if (!isAuthenticated || isLiked) return;
    setShowLikeAnimation(true);
    setTimeout(() => setShowLikeAnimation(false), 800);
    await handleLike();
  };

  const handleSave = async () => {
    if (!isAuthenticated) return;
    try {
      if (isSaved) {
        await postsApi.unsave(post.id);
        setIsSaved(false);
      } else {
        await postsApi.save(post.id);
        setIsSaved(true);
      }
    } catch (error) {
      console.error('Save error:', error);
    }
  };

  const currentMedia = post.media[currentMediaIndex];
  const filterClass = currentMedia?.filterApplied
    ? `filter-${currentMedia.filterApplied}`
    : '';

  return (
    <article className="bg-white border border-border-gray rounded-lg mb-4">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <Link
          to="/profile/$username"
          params={{ username: post.username }}
          className="flex items-center gap-3"
        >
          <Avatar src={post.profilePictureUrl} alt={post.username} size="sm" />
          <div>
            <p className="font-semibold text-sm">{post.username}</p>
            {post.location && (
              <p className="text-xs text-text-gray">{post.location}</p>
            )}
          </div>
        </Link>
        <button className="text-xl">...</button>
      </div>

      {/* Media */}
      <div
        className="relative aspect-square bg-black"
        onDoubleClick={handleDoubleClick}
      >
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

        {/* Like animation */}
        {showLikeAnimation && (
          <div className="absolute inset-0 flex items-center justify-center">
            <svg
              className="w-24 h-24 text-white like-animation"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
          </div>
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
            {/* Dots indicator */}
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

      {/* Actions */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-4">
            <button onClick={handleLike}>
              <svg
                className={`w-6 h-6 ${isLiked ? 'text-red-500 fill-current' : ''}`}
                fill={isLiked ? 'currentColor' : 'none'}
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
            <button onClick={() => setShowCommentInput(!showCommentInput)}>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
            </button>
            <button>
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                />
              </svg>
            </button>
          </div>
          <button onClick={handleSave}>
            <svg
              className={`w-6 h-6 ${isSaved ? 'fill-current' : ''}`}
              fill={isSaved ? 'currentColor' : 'none'}
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

        {/* Likes */}
        <p className="font-semibold text-sm mb-1">
          {formatNumber(likeCount)} {likeCount === 1 ? 'like' : 'likes'}
        </p>

        {/* Caption */}
        {post.caption && (
          <p className="text-sm mb-1">
            <Link
              to="/profile/$username"
              params={{ username: post.username }}
              className="font-semibold mr-1"
            >
              {post.username}
            </Link>
            {post.caption}
          </p>
        )}

        {/* Comments link */}
        {post.commentCount > 0 && (
          <Link
            to="/post/$postId"
            params={{ postId: post.id }}
            className="text-sm text-text-gray mb-1 block"
          >
            View all {post.commentCount} comments
          </Link>
        )}

        {/* Timestamp */}
        <p className="text-xs text-text-gray uppercase">
          {formatTimeAgo(post.createdAt)}
        </p>

        {/* Comment input */}
        {showCommentInput && (
          <div className="mt-3 flex items-center gap-2 border-t border-border-gray pt-3">
            <input
              type="text"
              placeholder="Add a comment..."
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              className="flex-1 text-sm outline-none"
            />
            <button
              disabled={!commentText.trim()}
              className="text-primary font-semibold text-sm disabled:opacity-50"
            >
              Post
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
