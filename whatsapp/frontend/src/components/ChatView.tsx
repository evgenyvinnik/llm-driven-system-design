/**
 * Chat View Component
 *
 * Displays the main chat interface for a conversation including:
 * - Message history with date separators
 * - Message status indicators (sent, delivered, read)
 * - Typing indicators for other participants
 * - Message input with typing event broadcasting
 */

import { useState, useEffect, useRef, FormEvent, useCallback } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import { sendMessage, sendTyping, sendReadReceipt } from '../hooks/useWebSocket';
import { messagesApi } from '../services/api';
import { Message, MessageStatus } from '../types';

/**
 * Props for the ChatView component.
 */
interface ChatViewProps {
  /** ID of the conversation to display */
  conversationId: string;
  /** Optional callback for back navigation (mobile) */
  onBack?: () => void;
}

/**
 * Main chat interface with message list and input.
 * Handles real-time message sending, typing indicators, and read receipts.
 * @param props - Component props with conversation ID and back callback
 */
export function ChatView({ conversationId, onBack }: ChatViewProps) {
  const { user } = useAuthStore();
  const {
    conversations,
    messages,
    typingUsers,
    userPresence,
    isLoadingMessages,
    loadMessages,
    addMessage,
    setCurrentConversation,
  } = useChatStore();

  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  const conversation = conversations.find((c) => c.id === conversationId);
  const conversationMessages = messages[conversationId] || [];
  const typing = typingUsers[conversationId] || [];

  // Load messages when conversation changes
  useEffect(() => {
    setCurrentConversation(conversationId);
    loadMessages(conversationId);

    // Mark as read
    messagesApi.markRead(conversationId).catch(console.error);
    sendReadReceipt(conversationId, []);

    return () => {
      setCurrentConversation(null);
    };
  }, [conversationId, loadMessages, setCurrentConversation]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversationMessages]);

  // Handle typing indicator
  const handleTyping = useCallback(() => {
    if (!isTyping) {
      setIsTyping(true);
      sendTyping(conversationId, true);
    }

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = window.setTimeout(() => {
      setIsTyping(false);
      sendTyping(conversationId, false);
    }, 2000);
  }, [conversationId, isTyping]);

  // Clean up typing timeout
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      if (isTyping) {
        sendTyping(conversationId, false);
      }
    };
  }, [conversationId, isTyping]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    const clientMessageId = crypto.randomUUID();

    // Add optimistic message
    const optimisticMessage: Message = {
      id: clientMessageId,
      conversation_id: conversationId,
      sender_id: user!.id,
      content: inputValue,
      content_type: 'text',
      created_at: new Date().toISOString(),
      status: 'sending',
      clientMessageId,
      sender: user!,
    };

    addMessage(optimisticMessage);

    // Send via WebSocket
    const sent = sendMessage(conversationId, inputValue, clientMessageId);

    if (!sent) {
      // Update to failed status
      // In production, you'd want to retry or show an error
      console.error('Failed to send message');
    }

    setInputValue('');
    setIsTyping(false);
    sendTyping(conversationId, false);
  };

  const getConversationName = (): string => {
    if (!conversation) return 'Loading...';
    if (conversation.is_group && conversation.name) {
      return conversation.name;
    }
    const otherParticipant = conversation.participants?.find(
      (p) => p.user_id !== user?.id
    );
    return otherParticipant?.user?.display_name || 'Unknown';
  };

  const getOnlineStatus = (): string => {
    if (!conversation || conversation.is_group) return '';

    const otherParticipant = conversation.participants?.find(
      (p) => p.user_id !== user?.id
    );
    if (!otherParticipant) return '';

    const presence = userPresence[otherParticipant.user_id];
    if (presence?.status === 'online') return 'Online';

    if (presence?.last_seen) {
      const lastSeen = new Date(presence.last_seen);
      return `Last seen ${lastSeen.toLocaleString()}`;
    }

    return 'Offline';
  };

  const getTypingNames = (): string | null => {
    if (typing.length === 0) return null;

    const names = typing
      .map((userId) => {
        const participant = conversation?.participants?.find(
          (p) => p.user_id === userId
        );
        return participant?.user?.display_name || 'Someone';
      })
      .join(', ');

    return `${names} is typing...`;
  };

  const renderMessageStatus = (status: MessageStatus | undefined) => {
    switch (status) {
      case 'sending':
        return (
          <svg className="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" />
          </svg>
        );
      case 'sent':
        return (
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        );
      case 'delivered':
        return (
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7M5 13l4 4L19 7" />
          </svg>
        );
      case 'read':
        return (
          <svg className="w-4 h-4 text-whatsapp-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7M5 13l4 4L19 7" />
          </svg>
        );
      default:
        return null;
    }
  };

  const formatMessageTime = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const shouldShowDate = (message: Message, prevMessage?: Message): boolean => {
    if (!prevMessage) return true;
    const msgDate = new Date(message.created_at).toDateString();
    const prevDate = new Date(prevMessage.created_at).toDateString();
    return msgDate !== prevDate;
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return 'Today';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString([], {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
    }
  };

  return (
    <div className="flex flex-col h-full bg-whatsapp-chat-bg">
      {/* Header */}
      <div className="p-3 bg-whatsapp-teal-green text-white flex items-center space-x-3">
        {onBack && (
          <button onClick={onBack} className="p-1 hover:bg-whatsapp-dark-green rounded">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
        <div
          className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold ${
            conversation?.is_group ? 'bg-gray-400' : 'bg-whatsapp-dark-green'
          }`}
        >
          {getConversationName().charAt(0).toUpperCase()}
        </div>
        <div className="flex-1">
          <div className="font-medium">{getConversationName()}</div>
          <div className="text-xs text-gray-200">
            {getTypingNames() || getOnlineStatus()}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {isLoadingMessages ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-gray-500">Loading messages...</div>
          </div>
        ) : conversationMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-gray-500">No messages yet. Say hello!</div>
          </div>
        ) : (
          conversationMessages.map((message, index) => {
            const prevMessage = index > 0 ? conversationMessages[index - 1] : undefined;
            const isOwn = message.sender_id === user?.id;

            return (
              <div key={message.id}>
                {shouldShowDate(message, prevMessage) && (
                  <div className="flex justify-center my-4">
                    <span className="px-3 py-1 bg-white rounded-lg text-xs text-gray-500 shadow">
                      {formatDate(message.created_at)}
                    </span>
                  </div>
                )}
                <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[70%] rounded-lg px-3 py-2 shadow ${
                      isOwn
                        ? 'bg-whatsapp-message-out rounded-tr-none'
                        : 'bg-whatsapp-message-in rounded-tl-none'
                    }`}
                  >
                    {conversation?.is_group && !isOwn && (
                      <div className="text-xs font-medium text-whatsapp-dark-green mb-1">
                        {message.sender?.display_name}
                      </div>
                    )}
                    <div className="text-gray-800 whitespace-pre-wrap break-words">
                      {message.content}
                    </div>
                    <div className="flex items-center justify-end space-x-1 mt-1">
                      <span className="text-xs text-gray-500">
                        {formatMessageTime(message.created_at)}
                      </span>
                      {isOwn && renderMessageStatus(message.status)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-3 bg-gray-100 flex items-center space-x-3">
        <div className="flex-1 relative">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              handleTyping();
            }}
            placeholder="Type a message"
            className="w-full py-2 px-4 rounded-full border-none focus:outline-none focus:ring-2 focus:ring-whatsapp-green"
          />
        </div>
        <button
          type="submit"
          disabled={!inputValue.trim()}
          className="p-2 bg-whatsapp-green text-white rounded-full hover:bg-whatsapp-dark-green disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
            />
          </svg>
        </button>
      </form>
    </div>
  );
}
