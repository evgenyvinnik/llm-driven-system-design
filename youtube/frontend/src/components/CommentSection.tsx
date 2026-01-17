import { useState, useEffect } from 'react';
import { Comment } from '../types';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { timeAgo, getAvatarUrl } from '../utils/format';

interface CommentSectionProps {
  videoId: string;
  commentCount: number;
}

export default function CommentSection({ videoId, commentCount }: CommentSectionProps) {
  const { user } = useAuthStore();
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');

  useEffect(() => {
    fetchComments();
  }, [videoId]);

  const fetchComments = async () => {
    setIsLoading(true);
    try {
      const response = await api.get<{ comments: Comment[] }>(`/videos/${videoId}/comments`);
      setComments(response.comments);
    } catch (error) {
      console.error('Failed to fetch comments:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || !user) return;

    setIsSubmitting(true);
    try {
      const response = await api.post<Comment>(`/videos/${videoId}/comments`, {
        text: newComment.trim(),
      });
      setComments([response, ...comments]);
      setNewComment('');
    } catch (error) {
      console.error('Failed to submit comment:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitReply = async (parentId: string) => {
    if (!replyText.trim() || !user) return;

    setIsSubmitting(true);
    try {
      const response = await api.post<Comment>(`/videos/${videoId}/comments`, {
        text: replyText.trim(),
        parentId,
      });

      // Add reply to the comment
      setComments(comments.map(c => {
        if (c.id === parentId) {
          return { ...c, replyCount: (c.replyCount || 0) + 1 };
        }
        return c;
      }));

      setReplyingTo(null);
      setReplyText('');
    } catch (error) {
      console.error('Failed to submit reply:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLikeComment = async (commentId: string) => {
    if (!user) return;

    try {
      await api.post(`/videos/${videoId}/comments/${commentId}/like`);
      // Update local state optimistically
      setComments(comments.map(c => {
        if (c.id === commentId) {
          return { ...c, likeCount: c.likeCount + 1 };
        }
        return c;
      }));
    } catch (error) {
      console.error('Failed to like comment:', error);
    }
  };

  return (
    <div className="mt-6">
      <h3 className="text-lg font-medium mb-6">{commentCount} Comments</h3>

      {/* Add comment form */}
      {user ? (
        <form onSubmit={handleSubmitComment} className="flex gap-4 mb-8">
          <img
            src={getAvatarUrl(null, user.username)}
            alt={user.username}
            className="w-10 h-10 rounded-full flex-shrink-0"
          />
          <div className="flex-1">
            <input
              type="text"
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Add a comment..."
              className="w-full bg-transparent border-b border-gray-700 focus:border-white outline-none pb-2"
            />
            {newComment && (
              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setNewComment('')}
                  className="px-3 py-1.5 text-sm hover:bg-yt-dark-hover rounded-full"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="btn-primary text-sm py-1.5 disabled:opacity-50"
                >
                  Comment
                </button>
              </div>
            )}
          </div>
        </form>
      ) : (
        <p className="text-gray-400 mb-8">Sign in to comment</p>
      )}

      {/* Comments list */}
      {isLoading ? (
        <p className="text-gray-400">Loading comments...</p>
      ) : comments.length === 0 ? (
        <p className="text-gray-400">No comments yet</p>
      ) : (
        <div className="space-y-6">
          {comments.map((comment) => (
            <div key={comment.id} className="flex gap-4">
              <img
                src={getAvatarUrl(comment.user.avatarUrl, comment.user.username)}
                alt={comment.user.username}
                className="w-10 h-10 rounded-full flex-shrink-0"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-sm">@{comment.user.username}</span>
                  <span className="text-xs text-gray-400">{timeAgo(comment.createdAt)}</span>
                  {comment.isEdited && <span className="text-xs text-gray-400">(edited)</span>}
                </div>
                <p className="text-sm mb-2">{comment.text}</p>
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => handleLikeComment(comment.id)}
                    className="flex items-center gap-1 text-gray-400 hover:text-white"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/>
                    </svg>
                    <span className="text-xs">{comment.likeCount || ''}</span>
                  </button>
                  {user && (
                    <button
                      onClick={() => setReplyingTo(comment.id)}
                      className="text-xs text-gray-400 hover:text-white"
                    >
                      Reply
                    </button>
                  )}
                  {comment.replyCount && comment.replyCount > 0 && (
                    <span className="text-xs text-yt-blue cursor-pointer hover:underline">
                      {comment.replyCount} replies
                    </span>
                  )}
                </div>

                {/* Reply form */}
                {replyingTo === comment.id && (
                  <div className="flex gap-3 mt-3">
                    <img
                      src={getAvatarUrl(null, user!.username)}
                      alt={user!.username}
                      className="w-6 h-6 rounded-full flex-shrink-0"
                    />
                    <div className="flex-1">
                      <input
                        type="text"
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder="Add a reply..."
                        className="w-full bg-transparent border-b border-gray-700 focus:border-white outline-none pb-1 text-sm"
                        autoFocus
                      />
                      <div className="flex justify-end gap-2 mt-2">
                        <button
                          onClick={() => {
                            setReplyingTo(null);
                            setReplyText('');
                          }}
                          className="px-3 py-1 text-xs hover:bg-yt-dark-hover rounded-full"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleSubmitReply(comment.id)}
                          disabled={!replyText.trim() || isSubmitting}
                          className="btn-primary text-xs py-1 disabled:opacity-50"
                        >
                          Reply
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
