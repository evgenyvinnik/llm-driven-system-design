import { useState, useRef, useEffect } from 'react';
import { messageApi } from '../services/api';
import { useAuthStore, useMessageStore, useUIStore } from '../stores';
import { formatMessageTime, groupReactions, getInitials } from '../utils';
import type { Message } from '../types';

export function ThreadPanel() {
  const [newReply, setNewReply] = useState('');
  const repliesEndRef = useRef<HTMLDivElement>(null);

  const { user } = useAuthStore();
  const { activeThread, addThreadReply } = useMessageStore();
  const { setThreadPanelOpen } = useUIStore();

  useEffect(() => {
    scrollToBottom();
  }, [activeThread?.replies]);

  const scrollToBottom = () => {
    repliesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newReply.trim() || !activeThread) return;

    try {
      const reply = await messageApi.send(
        activeThread.parent.channel_id,
        newReply.trim(),
        activeThread.parent.id
      );
      addThreadReply(reply);
      setNewReply('');
    } catch (error) {
      console.error('Failed to send reply:', error);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendReply(e);
    }
  };

  const handleClose = () => {
    setThreadPanelOpen(false);
  };

  if (!activeThread) return null;

  const renderMessage = (message: Message, isParent: boolean = false) => {
    const reactions = groupReactions(message.reactions);

    return (
      <div className={`flex gap-3 p-4 ${isParent ? 'border-b border-gray-200' : 'hover:bg-gray-50'}`}>
        <div className="flex-shrink-0">
          {message.avatar_url ? (
            <img
              src={message.avatar_url}
              alt={message.display_name}
              className="w-9 h-9 rounded"
            />
          ) : (
            <div className="w-9 h-9 rounded bg-slack-green flex items-center justify-center text-white text-sm font-medium">
              {getInitials(message.display_name || message.username)}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-bold text-gray-900">{message.display_name || message.username}</span>
            <span className="text-xs text-gray-500">{formatMessageTime(message.created_at)}</span>
          </div>
          <div className="message-content text-gray-900 text-sm mt-1">{message.content}</div>

          {reactions.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {reactions.map((reaction) => (
                <span
                  key={reaction.emoji}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600"
                >
                  <span>{reaction.emoji}</span>
                  <span>{reaction.count}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="thread-panel w-96 border-l border-gray-200 flex flex-col h-full bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <h3 className="font-bold text-lg">Thread</h3>
        <button
          onClick={handleClose}
          className="p-1 hover:bg-gray-100 rounded text-gray-500"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Parent message */}
      {renderMessage(activeThread.parent, true)}

      {/* Reply count */}
      <div className="px-4 py-2 text-xs text-gray-500 border-b border-gray-200">
        {activeThread.replies.length} {activeThread.replies.length === 1 ? 'reply' : 'replies'}
      </div>

      {/* Replies */}
      <div className="flex-1 overflow-y-auto">
        {activeThread.replies.map((reply) => renderMessage(reply))}
        <div ref={repliesEndRef} />
      </div>

      {/* Reply input */}
      <div className="p-4 border-t border-gray-200">
        <form onSubmit={handleSendReply} className="flex flex-col">
          <div className="flex items-end gap-2 border border-gray-300 rounded-lg p-2 focus-within:ring-2 focus-within:ring-slack-blue focus-within:border-transparent">
            <textarea
              value={newReply}
              onChange={(e) => setNewReply(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Reply..."
              className="flex-1 resize-none focus:outline-none text-sm"
              rows={1}
            />
            <button
              type="submit"
              disabled={!newReply.trim()}
              className="p-2 bg-slack-green text-white rounded hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
