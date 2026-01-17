import { createFileRoute, Navigate, Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useMatchStore } from '../stores/matchStore';
import { useEffect, useState, useRef } from 'react';
import ReignsAvatar from '../components/ReignsAvatar';

function ChatPage() {
  const { matchId } = Route.useParams();
  const { isAuthenticated, user } = useAuthStore();
  const {
    matches,
    messages,
    isLoading,
    loadMessages,
    sendMessage,
    unmatch,
    setCurrentMatch,
    subscribeToMessages,
  } = useMatchStore();
  const [newMessage, setNewMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [showMenu, setShowMenu] = useState(false);

  const match = matches.find((m) => m.id === matchId);

  useEffect(() => {
    if (isAuthenticated && matchId) {
      setCurrentMatch(matchId);
      loadMessages(matchId);
      const unsubscribe = subscribeToMessages();
      return () => {
        unsubscribe();
        setCurrentMatch(null);
      };
    }
  }, [isAuthenticated, matchId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || isSending) return;

    setIsSending(true);
    try {
      await sendMessage(newMessage.trim());
      setNewMessage('');
    } catch (error) {
      console.error('Failed to send message:', error);
    } finally {
      setIsSending(false);
    }
  };

  const handleUnmatch = async () => {
    if (window.confirm('Are you sure you want to unmatch? This cannot be undone.')) {
      await unmatch(matchId);
    }
  };

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  if (!match) {
    return <Navigate to="/matches" />;
  }

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* Header */}
      <header className="bg-white shadow-sm px-4 py-3 flex items-center">
        <Link to="/matches" className="mr-3">
          <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <div className="flex items-center flex-1">
          <div className="w-10 h-10 rounded-full overflow-hidden bg-gray-800">
            <ReignsAvatar
              seed={`${match.user.id}-${match.user.name}`}
              size={40}
            />
          </div>
          <h1 className="ml-3 font-semibold">{match.user.name}</h1>
        </div>
        <div className="relative">
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="p-2 hover:bg-gray-100 rounded-full"
          >
            <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          </button>
          {showMenu && (
            <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg py-1 z-10">
              <button
                onClick={handleUnmatch}
                className="w-full px-4 py-2 text-left text-red-600 hover:bg-gray-100"
              >
                Unmatch
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-8 h-8 border-4 border-gradient-start border-t-transparent rounded-full animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            <p>No messages yet.</p>
            <p className="text-sm mt-1">Say hi to start the conversation!</p>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.is_mine ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[75%] px-4 py-2 rounded-2xl ${
                    message.is_mine
                      ? 'bg-tinder-gradient text-white rounded-br-md'
                      : 'bg-white text-gray-900 rounded-bl-md shadow'
                  }`}
                >
                  <p className="break-words">{message.content}</p>
                  <p
                    className={`text-xs mt-1 ${
                      message.is_mine ? 'text-white/70' : 'text-gray-400'
                    }`}
                  >
                    {new Date(message.sent_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </main>

      {/* Message input */}
      <form onSubmit={handleSend} className="bg-white border-t p-3 flex items-center gap-2">
        <input
          type="text"
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          placeholder="Type a message..."
          className="flex-1 px-4 py-2 bg-gray-100 rounded-full focus:outline-none focus:ring-2 focus:ring-gradient-start"
        />
        <button
          type="submit"
          disabled={!newMessage.trim() || isSending}
          className="w-10 h-10 rounded-full bg-tinder-gradient text-white flex items-center justify-center disabled:opacity-50"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

export const Route = createFileRoute('/chat/$matchId')({
  component: ChatPage,
});
