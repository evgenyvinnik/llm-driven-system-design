/**
 * Chat App Component
 *
 * Main application shell for Baby Discord. Renders either the login form
 * (when not authenticated) or the full chat interface (when logged in).
 * The chat interface consists of three columns: server list, channel sidebar,
 * and main chat area with header, messages, and input.
 */

import { useChatStore } from '../stores/chatStore';
import { LoginForm } from './LoginForm';
import { ServerList } from './ServerList';
import { ChannelSidebar } from './ChannelSidebar';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';

/**
 * Root component for the Baby Discord chat application.
 * Conditionally renders LoginForm or the main chat layout
 * based on authentication state.
 *
 * @returns Login form or full chat interface
 */
export function ChatApp() {
  const { session } = useChatStore();

  if (!session) {
    return <LoginForm />;
  }

  return (
    <div className="flex h-screen bg-discord-channel">
      {/* Server list */}
      <ServerList />

      {/* Channel sidebar */}
      <ChannelSidebar />

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Channel header */}
        <ChannelHeader />

        {/* Messages */}
        <MessageList />

        {/* Input */}
        <MessageInput />
      </div>
    </div>
  );
}

/**
 * Renders the channel header bar at the top of the chat area.
 * Shows the current room name with hash icon, welcome text,
 * and action buttons (members list placeholder).
 *
 * @returns Header bar with room info and actions
 */
function ChannelHeader() {
  const { currentRoom } = useChatStore();

  return (
    <div className="h-12 flex items-center px-4 shadow-md border-b border-discord-dark flex-shrink-0">
      {currentRoom ? (
        <>
          <span className="text-discord-muted text-xl mr-2">#</span>
          <h3 className="font-semibold text-white">{currentRoom}</h3>
          <div className="h-6 w-px bg-discord-sidebar mx-4" />
          <p className="text-discord-muted text-sm truncate">
            Welcome to the {currentRoom} channel
          </p>
        </>
      ) : (
        <h3 className="font-semibold text-white">Baby Discord</h3>
      )}

      {/* Header actions */}
      <div className="ml-auto flex items-center gap-4">
        <button
          className="text-discord-muted hover:text-discord-text transition-colors"
          title="Members"
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
              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
