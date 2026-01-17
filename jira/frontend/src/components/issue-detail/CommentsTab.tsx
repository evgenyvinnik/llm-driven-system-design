import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import type { Comment, User } from '../../types';
import { Avatar, Textarea, Button } from '../ui';

/**
 * Props for the CommentsTab component.
 */
interface CommentsTabProps {
  /** List of comments to display */
  comments: Comment[];
  /** The current user for the avatar */
  currentUser?: User;
  /** Callback when a comment is submitted */
  onAddComment: (body: string) => void;
}

/**
 * Comments tab content component.
 *
 * Displays a comment form and list of existing comments.
 * Manages its own local state for the new comment input.
 *
 * @param props - The component props
 * @returns The rendered comments tab
 */
export function CommentsTab({ comments, currentUser, onAddComment }: CommentsTabProps) {
  const [newComment, setNewComment] = useState('');

  /**
   * Handles the submission of a new comment.
   * Clears the input after successful submission.
   */
  const handleSubmit = () => {
    if (!newComment.trim()) return;
    onAddComment(newComment);
    setNewComment('');
  };

  return (
    <div className="space-y-4">
      {/* Add comment form */}
      <div className="flex gap-3">
        <Avatar user={currentUser} />
        <div className="flex-1">
          <Textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Add a comment..."
            rows={3}
          />
          <div className="mt-2">
            <Button size="sm" onClick={handleSubmit} disabled={!newComment.trim()}>
              Add Comment
            </Button>
          </div>
        </div>
      </div>

      {/* Comments list */}
      {comments.map((comment) => (
        <CommentItem key={comment.id} comment={comment} />
      ))}
    </div>
  );
}

/**
 * Individual comment display component.
 *
 * Displays a single comment with author avatar, name, timestamp, and body.
 *
 * @param props - The component props
 * @returns The rendered comment item
 */
function CommentItem({ comment }: { comment: Comment }) {
  return (
    <div className="flex gap-3">
      <Avatar user={comment.author} />
      <div className="flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-gray-900">{comment.author.name}</span>
          <span className="text-sm text-gray-500">
            {formatDistanceToNow(new Date(comment.created_at), { addSuffix: true })}
          </span>
        </div>
        <p className="text-gray-700 mt-1">{comment.body}</p>
      </div>
    </div>
  );
}
