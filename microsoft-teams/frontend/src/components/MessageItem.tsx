import { useState } from 'react';
import type { Message } from '../types';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import { ReactionPicker } from './ReactionPicker';
import { FileAttachment } from './FileAttachment';
import { MessageEditor } from './MessageEditor';

interface MessageItemProps {
  message: Message;
}

/** Renders a chat message with author, reactions, attachments, thread link, and actions. */
export function MessageItem({ message }: MessageItemProps) {
  const { openThread, toggleReaction, editMessage, deleteMessage } = useChatStore();
  const user = useAuthStore((s) => s.user);
  const [showActions, setShowActions] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  const isOwn = !!user && user.id === message.user_id;
  const isDeleted = !!message.deleted_at;
  const time = new Date(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const run = async (action: () => Promise<void>) => {
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
  };

  const handleReaction = (emoji: string) => {
    setShowReactionPicker(false);
    if (user) run(() => toggleReaction(message.id, emoji, user.username));
  };

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    run(() => deleteMessage(message.id));
  };

  return (
    <div
      className="flex gap-3 px-2 py-1.5 hover:bg-teams-surface rounded-md group relative"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => {
        setShowActions(false);
        setShowReactionPicker(false);
        setConfirmDelete(false);
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
          {message.is_edited && !isDeleted && (
            <span className="text-xs text-teams-secondary italic">(edited)</span>
          )}
        </div>

        {isDeleted ? (
          <p data-testid="message-deleted" className="text-sm text-teams-secondary italic">
            This message was deleted.
          </p>
        ) : editing ? (
          <MessageEditor
            initial={message.content}
            onCancel={() => setEditing(false)}
            onSave={async (content) => {
              await editMessage(message.id, content);
              setEditing(false);
            }}
          />
        ) : (
          message.content && (
            <p className="text-sm text-teams-text whitespace-pre-wrap break-words">
              {message.content}
            </p>
          )
        )}

        {/* Attachments */}
        {!isDeleted && message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1">
            {message.attachments.map((a) => (
              <FileAttachment
                key={a.id}
                fileId={a.id}
                filename={a.filename}
                contentType={a.content_type ?? undefined}
                sizeBytes={a.size_bytes ?? undefined}
              />
            ))}
          </div>
        )}

        {/* Reactions: click to toggle your own */}
        {message.reactions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {message.reactions.map((reaction) => {
              const mine = !!user && reaction.users.includes(user.username);
              return (
                <button
                  key={reaction.emoji}
                  data-testid="reaction-badge"
                  onClick={() => handleReaction(reaction.emoji)}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-colors border ${
                    mine
                      ? 'bg-teams-primary/10 border-teams-primary'
                      : 'bg-teams-chat border-transparent hover:bg-teams-border'
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
            <span>
              {message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'}
            </span>
          </button>
        )}

        {error && <p className="text-xs text-teams-danger mt-1">{error}</p>}
      </div>

      {/* Hover actions */}
      {showActions && !isDeleted && !editing && (
        <div className="absolute top-0 right-2 flex items-center gap-0.5 bg-teams-surface border border-teams-border rounded shadow-sm">
          <button
            onClick={() => setShowReactionPicker(!showReactionPicker)}
            className="p-1 hover:bg-teams-bg rounded text-teams-secondary text-sm"
            title="Add reaction"
          >
            😊
          </button>
          {!message.parent_message_id && (
            <button
              onClick={() => openThread(message.id)}
              className="p-1 hover:bg-teams-bg rounded text-teams-secondary text-sm"
              title="Reply in thread"
            >
              💬
            </button>
          )}
          {isOwn && (
            <>
              <button
                data-testid="message-edit"
                onClick={() => setEditing(true)}
                className="px-1.5 py-1 hover:bg-teams-bg rounded text-teams-secondary text-xs"
                title="Edit"
              >
                Edit
              </button>
              <button
                data-testid="message-delete"
                onClick={handleDelete}
                className="px-1.5 py-1 hover:bg-teams-bg rounded text-teams-danger text-xs"
                title="Delete"
              >
                {confirmDelete ? 'Confirm delete' : 'Delete'}
              </button>
            </>
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
