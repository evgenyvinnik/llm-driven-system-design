/**
 * Conversation List Component
 *
 * Displays the sidebar list of user's conversations.
 * Shows conversation name, last message preview, unread count,
 * typing indicators, and online status for participants.
 */

import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import { Conversation } from '../types';

/**
 * Props for the ConversationList component.
 */
interface ConversationListProps {
  /** Callback when a conversation is selected */
  onSelectConversation: (conversationId: string) => void;
  /** Callback to open the new chat dialog */
  onNewChat: () => void;
}

/**
 * Sidebar conversation list with search and new chat functionality.
 * @param props - Component props with selection and new chat callbacks
 */
export function ConversationList({ onSelectConversation, onNewChat }: ConversationListProps) {
  const { user } = useAuthStore();
  const {
    conversations,
    currentConversationId,
    typingUsers,
    userPresence,
    isLoadingConversations,
    loadConversations,
  } = useChatStore();

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const getConversationName = (conversation: Conversation): string => {
    if (conversation.is_group && conversation.name) {
      return conversation.name;
    }

    // For 1:1 chats, find the other participant
    const otherParticipant = conversation.participants?.find(
      (p) => p.user_id !== user?.id
    );
    return otherParticipant?.user?.display_name || 'Unknown';
  };

  const getConversationAvatar = (conversation: Conversation): string => {
    const name = getConversationName(conversation);
    return name.charAt(0).toUpperCase();
  };

  const isOnline = (conversation: Conversation): boolean => {
    if (conversation.is_group) return false;

    const otherParticipant = conversation.participants?.find(
      (p) => p.user_id !== user?.id
    );
    if (!otherParticipant) return false;

    const presence = userPresence[otherParticipant.user_id];
    return presence?.status === 'online';
  };

  const getTypingText = (conversationId: string): string | null => {
    const typing = typingUsers[conversationId];
    if (!typing || typing.length === 0) return null;

    // Find user names
    const conversation = conversations.find((c) => c.id === conversationId);
    const typingNames = typing
      .map((userId) => {
        const participant = conversation?.participants?.find(
          (p) => p.user_id === userId
        );
        return participant?.user?.display_name || 'Someone';
      })
      .join(', ');

    return `${typingNames} is typing...`;
  };

  const formatTime = (dateString?: string): string => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diffDays = Math.floor(
      (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (diffDays === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return date.toLocaleDateString([], { weekday: 'short' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  if (isLoadingConversations) {
    return (
      <div className="flex items-center justify-center h-full bg-whatsapp-sidebar-bg">
        <div className="text-whatsapp-text-secondary">Loading conversations...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-whatsapp-sidebar-bg">
      {/* Header */}
      <div className="px-4 py-2 bg-whatsapp-header text-white flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-whatsapp-teal rounded-full flex items-center justify-center text-white font-bold">
            {user?.display_name?.charAt(0).toUpperCase() || 'U'}
          </div>
          <span className="font-medium">{user?.display_name}</span>
        </div>
        <button
          onClick={onNewChat}
          className="p-2 hover:bg-whatsapp-teal rounded-full transition-colors"
          title="New Chat"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {/* Search bar */}
      <div className="px-3 py-2 bg-whatsapp-sidebar-bg">
        <div className="relative">
          <input
            type="text"
            placeholder="Search or start new chat"
            className="w-full py-2 pl-10 pr-4 bg-whatsapp-search-bg rounded-lg border-none focus:outline-none text-message text-whatsapp-text-primary placeholder:text-whatsapp-text-secondary"
          />
          <svg
            className="absolute left-3 top-2.5 w-5 h-5 text-whatsapp-text-secondary"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-whatsapp-text-secondary p-4">
            <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            <p>No conversations yet</p>
            <button
              onClick={onNewChat}
              className="mt-4 px-4 py-2 bg-whatsapp-header text-white rounded-lg hover:bg-whatsapp-teal transition-colors"
            >
              Start a new chat
            </button>
          </div>
        ) : (
          conversations.map((conversation) => {
            const typingText = getTypingText(conversation.id);

            return (
              <div
                key={conversation.id}
                data-testid="conversation-item"
                onClick={() => onSelectConversation(conversation.id)}
                className={`flex items-center px-3 py-3 cursor-pointer hover:bg-whatsapp-hover border-b border-whatsapp-divider ${
                  currentConversationId === conversation.id ? 'bg-whatsapp-selected' : ''
                }`}
              >
                {/* Avatar */}
                <div className="relative">
                  <div
                    className={`w-12 h-12 rounded-full flex items-center justify-center text-white font-bold ${
                      conversation.is_group ? 'bg-gray-400' : 'bg-whatsapp-teal'
                    }`}
                  >
                    {getConversationAvatar(conversation)}
                  </div>
                  {isOnline(conversation) && (
                    <div className="absolute bottom-0 right-0 w-3 h-3 bg-whatsapp-green rounded-full border-2 border-white"></div>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 ml-3 min-w-0">
                  <div className="flex justify-between items-baseline">
                    <span className="font-medium text-contact text-whatsapp-text-primary truncate">
                      {getConversationName(conversation)}
                    </span>
                    <span className="text-timestamp text-whatsapp-text-secondary ml-2 flex-shrink-0">
                      {formatTime(conversation.last_message?.created_at)}
                    </span>
                  </div>
                  <div className="flex justify-between items-center mt-0.5">
                    <span
                      className={`text-sm truncate ${
                        typingText ? 'text-whatsapp-green italic' : 'text-whatsapp-text-secondary'
                      }`}
                    >
                      {typingText || conversation.last_message?.content || 'No messages yet'}
                    </span>
                    {/* Coerce to boolean: `count && ...` renders a literal 0 when the
                        count is zero, because 0 is a valid React child. */}
                    {(conversation.unread_count ?? 0) > 0 && (
                      <span className="ml-2 min-w-[20px] h-5 px-1.5 bg-whatsapp-green text-white text-xs rounded-full flex items-center justify-center flex-shrink-0">
                        {conversation.unread_count}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
