import { useRef, useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';

/** Main chat area with message list, input, and auto-scroll on new messages. */
export function ChatArea() {
  const { messages, currentChannelId, channels, loading, sendMessage, toggleMemberList } =
    useChatStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const currentChannel = channels.find((c) => c.id === currentChannelId);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!currentChannelId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-teams-bg">
        <p className="text-teams-secondary">Select a channel to start chatting</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-teams-bg">
      {/* Channel header */}
      <div className="h-12 bg-teams-surface border-b border-teams-border flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <span className="text-teams-secondary">#</span>
          <h2 className="font-semibold text-teams-text">{currentChannel?.name || 'Channel'}</h2>
          {currentChannel?.description && (
            <span className="text-sm text-teams-secondary ml-2">{currentChannel.description}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            data-testid="toggle-members"
            onClick={toggleMemberList}
            className="p-1.5 text-teams-secondary hover:text-teams-text hover:bg-teams-bg rounded transition-colors"
            title="Toggle member list"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-teams-secondary">Loading messages...</p>
          </div>
        ) : (
          <>
            <MessageList messages={messages} />
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <MessageInput onSend={sendMessage} channelId={currentChannelId} />
    </div>
  );
}
