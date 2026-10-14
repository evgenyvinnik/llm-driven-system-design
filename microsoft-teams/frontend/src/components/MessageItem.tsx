import { useState } from 'react';
import type { Message } from '../types';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { ReactionPicker } from './ReactionPicker';

interface MessageItemProps {
  message: Message;
}

/** Renders a chat message with author, reactions, thread reply count, send state, and actions. */
export function MessageItem({ message }: MessageItemProps) {
  const { openThread, toggleReaction, retryMessage } = useChatStore();
  const username = useAuthStore((s) => s.user?.username);
  const [showReactionPicker, setShowReactionPicker] = useState(false);

  const deleted = !!message.deleted_at;
  const interactive = !message.status && !deleted;
  const time = new Date(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const handleReaction = (emoji: string) => {
    void toggleReaction(message.id, emoji);
    setShowReactionPicker(false);
  };

  return (
    <div
      className={`flex gap-3 px-2 py-1.5 hover:bg-teams-surface rounded-md group relative ${
        message.status === 'pending' ? 'opacity-60' : ''
      }`}
      onMouseLeave={() => setShowReactionPicker(false)}
    >
      {/* Avatar */}
      <div className="w-8 h-8 rounded-full bg-teams-primary text-white flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">
        {(message.display_name || message.username).charAt(0).toUpperCase()}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm text-teams-text">
            {message.display_name || message.username}
          </span>
          <span className="text-xs text-teams-secondary">{time}</span>
          {message.is_edited && !deleted && (
            <span className="text-xs text-teams-secondary italic">(edited)</span>
          )}
          {message.status === 'pending' && (
            <span className="text-xs text-teams-secondary">Sending…</span>
          )}
        </div>

        {deleted ? (
          <p className="text-sm text-teams-secondary italic">This message was deleted.</p>
        ) : (
          <p className="text-sm text-teams-text whitespace-pre-wrap break-words">{message.content}</p>
        )}

        {message.status === 'failed' && (
          <p className="text-xs text-teams-danger mt-0.5">
            Not sent.{' '}
            <button
              onClick={() => message.client_message_id && void retryMessage(message.client_message_id)}
              className="underline font-medium"
            >
              Retry
            </button>
          </p>
        )}

        {/* Reactions: click toggles your own */}
        {message.reactions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {message.reactions.map((reaction) => {
              const mine = !!username && reaction.users.includes(username);
              return (
                <button
                  key={reaction.emoji}
                  onClick={() => interactive && handleReaction(reaction.emoji)}
                  aria-pressed={mine}
                  aria-label={`${reaction.emoji} ${reaction.count}, ${mine ? 'remove your reaction' : 'react'}`}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-full bg-teams-chat text-xs hover:bg-teams-border transition-colors ${
                    mine ? 'ring-1 ring-teams-primary' : ''
                  }`}
                  title={reaction.users.join(', ')}
                >
                  <span>{reaction.emoji}</span>
                  <span className="text-teams-secondary">{reaction.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Thread indicator */}
        {(message.reply_count || 0) > 0 && (
          <button
            data-testid="thread-open"
            onClick={() => openThread(message.id)}
            className="flex items-center gap-1 mt-1 text-xs text-teams-primary hover:underline"
          >
            <span>{message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'}</span>
          </button>
        )}
      </div>

      {/* Actions: visible on hover and on keyboard focus */}
      {interactive && (
        <div className="absolute top-0 right-2 flex items-center gap-0.5 bg-teams-surface border border-teams-border rounded shadow-sm opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <button
            onClick={() => setShowReactionPicker(!showReactionPicker)}
            className="p-1 hover:bg-teams-bg rounded text-teams-secondary text-sm"
            title="Add reaction"
            aria-label="Add reaction"
          >
            😊
          </button>
          {!message.parent_message_id && (
            <button
              onClick={() => openThread(message.id)}
              className="p-1 hover:bg-teams-bg rounded text-teams-secondary text-sm"
              title="Reply in thread"
              aria-label="Reply in thread"
            >
              💬
            </button>
          )}
        </div>
      )}

      {/* Reaction picker */}
      {showReactionPicker && (
        <div className="absolute top-8 right-2 z-10">
          <ReactionPicker onSelect={handleReaction} />
        </div>
      )}
    </div>
  );
}
