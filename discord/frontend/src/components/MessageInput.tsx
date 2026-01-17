import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';

export function MessageInput() {
  const [message, setMessage] = useState('');
  const { sendMessage, currentRoom, session } = useChatStore();
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when room changes
  useEffect(() => {
    if (currentRoom) {
      inputRef.current?.focus();
    }
  }, [currentRoom]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || !currentRoom) return;

    const content = message.trim();
    setMessage('');

    // Handle commands
    if (content.startsWith('/')) {
      // For commands, we'll let the server handle them
      await useChatStore.getState().sendMessage(content);
    } else {
      await sendMessage(content);
    }
  };

  if (!currentRoom) {
    return null;
  }

  return (
    <div className="px-4 pb-6 bg-discord-channel">
      <form onSubmit={handleSubmit}>
        <div className="flex items-center bg-discord-input rounded-lg px-4 py-2.5">
          {/* Attach button */}
          <button
            type="button"
            className="p-1 text-discord-muted hover:text-discord-text transition-colors mr-2"
            title="Attach file (not implemented)"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>

          <input
            ref={inputRef}
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`Message #${currentRoom}`}
            className="flex-1 bg-transparent text-discord-text placeholder-discord-muted
                     focus:outline-none"
          />

          {/* Emoji button */}
          <button
            type="button"
            className="p-1 text-discord-muted hover:text-discord-text transition-colors ml-2"
            title="Emoji (not implemented)"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </button>
        </div>
      </form>

      <p className="text-xs text-discord-muted mt-2 text-center">
        Logged in as <span className="text-discord-text">{session?.nickname}</span>
        {' | '}
        Type <span className="text-discord-link">/help</span> for commands
      </p>
    </div>
  );
}
