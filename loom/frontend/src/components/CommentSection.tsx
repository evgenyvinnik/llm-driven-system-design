import { useEffect, useState } from 'react';
import type { Comment } from '../types';
import { commentsApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { CommentItem } from './CommentItem';

interface CommentSectionProps {
  videoId: string;
  playerTime: number;
  /** Clicking a timestamp badge seeks the player there. */
  onSeek?: (seconds: number) => void;
}

/** Displays video comments with time-anchored input, threading, and real-time player sync. */
export function CommentSection({ videoId, playerTime, onSeek }: CommentSectionProps) {
  const user = useAuthStore((s) => s.user);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [anchorToTime, setAnchorToTime] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const loadComments = async () => {
    setLoading(true);
    try {
      const { comments: list } = await commentsApi.list(videoId);
      setComments(list);
    } catch {
      // ignore
    }
    setLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || !user) return;
    setSubmitting(true);
    try {
      const timestampSeconds = anchorToTime ? Math.floor(playerTime) : null;
      const { comment } = await commentsApi.create(videoId, content.trim(), timestampSeconds);
      setComments((prev) => [...prev, comment]);
      setContent('');
      setAnchorToTime(false);
    } catch {
      // ignore
    }
    setSubmitting(false);
  };

  const handleDelete = async (commentId: string) => {
    try {
      await commentsApi.delete(videoId, commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch {
      // ignore
    }
  };

  // Separate top-level and replies
  const topLevel = comments.filter((c) => !c.parentId);
  const replies = comments.filter((c) => c.parentId);

  if (loading) {
    return <div className="text-sm text-loom-secondary py-4">Loading comments...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Comment list */}
      <div className="space-y-3 max-h-96 overflow-y-auto">
        {topLevel.length === 0 ? (
          <p className="text-sm text-loom-secondary py-4 text-center">No comments yet</p>
        ) : (
          topLevel.map((comment) => (
            <div key={comment.id}>
              <CommentItem
                comment={comment}
                canDelete={user?.id === comment.userId}
                onDelete={() => handleDelete(comment.id)}
                onSeek={onSeek}
              />
              {replies
                .filter((r) => r.parentId === comment.id)
                .map((reply) => (
                  <div key={reply.id} className="ml-6 mt-2">
                    <CommentItem
                      comment={reply}
                      canDelete={user?.id === reply.userId}
                      onDelete={() => handleDelete(reply.id)}
                      onSeek={onSeek}
                    />
                  </div>
                ))}
            </div>
          ))
        )}
      </div>

      {/* Comment input */}
      {user && (
        <form onSubmit={handleSubmit} className="space-y-2">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full px-3 py-2 border border-loom-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-loom-primary resize-none"
            rows={2}
            placeholder="Add a comment..."
          />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-loom-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={anchorToTime}
                onChange={(e) => setAnchorToTime(e.target.checked)}
                className="rounded border-loom-border text-loom-primary focus:ring-loom-primary"
              />
              Anchor at {formatTime(Math.floor(playerTime))}
            </label>
            <button
              type="submit"
              disabled={!content.trim() || submitting}
              className="px-4 py-1.5 bg-loom-primary text-white rounded-lg text-sm hover:bg-loom-hover disabled:opacity-50"
            >
              {submitting ? 'Posting...' : 'Post'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function formatTime(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
