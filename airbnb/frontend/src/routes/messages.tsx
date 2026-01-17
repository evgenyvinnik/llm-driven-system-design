import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { messagesAPI } from '../services/api';
import { Conversation, Message } from '../types';
import { useAuthStore } from '../stores/authStore';
import { formatDate } from '../utils/helpers';

export const Route = createFileRoute('/messages')({
  component: MessagesPage,
});

function MessagesPage() {
  const { user, isAuthenticated } = useAuthStore();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;

    const loadConversations = async () => {
      try {
        const response = await messagesAPI.getConversations();
        setConversations(response.conversations);
      } catch (err) {
        console.error('Failed to load conversations:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadConversations();
  }, [isAuthenticated]);

  const loadMessages = async (conversationId: number) => {
    try {
      const response = await messagesAPI.getConversation(conversationId);
      setSelectedConversation(response.conversation);
      setMessages(response.messages);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  };

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedConversation) return;

    setIsSending(true);
    try {
      const response = await messagesAPI.sendMessage(selectedConversation.id, newMessage);
      setMessages((prev) => [...prev, response.message]);
      setNewMessage('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setIsSending(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h1 className="text-2xl font-bold mb-4">Log in to view messages</h1>
        <Link to="/login" className="btn-primary">
          Log in
        </Link>
      </div>
    );
  }

  const getOtherParty = (conv: Conversation) => {
    const isHost = conv.host_id === user?.id;
    return {
      name: isHost ? conv.guest_name : conv.host_name,
      avatar: isHost ? conv.guest_avatar : conv.host_avatar,
    };
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">Messages</h1>

      <div className="flex h-[600px] border border-gray-200 rounded-xl overflow-hidden">
        {/* Conversation List */}
        <div className="w-1/3 border-r border-gray-200 overflow-y-auto">
          {isLoading ? (
            <div className="p-4 space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="animate-pulse flex gap-3">
                  <div className="w-12 h-12 bg-gray-200 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-gray-200 rounded w-3/4" />
                    <div className="h-3 bg-gray-200 rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : conversations.length > 0 ? (
            conversations.map((conv) => {
              const other = getOtherParty(conv);
              const isSelected = selectedConversation?.id === conv.id;

              return (
                <button
                  key={conv.id}
                  onClick={() => loadMessages(conv.id)}
                  className={`w-full p-4 flex gap-3 hover:bg-gray-50 text-left ${
                    isSelected ? 'bg-gray-100' : ''
                  }`}
                >
                  <div className="w-12 h-12 rounded-full bg-gray-200 overflow-hidden shrink-0">
                    {other.avatar && (
                      <img src={other.avatar} alt="" className="w-full h-full object-cover" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium truncate">{other.name}</span>
                      {conv.unread_count && conv.unread_count > 0 && (
                        <span className="bg-airbnb text-white text-xs px-2 py-0.5 rounded-full">
                          {conv.unread_count}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500 truncate">
                      {conv.last_message || conv.listing_title}
                    </p>
                  </div>
                </button>
              );
            })
          ) : (
            <div className="p-4 text-center text-gray-500">
              <p>No messages yet</p>
            </div>
          )}
        </div>

        {/* Message Thread */}
        <div className="flex-1 flex flex-col">
          {selectedConversation ? (
            <>
              {/* Header */}
              <div className="p-4 border-b border-gray-200">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gray-200 overflow-hidden">
                    {getOtherParty(selectedConversation).avatar && (
                      <img
                        src={getOtherParty(selectedConversation).avatar}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <div>
                    <p className="font-medium">{getOtherParty(selectedConversation).name}</p>
                    {selectedConversation.listing_title && (
                      <p className="text-sm text-gray-500">{selectedConversation.listing_title}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.map((message) => {
                  const isOwn = message.sender_id === user?.id;

                  return (
                    <div
                      key={message.id}
                      className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-xs lg:max-w-md px-4 py-2 rounded-2xl ${
                          isOwn ? 'bg-airbnb text-white' : 'bg-gray-100 text-gray-900'
                        }`}
                      >
                        <p>{message.content}</p>
                        <p
                          className={`text-xs mt-1 ${
                            isOwn ? 'text-white/70' : 'text-gray-500'
                          }`}
                        >
                          {formatDate(message.created_at)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Input */}
              <div className="p-4 border-t border-gray-200">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                    placeholder="Type a message..."
                    className="flex-1 input-field"
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={isSending || !newMessage.trim()}
                    className="btn-primary disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              <p>Select a conversation to view messages</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
