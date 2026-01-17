/**
 * Chat Layout Component
 *
 * Main layout container for the messaging interface.
 * Manages the two-column layout with conversation list and chat view.
 * Handles responsive design for mobile/desktop viewing.
 * Initializes the WebSocket connection for real-time messaging.
 */

import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useWebSocket } from '../hooks/useWebSocket';
import { ConversationList } from './ConversationList';
import { ChatView } from './ChatView';
import { NewChatDialog } from './NewChatDialog';

/**
 * Main chat layout with sidebar and message area.
 * Responsive design shows sidebar on mobile when no chat selected.
 */
export function ChatLayout() {
  const { logout } = useAuthStore();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [showNewChatDialog, setShowNewChatDialog] = useState(false);

  // Initialize WebSocket connection
  useWebSocket();

  const handleSelectConversation = (conversationId: string) => {
    setSelectedConversationId(conversationId);
  };

  const handleChatCreated = (conversationId: string) => {
    setShowNewChatDialog(false);
    setSelectedConversationId(conversationId);
  };

  const handleLogout = async () => {
    await logout();
  };

  return (
    <div className="h-screen flex">
      {/* Sidebar - always visible on desktop, hidden on mobile when chat selected */}
      <div
        className={`w-full md:w-96 flex-shrink-0 border-r border-gray-200 ${
          selectedConversationId ? 'hidden md:block' : 'block'
        }`}
      >
        <div className="h-full flex flex-col">
          <ConversationList
            onSelectConversation={handleSelectConversation}
            onNewChat={() => setShowNewChatDialog(true)}
          />

          {/* Logout button */}
          <div className="p-4 border-t bg-gray-50">
            <button
              onClick={handleLogout}
              className="w-full py-2 px-4 text-gray-700 hover:bg-gray-200 rounded-lg transition-colors flex items-center justify-center space-x-2"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                />
              </svg>
              <span>Logout</span>
            </button>
          </div>
        </div>
      </div>

      {/* Chat area */}
      <div
        className={`flex-1 ${
          selectedConversationId ? 'block' : 'hidden md:block'
        }`}
      >
        {selectedConversationId ? (
          <ChatView
            conversationId={selectedConversationId}
            onBack={() => setSelectedConversationId(null)}
          />
        ) : (
          <div className="h-full flex items-center justify-center bg-gray-100">
            <div className="text-center text-gray-500">
              <svg
                className="w-24 h-24 mx-auto mb-4 text-gray-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
              <h2 className="text-xl font-semibold mb-2">WhatsApp Web</h2>
              <p>Select a conversation or start a new chat</p>
            </div>
          </div>
        )}
      </div>

      {/* New chat dialog */}
      {showNewChatDialog && (
        <NewChatDialog
          onClose={() => setShowNewChatDialog(false)}
          onChatCreated={handleChatCreated}
        />
      )}
    </div>
  );
}
