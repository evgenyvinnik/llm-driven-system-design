import { useEffect, useLayoutEffect, useRef } from 'react';
import { useChatStore } from '../stores/chatStore';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';

/** Within this many pixels of the bottom, the list follows new messages. */
const PINNED_THRESHOLD = 80;

/** Main chat area: history with load-older, live updates, connection state, and the composer. */
export function ChatArea() {
  const {
    messages,
    currentChannelId,
    channels,
    loading,
    loadError,
    hasMore,
    loadingOlder,
    streamStatus,
    sendMessage,
    loadMoreMessages,
    openChannel,
    toggleMemberList,
  } = useChatStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const firstId = useRef<string | null>(null);
  const previousHeight = useRef(0);

  const currentChannel = channels.find((c) => c.id === currentChannelId);

  useEffect(() => {
    pinned.current = true;
    firstId.current = null;
  }, [currentChannelId]);

  // Before paint: keep the reader's place when older history is prepended, and follow new
  // messages only when the reader is already at the bottom (a reaction or an incoming message
  // must not yank someone who scrolled up to read).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = messages[0]?.id ?? null;
    if (firstId.current && first !== firstId.current && !pinned.current) {
      el.scrollTop += el.scrollHeight - previousHeight.current;
    } else if (pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
    firstId.current = first;
    previousHeight.current = el.scrollHeight;
  }, [messages]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_THRESHOLD;
    if (el.scrollTop < 40 && hasMore && !loadingOlder) void loadMoreMessages();
  };

  const handleSend = (content: string) => {
    pinned.current = true; // your own message always scrolls into view
    void sendMessage(content);
  };

  if (!currentChannelId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-teams-bg">
        <p className="text-teams-secondary">Select a channel to start chatting</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-teams-bg min-w-0">
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
            aria-label="Toggle member list"
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

      {streamStatus === 'reconnecting' && (
        <div role="status" className="bg-amber-50 text-amber-800 text-xs px-4 py-1.5 border-b border-amber-200">
          Reconnecting… anything posted meanwhile will appear once the connection is back.
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label={`Messages in ${currentChannel?.name ?? 'channel'}`}
        aria-busy={loading}
        className="flex-1 overflow-y-auto px-4 py-2"
      >
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-teams-secondary">Loading messages...</p>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <p className="text-teams-secondary">Couldn&apos;t load messages: {loadError}</p>
            <button
              onClick={() => void openChannel(currentChannelId)}
              className="text-sm text-teams-primary hover:underline"
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="flex justify-center py-2">
                <button
                  onClick={() => void loadMoreMessages()}
                  disabled={loadingOlder}
                  className="text-xs text-teams-primary hover:underline disabled:text-teams-secondary"
                >
                  {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
                </button>
              </div>
            )}
            <MessageList messages={messages} />
          </>
        )}
      </div>

      {/* Input */}
      <MessageInput onSend={handleSend} channelId={currentChannelId} />
    </div>
  );
}
