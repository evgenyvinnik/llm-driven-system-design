import { useRef, useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { MessageItem } from './MessageItem';
import { MessageInput } from './MessageInput';

/** Slide-in panel displaying a message thread with replies and reply input. */
export function ThreadPanel() {
  const { threadMessages, threadParentId, closeThread, sendThreadReply, currentChannelId } =
    useChatStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [threadMessages]);

  if (!threadParentId) return null;

  const parentMessage = threadMessages[0];

  return (
    <div className="w-80 border-l border-teams-border bg-teams-surface flex flex-col">
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-teams-border">
        <h3 className="font-semibold text-sm text-teams-text">Thread</h3>
        <button
          onClick={closeThread}
          className="text-teams-secondary hover:text-teams-text text-lg"
          title="Close thread"
          aria-label="Close thread"
        >
          x
        </button>
      </div>

      {/* Thread messages */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {parentMessage && (
          <div className="mb-3 pb-3 border-b border-teams-border">
            <MessageItem message={parentMessage} />
          </div>
        )}

        <div className="space-y-0.5">
          {threadMessages.slice(1).map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
        </div>
        <div ref={messagesEndRef} />
      </div>

      {/* Reply input */}
      {currentChannelId && (
        <MessageInput
          onSend={sendThreadReply}
          channelId={currentChannelId}
          placeholder="Reply in thread..."
        />
      )}
    </div>
  );
}
