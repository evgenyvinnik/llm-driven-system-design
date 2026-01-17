import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import type { ChatMessage, Emote } from '../types';

// Demo emotes (in production, fetch from API)
const DEMO_EMOTES: Emote[] = [
  { id: 1, code: 'Kappa', imageUrl: '/emotes/kappa.png', tier: 0, isGlobal: true },
  { id: 2, code: 'PogChamp', imageUrl: '/emotes/pogchamp.png', tier: 0, isGlobal: true },
  { id: 3, code: 'LUL', imageUrl: '/emotes/lul.png', tier: 0, isGlobal: true },
  { id: 4, code: 'KEKW', imageUrl: '/emotes/kekw.png', tier: 0, isGlobal: true },
  { id: 5, code: 'monkaS', imageUrl: '/emotes/monkas.png', tier: 0, isGlobal: true },
];

interface ChatProps {
  channelId: number;
  channelName: string;
}

export function Chat({ channelId, channelName }: ChatProps) {
  const { user } = useAuthStore();
  const { messages, viewerCount, sendMessage, connected } = useChatStore();
  const [inputValue, setInputValue] = useState('');
  const [showEmotePicker, setShowEmotePicker] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    sendMessage(channelId, inputValue.trim());
    setInputValue('');
    setShowEmotePicker(false);
  };

  const insertEmote = (code: string) => {
    setInputValue((prev) => prev + (prev ? ' ' : '') + code + ' ');
    inputRef.current?.focus();
  };

  const renderMessage = (message: ChatMessage) => {
    // Parse emotes in message
    const parts = message.message.split(/\s+/);
    const renderedParts = parts.map((part, i) => {
      const emote = DEMO_EMOTES.find((e) => e.code === part);
      if (emote) {
        return (
          <span key={i} className="emote inline-block align-middle mx-0.5" title={emote.code}>
            [{emote.code}]
          </span>
        );
      }
      return <span key={i}>{part} </span>;
    });

    return renderedParts;
  };

  return (
    <div className="flex flex-col h-full bg-surface-darker">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-800">
        <h3 className="font-semibold text-white">Stream Chat</h3>
        <span className="text-gray-400 text-sm">{viewerCount} viewers</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-2">
        {messages.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            <p>Welcome to the chat room!</p>
            <p className="text-sm">Say hello to {channelName}</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`chat-message py-1 px-2 rounded hover:bg-white/5 ${
                msg.type === 'error' ? 'text-red-400' : ''
              }`}
            >
              {msg.type === 'error' ? (
                <span className="text-red-400 text-sm">{msg.message}</span>
              ) : (
                <>
                  {/* Badges */}
                  {msg.badges.map((badge, i) => (
                    <span
                      key={i}
                      className={`badge badge-${badge.type}`}
                      title={badge.label || badge.type}
                    >
                      {badge.type === 'subscriber' ? `T${badge.tier}` : badge.label?.[0] || badge.type[0].toUpperCase()}
                    </span>
                  ))}

                  {/* Username */}
                  <span
                    className="font-semibold cursor-pointer hover:underline"
                    style={{ color: getUserColor(msg.username) }}
                  >
                    {msg.username}
                  </span>
                  <span className="text-white">: </span>

                  {/* Message */}
                  <span className="text-gray-200 break-words">
                    {renderMessage(msg)}
                  </span>
                </>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Emote Picker */}
      {showEmotePicker && (
        <div className="border-t border-gray-800 p-2 bg-surface-light">
          <div className="flex flex-wrap gap-2">
            {DEMO_EMOTES.map((emote) => (
              <button
                key={emote.id}
                onClick={() => insertEmote(emote.code)}
                className="px-2 py-1 bg-surface-darker rounded hover:bg-gray-700 text-sm"
                title={emote.code}
              >
                {emote.code}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="p-2 border-t border-gray-800">
        {!connected ? (
          <div className="text-center text-gray-500 py-2">
            Connecting to chat...
          </div>
        ) : !user ? (
          <div className="text-center text-gray-400 py-2">
            <p className="text-sm">Log in to chat</p>
          </div>
        ) : (
          <form onSubmit={handleSend} className="flex gap-2">
            <div className="flex-1 relative">
              <input
                ref={inputRef}
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Send a message"
                maxLength={500}
                className="w-full bg-surface-light border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-twitch-500 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowEmotePicker(!showEmotePicker)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-4-8c.79 0 1.5-.71 1.5-1.5S8.79 9 8 9s-1.5.71-1.5 1.5S7.21 12 8 12zm8 0c.79 0 1.5-.71 1.5-1.5S16.79 9 16 9s-1.5.71-1.5 1.5.71 1.5 1.5 1.5zm-4 5.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" />
                </svg>
              </button>
            </div>
            <button
              type="submit"
              disabled={!inputValue.trim()}
              className="px-4 py-2 bg-twitch-500 text-white rounded font-semibold hover:bg-twitch-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Chat
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// Generate consistent color based on username
function getUserColor(username: string): string {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
    '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
    '#BB8FCE', '#85C1E9', '#F8B500', '#00CED1',
    '#FF69B4', '#32CD32', '#FFD700', '#FF4500',
  ];
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}
