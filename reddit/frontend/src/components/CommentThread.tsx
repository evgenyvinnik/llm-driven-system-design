import { useState } from 'react';
import type { Comment } from '../types';
import { VoteButtons } from './VoteButtons';
import { formatTimeAgo } from '../utils/format';
import api from '../services/api';
import { useAuthStore } from '../stores/authStore';

interface CommentThreadProps {
  comment: Comment;
  postId: number;
  onReplyAdded: (reply: Comment) => void;
}

export function CommentThread({ comment, postId, onReplyAdded }: CommentThreadProps) {
  const [isReplying, setIsReplying] = useState(false);
  const [replyContent, setReplyContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const user = useAuthStore((state) => state.user);

  const handleSubmitReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyContent.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const newReply = await api.createComment(postId, replyContent.trim(), comment.id);
      onReplyAdded(newReply);
      setReplyContent('');
      setIsReplying(false);
    } catch (error) {
      console.error('Failed to submit reply:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isCollapsed) {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-gray-500">
        <button
          onClick={() => setIsCollapsed(false)}
          className="text-gray-400 hover:text-gray-600"
        >
          [+]
        </button>
        <span className="text-reddit-blue font-medium">u/{comment.author_username}</span>
        <span>{comment.score} points</span>
        <span>{formatTimeAgo(comment.created_at)}</span>
      </div>
    );
  }

  return (
    <div className="flex" style={{ marginLeft: comment.depth > 0 ? '16px' : 0 }}>
      <div className="flex flex-col items-center mr-2">
        <button
          onClick={() => setIsCollapsed(true)}
          className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-600 text-xs"
        >
          [-]
        </button>
        <div
          className="w-px flex-1 bg-gray-200 hover:bg-reddit-blue cursor-pointer"
          onClick={() => setIsCollapsed(true)}
        />
      </div>

      <div className="flex-1 pb-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-reddit-blue font-medium">u/{comment.author_username}</span>
          <span className="text-gray-500">{comment.score} points</span>
          <span className="text-gray-500">{formatTimeAgo(comment.created_at)}</span>
        </div>

        <div className="text-sm text-gray-800 my-1 whitespace-pre-wrap">{comment.content}</div>

        <div className="flex items-center gap-2 text-xs text-gray-500">
          <VoteButtons
            type="comment"
            id={comment.id}
            score={comment.score}
            userVote={comment.userVote}
            vertical={false}
          />
          {user && (
            <button
              onClick={() => setIsReplying(!isReplying)}
              className="hover:bg-gray-100 px-2 py-1 rounded"
            >
              Reply
            </button>
          )}
        </div>

        {isReplying && (
          <form onSubmit={handleSubmitReply} className="mt-2">
            <textarea
              value={replyContent}
              onChange={(e) => setReplyContent(e.target.value)}
              placeholder="What are your thoughts?"
              className="w-full p-2 border border-gray-300 rounded text-sm resize-none focus:outline-none focus:border-reddit-blue"
              rows={3}
            />
            <div className="flex gap-2 mt-1">
              <button
                type="submit"
                disabled={isSubmitting || !replyContent.trim()}
                className="px-3 py-1 bg-reddit-blue text-white text-sm rounded disabled:opacity-50"
              >
                {isSubmitting ? 'Replying...' : 'Reply'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsReplying(false);
                  setReplyContent('');
                }}
                className="px-3 py-1 text-gray-600 text-sm hover:bg-gray-100 rounded"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {comment.replies.length > 0 && (
          <div className="mt-2">
            {comment.replies.map((reply) => (
              <CommentThread
                key={reply.id}
                comment={reply}
                postId={postId}
                onReplyAdded={onReplyAdded}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
