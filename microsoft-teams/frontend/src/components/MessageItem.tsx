import { useState } from 'react';
import type { Message } from '../types';
import { useChatStore } from '../stores/chatStore';
import { ReactionPicker } from './ReactionPicker';
import { reactionApi } from '../services/api';

interface MessageItemProps {
  message: Message;
}

/** Renders a chat message with author, reactions, thread reply count, and action menu. */
export function MessageItem({ message }: MessageItemProps) {
  const { openThread } = useChatStore();
  const [showActions, setShowActions] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);

  const time = new Date(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const handleReaction = async (emoji: string) => {
    try {
      await reactionApi.add(message.id, emoji);
    } catch (err) {
      console.error('Failed to add reaction:', err);
    }
    setShowReactionPicker(false);
  };

  return (
    <div
      className="flex gap-3 px-2 py-1.5 hover:bg-teams-surface rounded-md group relative"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => {
        setShowActions(false);
        setShowReactionPicker(false);
      }}
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
          {message.is_edited && (
            <span className="text-xs text-teams-secondary italic">(edited)</span>
          )}
        </div>

        <p className="text-sm text-teams-text whitespace-pre-wrap break-words">{message.content}</p>

        {/* Reactions */}
        {message.reactions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                onClick={() => handleReaction(reaction.emoji)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-teams-chat text-xs hover:bg-teams-border transition-colors"
                title={reaction.users.join(', ')}
              >
                <span>{reaction.emoji}</span>
                <span className="text-teams-secondary">{reaction.count}</span>
              </button>
            ))}
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

      {/* Hover actions */}
      {showActions && (
        <div className="absolute top-0 right-2 flex items-center gap-0.5 bg-teams-surface border border-teams-border rounded shadow-sm">
          <button
            onClick={() => setShowReactionPicker(!showReactionPicker)}
            className="p-1 hover:bg-teams-bg rounded text-teams-secondary text-sm"
            title="Add reaction"
          >
            😊
          </button>
          <button
            onClick={() => openThread(message.id)}
            className="p-1 hover:bg-teams-bg rounded text-teams-secondary text-sm"
            title="Reply in thread"
          >
            💬
          </button>
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
