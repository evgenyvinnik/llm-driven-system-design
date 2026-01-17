import { useState, useRef, useEffect } from 'react';
import { messageApi } from '../services/api';
import { useAuthStore, useChannelStore, useMessageStore, useUIStore } from '../stores';
import { formatMessageTime, shouldShowDateDivider, formatDateDivider, groupReactions, getInitials } from '../utils';
import type { Message } from '../types';

interface MessageListProps {
  channelId: string;
  sendTyping?: () => void;
}

export function MessageList({ channelId, sendTyping }: MessageListProps) {
  const [newMessage, setNewMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { user } = useAuthStore();
  const { currentChannel } = useChannelStore();
  const { messages, setMessages, typingUsers, setActiveThread } = useMessageStore();
  const { setThreadPanelOpen } = useUIStore();

  const channelMessages = messages[channelId] || [];

  useEffect(() => {
    loadMessages();
  }, [channelId]);

  useEffect(() => {
    scrollToBottom();
  }, [channelMessages]);

  const loadMessages = async () => {
    setIsLoading(true);
    try {
      const msgs = await messageApi.list(channelId);
      setMessages(channelId, msgs);
    } catch (error) {
      console.error('Failed to load messages:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    try {
      await messageApi.send(channelId, newMessage.trim());
      setNewMessage('');
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(e);
    }
    if (sendTyping) {
      sendTyping();
    }
  };

  const handleOpenThread = async (message: Message) => {
    try {
      const thread = await messageApi.getThread(message.id);
      setActiveThread(thread);
      setThreadPanelOpen(true);
    } catch (error) {
      console.error('Failed to open thread:', error);
    }
  };

  const handleEditMessage = (message: Message) => {
    setEditingMessageId(message.id);
    setEditContent(message.content);
  };

  const handleSaveEdit = async () => {
    if (!editingMessageId || !editContent.trim()) return;

    try {
      await messageApi.update(editingMessageId, editContent.trim());
      setEditingMessageId(null);
      setEditContent('');
    } catch (error) {
      console.error('Failed to update message:', error);
    }
  };

  const handleDeleteMessage = async (messageId: number) => {
    if (!confirm('Are you sure you want to delete this message?')) return;

    try {
      await messageApi.delete(messageId);
    } catch (error) {
      console.error('Failed to delete message:', error);
    }
  };

  const handleAddReaction = async (messageId: number, emoji: string) => {
    try {
      await messageApi.addReaction(messageId, emoji);
    } catch (error) {
      console.error('Failed to add reaction:', error);
    }
  };

  const handleRemoveReaction = async (messageId: number, emoji: string) => {
    try {
      await messageApi.removeReaction(messageId, emoji);
    } catch (error) {
      console.error('Failed to remove reaction:', error);
    }
  };

  const renderMessage = (message: Message, index: number) => {
    const previousMessage = channelMessages[index - 1];
    const showDateDivider = shouldShowDateDivider(
      message.created_at,
      previousMessage?.created_at
    );
    const isEditing = editingMessageId === message.id;
    const isOwnMessage = message.user_id === user?.id;
    const reactions = groupReactions(message.reactions);

    return (
      <div key={message.id}>
        {showDateDivider && (
          <div className="flex items-center gap-4 my-4">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs font-medium text-gray-500 bg-white px-2">
              {formatDateDivider(message.created_at)}
            </span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>
        )}

        <div className="message-item group flex gap-3 px-4 py-2 hover:bg-slack-message-hover">
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
              {message.edited_at && <span className="text-xs text-gray-400">(edited)</span>}
            </div>

            {isEditing ? (
              <div className="mt-1">
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-slack-blue text-sm"
                  rows={2}
                  autoFocus
                />
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => setEditingMessageId(null)}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    className="text-sm bg-slack-green text-white px-3 py-1 rounded hover:bg-opacity-90"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="message-content text-gray-900 text-sm">{message.content}</div>
            )}

            {/* Reactions */}
            {reactions.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {reactions.map((reaction) => {
                  const hasReacted = reaction.userIds.includes(user?.id || '');
                  return (
                    <button
                      key={reaction.emoji}
                      onClick={() =>
                        hasReacted
                          ? handleRemoveReaction(message.id, reaction.emoji)
                          : handleAddReaction(message.id, reaction.emoji)
                      }
                      className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
                        hasReacted
                          ? 'bg-blue-50 border-blue-200 text-blue-600'
                          : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      <span>{reaction.emoji}</span>
                      <span>{reaction.count}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Thread indicator */}
            {message.reply_count > 0 && (
              <button
                onClick={() => handleOpenThread(message)}
                className="flex items-center gap-1 mt-1 text-xs text-slack-blue hover:underline"
              >
                <span>{message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'}</span>
              </button>
            )}
          </div>

          {/* Message actions */}
          <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
            <button
              onClick={() => handleAddReaction(message.id, '👍')}
              className="p-1 hover:bg-gray-200 rounded text-gray-500"
              title="Add reaction"
            >
              😀
            </button>
            <button
              onClick={() => handleOpenThread(message)}
              className="p-1 hover:bg-gray-200 rounded text-gray-500"
              title="Reply in thread"
            >
              💬
            </button>
            {isOwnMessage && (
              <>
                <button
                  onClick={() => handleEditMessage(message)}
                  className="p-1 hover:bg-gray-200 rounded text-gray-500"
                  title="Edit"
                >
                  ✏️
                </button>
                <button
                  onClick={() => handleDeleteMessage(message.id)}
                  className="p-1 hover:bg-gray-200 rounded text-gray-500"
                  title="Delete"
                >
                  🗑️
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  const currentTypingUsers = typingUsers[channelId] || [];

  return (
    <div className="flex flex-col h-full">
      {/* Channel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <div>
          <h2 className="font-bold text-lg">
            {currentChannel?.is_dm ? '' : '#'} {currentChannel?.name}
          </h2>
          {currentChannel?.topic && (
            <p className="text-sm text-gray-500">{currentChannel.topic}</p>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-gray-500">Loading messages...</div>
          </div>
        ) : channelMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <p className="text-lg mb-2">No messages yet</p>
            <p className="text-sm">Be the first to send a message!</p>
          </div>
        ) : (
          <>
            {channelMessages.map((message, index) => renderMessage(message, index))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Typing indicator */}
      {currentTypingUsers.length > 0 && (
        <div className="px-4 py-1 text-sm text-gray-500">
          {currentTypingUsers.join(', ')} {currentTypingUsers.length === 1 ? 'is' : 'are'} typing...
        </div>
      )}

      {/* Message input */}
      <div className="p-4 border-t border-gray-200">
        <form onSubmit={handleSendMessage} className="flex flex-col">
          <div className="flex items-end gap-2 border border-gray-300 rounded-lg p-2 focus-within:ring-2 focus-within:ring-slack-blue focus-within:border-transparent">
            <textarea
              ref={inputRef}
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Message ${currentChannel?.is_dm ? '' : '#'}${currentChannel?.name || ''}`}
              className="flex-1 resize-none focus:outline-none text-sm"
              rows={1}
            />
            <button
              type="submit"
              disabled={!newMessage.trim()}
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
