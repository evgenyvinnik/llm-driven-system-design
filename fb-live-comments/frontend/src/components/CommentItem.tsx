import { Comment } from '../types';

interface CommentItemProps {
  comment: Comment;
}

export function CommentItem({ comment }: CommentItemProps) {
  const { user } = comment;

  return (
    <div
      className={`flex gap-2 p-2 rounded-lg animate-slide-in ${
        comment.is_highlighted
          ? 'bg-yellow-500/20 border border-yellow-500/40'
          : comment.is_pinned
          ? 'bg-blue-500/20 border border-blue-500/40'
          : 'bg-white/5'
      }`}
    >
      {/* Avatar */}
      <div className="flex-shrink-0">
        {user.avatar_url ? (
          <img
            src={user.avatar_url}
            alt={user.display_name}
            className="w-8 h-8 rounded-full"
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white text-sm font-bold">
            {user.display_name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="font-semibold text-sm text-white truncate">
            {user.display_name}
          </span>
          {user.is_verified && (
            <span className="text-blue-400 text-xs" title="Verified">
              &#10003;
            </span>
          )}
          {comment.is_pinned && (
            <span className="text-blue-400 text-xs ml-1" title="Pinned">
              &#128204;
            </span>
          )}
        </div>
        <p className="text-gray-200 text-sm break-words">{comment.content}</p>
      </div>
    </div>
  );
}
