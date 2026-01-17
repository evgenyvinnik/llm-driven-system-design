import { useState, useEffect } from 'react';
import { ConversationItem } from './ConversationItem';
import { useChatStore } from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';
import type { User } from '@/types';

/**
 * Sidebar component displaying the list of user's conversations.
 * Includes user search for starting new conversations, current user info,
 * and logout functionality. Supports both viewing existing conversations
 * and creating new direct message threads.
 *
 * @returns React component for the conversation list sidebar
 */
export function ConversationList() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showNewConversation, setShowNewConversation] = useState(false);

  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const conversations = useChatStore((state) => state.conversations);
  const currentConversationId = useChatStore((state) => state.currentConversationId);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const createDirectConversation = useChatStore((state) => state.createDirectConversation);
  const isLoadingConversations = useChatStore((state) => state.isLoadingConversations);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    const searchUsers = async () => {
      if (searchQuery.length < 2) {
        setSearchResults([]);
        return;
      }

      setIsSearching(true);
      try {
        const response = await api.searchUsers(searchQuery);
        setSearchResults(response.users);
      } catch (error) {
        console.error('Search failed:', error);
      } finally {
        setIsSearching(false);
      }
    };

    const debounce = setTimeout(searchUsers, 300);
    return () => clearTimeout(debounce);
  }, [searchQuery]);

  /**
   * Creates a new direct conversation with the selected user and selects it.
   * Closes the new conversation panel and clears search state.
   *
   * @param targetUser - The user to start a conversation with
   */
  const handleStartConversation = async (targetUser: User) => {
    try {
      const conversation = await createDirectConversation(targetUser.id);
      selectConversation(conversation.id);
      setShowNewConversation(false);
      setSearchQuery('');
      setSearchResults([]);
    } catch (error) {
      console.error('Failed to create conversation:', error);
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 border-r border-gray-200">
      {/* Header */}
      <div className="px-4 py-3 bg-white border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-bold text-gray-900">Messages</h1>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => setShowNewConversation(!showNewConversation)}
              className="p-2 rounded-full hover:bg-gray-100 transition-colors"
              title="New conversation"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5 text-imessage-blue"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            <button
              onClick={logout}
              className="p-2 rounded-full hover:bg-gray-100 transition-colors"
              title="Logout"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5 text-gray-500"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M3 3a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1V4a1 1 0 00-1-1H3zm11 4.414l-4.293 4.293a1 1 0 01-1.414-1.414L12.586 6H9a1 1 0 010-2h5a1 1 0 011 1v5a1 1 0 11-2 0V7.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* User info */}
        <div className="flex items-center space-x-2 text-sm text-gray-500">
          <div className="w-6 h-6 rounded-full bg-imessage-blue flex items-center justify-center text-white text-xs">
            {user?.display_name?.charAt(0) || user?.username?.charAt(0) || '?'}
          </div>
          <span>{user?.display_name || user?.username}</span>
        </div>
      </div>

      {/* New Conversation Panel */}
      {showNewConversation && (
        <div className="px-4 py-3 bg-white border-b border-gray-200">
          <input
            type="text"
            placeholder="Search users..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2 bg-gray-100 rounded-full focus:outline-none focus:ring-2 focus:ring-imessage-blue"
          />

          {isSearching && (
            <div className="mt-2 text-center text-gray-500">Searching...</div>
          )}

          {searchResults.length > 0 && (
            <div className="mt-2 max-h-48 overflow-y-auto">
              {searchResults.map((searchUser) => (
                <div
                  key={searchUser.id}
                  onClick={() => handleStartConversation(searchUser)}
                  className="flex items-center px-3 py-2 cursor-pointer hover:bg-gray-100 rounded-lg"
                >
                  <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-sm font-medium text-gray-600">
                    {searchUser.avatar_url ? (
                      <img
                        src={searchUser.avatar_url}
                        alt={searchUser.display_name}
                        className="w-full h-full rounded-full object-cover"
                      />
                    ) : (
                      searchUser.display_name?.charAt(0) || searchUser.username.charAt(0)
                    )}
                  </div>
                  <div className="ml-3">
                    <p className="font-medium text-gray-900">
                      {searchUser.display_name || searchUser.username}
                    </p>
                    <p className="text-sm text-gray-500">@{searchUser.username}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {searchQuery.length >= 2 && searchResults.length === 0 && !isSearching && (
            <div className="mt-2 text-center text-gray-500">No users found</div>
          )}
        </div>
      )}

      {/* Conversations List */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {isLoadingConversations ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-imessage-blue"></div>
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-500">
            <p>No conversations yet</p>
            <p className="text-sm">Click + to start a new conversation</p>
          </div>
        ) : (
          conversations.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              isSelected={conversation.id === currentConversationId}
              onClick={() => selectConversation(conversation.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
