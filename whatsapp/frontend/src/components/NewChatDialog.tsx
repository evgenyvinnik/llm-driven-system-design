import { useState, useEffect } from 'react';
import { authApi, conversationsApi } from '../services/api';
import { useChatStore } from '../stores/chatStore';
import { User } from '../types';

interface NewChatDialogProps {
  onClose: () => void;
  onChatCreated: (conversationId: string) => void;
}

export function NewChatDialog({ onClose, onChatCreated }: NewChatDialogProps) {
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<User[]>([]);
  const [groupName, setGroupName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const { addConversation } = useChatStore();

  useEffect(() => {
    const searchUsers = async () => {
      setIsSearching(true);
      try {
        const { users } = await authApi.searchUsers(searchQuery);
        setUsers(users);
      } catch (error) {
        console.error('Failed to search users:', error);
      } finally {
        setIsSearching(false);
      }
    };

    const debounce = setTimeout(searchUsers, 300);
    return () => clearTimeout(debounce);
  }, [searchQuery]);

  const handleSelectUser = async (selectedUser: User) => {
    if (mode === 'direct') {
      // Create direct conversation immediately
      setIsLoading(true);
      try {
        const { conversation } = await conversationsApi.createDirect(selectedUser.id);
        addConversation(conversation);
        onChatCreated(conversation.id);
      } catch (error) {
        console.error('Failed to create conversation:', error);
        alert('Failed to create conversation');
      } finally {
        setIsLoading(false);
      }
    } else {
      // Add to selected users for group
      if (!selectedUsers.find((u) => u.id === selectedUser.id)) {
        setSelectedUsers([...selectedUsers, selectedUser]);
      }
    }
  };

  const handleRemoveUser = (userId: string) => {
    setSelectedUsers(selectedUsers.filter((u) => u.id !== userId));
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim() || selectedUsers.length === 0) return;

    setIsLoading(true);
    try {
      const { conversation } = await conversationsApi.createGroup(
        groupName,
        selectedUsers.map((u) => u.id)
      );
      addConversation(conversation);
      onChatCreated(conversation.id);
    } catch (error) {
      console.error('Failed to create group:', error);
      alert('Failed to create group');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">New Chat</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Mode toggle */}
        <div className="p-4 border-b">
          <div className="flex space-x-2">
            <button
              onClick={() => {
                setMode('direct');
                setSelectedUsers([]);
              }}
              className={`flex-1 py-2 px-4 rounded-lg ${
                mode === 'direct'
                  ? 'bg-whatsapp-green text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Direct Message
            </button>
            <button
              onClick={() => setMode('group')}
              className={`flex-1 py-2 px-4 rounded-lg ${
                mode === 'group'
                  ? 'bg-whatsapp-green text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              New Group
            </button>
          </div>
        </div>

        {/* Group name input */}
        {mode === 'group' && (
          <div className="p-4 border-b">
            <input
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Group name"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-green"
            />
          </div>
        )}

        {/* Selected users */}
        {mode === 'group' && selectedUsers.length > 0 && (
          <div className="p-4 border-b">
            <div className="flex flex-wrap gap-2">
              {selectedUsers.map((selectedUser) => (
                <div
                  key={selectedUser.id}
                  className="flex items-center space-x-1 bg-whatsapp-green text-white px-2 py-1 rounded-full text-sm"
                >
                  <span>{selectedUser.display_name}</span>
                  <button
                    onClick={() => handleRemoveUser(selectedUser.id)}
                    className="hover:bg-whatsapp-dark-green rounded-full p-0.5"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Search */}
        <div className="p-4 border-b">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search users..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-green"
          />
        </div>

        {/* User list */}
        <div className="flex-1 overflow-y-auto">
          {isSearching ? (
            <div className="p-4 text-center text-gray-500">Searching...</div>
          ) : users.length === 0 ? (
            <div className="p-4 text-center text-gray-500">
              {searchQuery ? 'No users found' : 'Type to search for users'}
            </div>
          ) : (
            users.map((user) => {
              const isSelected = selectedUsers.some((u) => u.id === user.id);

              return (
                <div
                  key={user.id}
                  onClick={() => !isSelected && !isLoading && handleSelectUser(user)}
                  className={`flex items-center p-3 border-b cursor-pointer ${
                    isSelected
                      ? 'bg-gray-100 cursor-default'
                      : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="w-10 h-10 bg-whatsapp-dark-green rounded-full flex items-center justify-center text-white font-bold">
                    {user.display_name.charAt(0).toUpperCase()}
                  </div>
                  <div className="ml-3 flex-1">
                    <div className="font-medium">{user.display_name}</div>
                    <div className="text-sm text-gray-500">@{user.username}</div>
                  </div>
                  {isSelected && (
                    <svg className="w-5 h-5 text-whatsapp-green" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Create group button */}
        {mode === 'group' && (
          <div className="p-4 border-t">
            <button
              onClick={handleCreateGroup}
              disabled={!groupName.trim() || selectedUsers.length === 0 || isLoading}
              className="w-full py-2 px-4 bg-whatsapp-green text-white rounded-lg hover:bg-whatsapp-dark-green disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Creating...' : 'Create Group'}
            </button>
          </div>
        )}

        {isLoading && mode === 'direct' && (
          <div className="absolute inset-0 bg-white bg-opacity-75 flex items-center justify-center">
            <div className="text-gray-500">Creating conversation...</div>
          </div>
        )}
      </div>
    </div>
  );
}
