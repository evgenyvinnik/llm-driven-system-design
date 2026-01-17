import { useState, useRef, useEffect, useCallback } from 'react';
import type { Conversation, Message, TypingUser } from '@/types';
import { useChatStore } from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';

interface ChatViewProps {
  conversation: Conversation;
}

export function ChatView({ conversation }: ChatViewProps) {
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const user = useAuthStore((state) => state.user);
  const messages = useChatStore((state) => state.messages.get(conversation.id) || []);
  const typingUsers = useChatStore((state) => state.typingUsers.get(conversation.id) || []);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const setTypingIndicator = useChatStore((state) => state.setTyping);
  const isLoadingMessages = useChatStore((state) => state.isLoadingMessages);

  // Get display name for conversation
  const getConversationName = () => {
    if (conversation.type === 'group') {
      return conversation.name || 'Group Chat';
    }
    const otherParticipant = conversation.participants?.find((p) => p.id !== user?.id);
    return otherParticipant?.display_name || otherParticipant?.username || 'Unknown';
  };

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, [conversation.id]);

  const handleTyping = useCallback(() => {
    if (!isTyping) {
      setIsTyping(true);
      setTypingIndicator(conversation.id, true);
    }

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Set new timeout to stop typing indicator
    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      setTypingIndicator(conversation.id, false);
    }, 2000);
  }, [conversation.id, isTyping, setTypingIndicator]);

  const handleSend = async () => {
    const content = inputValue.trim();
    if (!content) return;

    setInputValue('');
    setIsTyping(false);
    setTypingIndicator(conversation.id, false);

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    await sendMessage(conversation.id, content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Group messages by date
  const groupMessagesByDate = (messages: Message[]) => {
    const groups: { date: string; messages: Message[] }[] = [];
    let currentDate = '';

    for (const message of messages) {
      const messageDate = new Date(message.created_at).toLocaleDateString();
      if (messageDate !== currentDate) {
        currentDate = messageDate;
        groups.push({ date: messageDate, messages: [] });
      }
      groups[groups.length - 1].messages.push(message);
    }

    return groups;
  };

  const messageGroups = groupMessagesByDate(messages);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-gray-200 bg-gray-50">
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900">{getConversationName()}</h2>
          {conversation.type === 'group' && (
            <p className="text-sm text-gray-500">
              {conversation.participants?.length || 0} participants
            </p>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-thin">
        {isLoadingMessages ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-imessage-blue"></div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            <p>No messages yet. Start the conversation!</p>
          </div>
        ) : (
          <>
            {messageGroups.map((group) => (
              <div key={group.date}>
                <div className="flex justify-center my-4">
                  <span className="text-xs text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
                    {group.date === new Date().toLocaleDateString() ? 'Today' : group.date}
                  </span>
                </div>
                {group.messages.map((message, index) => {
                  const isOwnMessage = message.sender_id === user?.id;
                  const showAvatar =
                    !isOwnMessage &&
                    (index === 0 ||
                      group.messages[index - 1].sender_id !== message.sender_id);

                  return (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isOwn={isOwnMessage}
                      showAvatar={showAvatar}
                    />
                  );
                })}
              </div>
            ))}
            {typingUsers.length > 0 && (
              <TypingIndicator users={typingUsers} />
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-gray-200 bg-gray-50">
        <div className="flex items-center space-x-2">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              handleTyping();
            }}
            onKeyDown={handleKeyDown}
            placeholder="iMessage"
            className="flex-1 px-4 py-2 bg-white border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-imessage-blue focus:border-transparent"
          />
          <button
            onClick={handleSend}
            disabled={!inputValue.trim()}
            className="p-2 rounded-full bg-imessage-blue text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-600 transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
