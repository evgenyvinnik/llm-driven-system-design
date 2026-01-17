import { useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chatStore';
import type { Message } from '../types';

function MessageItem({ message }: { message: Message }) {
  const timestamp = new Date(message.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const isSystem = message.user === 'system';

  if (isSystem) {
    return (
      <div className="px-4 py-1 hover:bg-discord-hover group">
        <p className="text-discord-muted text-sm italic">{message.content}</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-1 hover:bg-discord-hover group flex">
      <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center mr-4 mt-0.5 flex-shrink-0">
        <span className="text-white font-semibold">
          {message.user.charAt(0).toUpperCase()}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-white hover:underline cursor-pointer">
            {message.user}
          </span>
          <span className="text-xs text-discord-muted">{timestamp}</span>
        </div>
        <p className="text-discord-text break-words">{message.content}</p>
      </div>
    </div>
  );
}

export function MessageList() {
  const { messages, currentRoom, isLoadingMessages } = useChatStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!currentRoom) {
    return (
      <div className="flex-1 flex items-center justify-center bg-discord-channel">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-white mb-2">
            Welcome to Baby Discord
          </h2>
          <p className="text-discord-muted">
            Select a room from the sidebar to start chatting
          </p>
        </div>
      </div>
    );
  }

  if (isLoadingMessages) {
    return (
      <div className="flex-1 flex items-center justify-center bg-discord-channel">
        <div className="text-discord-muted">Loading messages...</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin bg-discord-channel">
      {/* Channel welcome */}
      <div className="px-4 py-8 border-b border-discord-sidebar">
        <div className="w-16 h-16 rounded-full bg-discord-sidebar flex items-center justify-center mb-4">
          <span className="text-4xl text-discord-muted">#</span>
        </div>
        <h2 className="text-3xl font-bold text-white mb-1">
          Welcome to #{currentRoom}
        </h2>
        <p className="text-discord-muted">
          This is the start of the #{currentRoom} channel.
        </p>
      </div>

      {/* Messages */}
      <div className="py-4">
        {messages.length === 0 ? (
          <div className="px-4 text-discord-muted text-sm">
            No messages yet. Be the first to say something!
          </div>
        ) : (
          messages.map((msg, index) => (
            <MessageItem key={msg.messageId || index} message={msg} />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
