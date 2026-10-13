import type { Comment } from '../types';

interface CommentItemProps {
  comment: Comment;
  canDelete: boolean;
  onDelete: () => void;
  /** Jumps the player to the comment's anchor. */
  onSeek?: (seconds: number) => void;
}

/** Renders a single comment with author info, optional timestamp anchor, and delete action. */
export function CommentItem({ comment, canDelete, onDelete, onSeek }: CommentItemProps) {
  const displayName = comment.author.displayName || comment.author.username;

  return (
    <div className="group bg-gray-50 rounded-lg p-3">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-loom-primary/20 flex items-center justify-center text-xs font-medium text-loom-primary">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <span className="text-xs font-medium text-loom-text">{displayName}</span>
          {comment.timestampSeconds !== null &&
            (onSeek ? (
              <button
                type="button"
                className="timestamp-badge"
                onClick={() => onSeek(comment.timestampSeconds!)}
                aria-label={`Jump to ${formatTime(comment.timestampSeconds)}`}
              >
                {formatTime(comment.timestampSeconds)}
              </button>
            ) : (
              <span className="timestamp-badge">{formatTime(comment.timestampSeconds)}</span>
            ))}
        </div>
        {canDelete && (
          <button
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-100 text-xs text-loom-secondary hover:text-loom-danger transition-all"
          >
            Delete
          </button>
        )}
      </div>
      <p className="text-sm text-loom-text mt-1.5 ml-8">{comment.content}</p>
      <div className="text-xs text-loom-secondary mt-1 ml-8">
        {timeAgo(comment.createdAt)}
      </div>
    </div>
  );
}

function formatTime(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.floor(totalSeconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
