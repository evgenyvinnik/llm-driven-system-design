import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore, useWorkspaceStore, useChannelStore, useUIStore } from '../stores';
import { channelApi, authApi } from '../services/api';
import type { Channel, DMChannel } from '../types';

interface SidebarProps {
  currentChannelId?: string;
}

export function Sidebar({ currentChannelId }: SidebarProps) {
  const [isCreatingChannel, setIsCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState('');

  const { user, setUser } = useAuthStore();
  const { currentWorkspace, workspaces } = useWorkspaceStore();
  const { channels, dms, setChannels } = useChannelStore();
  const { isSearchOpen, setSearchOpen, setSearchQuery } = useUIStore();
  const navigate = useNavigate();

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChannelName.trim()) return;

    try {
      const channel = await channelApi.create(newChannelName, undefined, undefined, isPrivate);
      setChannels([...channels, channel]);
      setIsCreatingChannel(false);
      setNewChannelName('');
      setIsPrivate(false);
      navigate({
        to: '/workspace/$workspaceId/channel/$channelId',
        params: { workspaceId: currentWorkspace!.id, channelId: channel.id },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create channel');
    }
  };

  const handleLogout = async () => {
    try {
      await authApi.logout();
      setUser(null);
      navigate({ to: '/login' });
    } catch (err) {
      console.error('Logout failed:', err);
    }
  };

  const handleSearchClick = () => {
    setSearchOpen(true);
    setSearchQuery('');
  };

  const getDMDisplayName = (dm: DMChannel) => {
    if (!dm.other_members || dm.other_members.length === 0) {
      return 'Unknown';
    }
    if (dm.other_members.length === 1) {
      return dm.other_members[0].display_name || dm.other_members[0].username;
    }
    return dm.other_members.map((m) => m.display_name || m.username).join(', ');
  };

  return (
    <div className="sidebar w-64 bg-slack-sidebar text-white flex flex-col h-full overflow-hidden">
      {/* Workspace header */}
      <div className="p-4 border-b border-white/10">
        <div className="flex items-center justify-between">
          <div className="font-bold text-lg truncate">{currentWorkspace?.name || 'Workspace'}</div>
          <div className="dropdown relative">
            <button className="p-1 hover:bg-white/10 rounded">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
        </div>
        <div className="text-sm text-white/60 truncate">{user?.display_name}</div>
      </div>

      {/* Search */}
      <div className="p-3">
        <button
          onClick={handleSearchClick}
          className="w-full flex items-center gap-2 px-3 py-1.5 bg-white/10 rounded text-white/60 hover:bg-white/20 text-sm"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          Search messages
        </button>
      </div>

      {/* Channels */}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="mb-4">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-sm font-medium text-white/60">Channels</span>
            <button
              onClick={() => setIsCreatingChannel(true)}
              className="p-1 hover:bg-white/10 rounded text-white/60 hover:text-white"
              title="Create channel"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>

          {isCreatingChannel && (
            <form onSubmit={handleCreateChannel} className="px-2 py-2 bg-white/5 rounded mb-2">
              <input
                type="text"
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                placeholder="channel-name"
                className="w-full px-2 py-1 bg-white/10 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-white/30"
                autoFocus
              />
              <div className="flex items-center gap-2 mt-2">
                <label className="flex items-center gap-1 text-xs text-white/60">
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(e) => setIsPrivate(e.target.checked)}
                    className="rounded"
                  />
                  Private
                </label>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => setIsCreatingChannel(false)}
                  className="text-xs text-white/60 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="text-xs bg-slack-green px-2 py-1 rounded hover:bg-opacity-90"
                >
                  Create
                </button>
              </div>
              {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
            </form>
          )}

          {channels.map((channel) => (
            <Link
              key={channel.id}
              to="/workspace/$workspaceId/channel/$channelId"
              params={{ workspaceId: currentWorkspace!.id, channelId: channel.id }}
              className={`flex items-center gap-2 px-2 py-1 rounded text-sm hover:bg-white/10 ${
                currentChannelId === channel.id ? 'bg-slack-sidebar-active text-white' : 'text-white/80'
              }`}
            >
              <span className="text-white/60">{channel.is_private ? '🔒' : '#'}</span>
              <span className="truncate flex-1">{channel.name}</span>
              {channel.unread_count > 0 && (
                <span className="bg-slack-red text-white text-xs px-1.5 rounded-full">
                  {channel.unread_count}
                </span>
              )}
            </Link>
          ))}
        </div>

        {/* Direct Messages */}
        <div className="mb-4">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-sm font-medium text-white/60">Direct Messages</span>
            <button
              className="p-1 hover:bg-white/10 rounded text-white/60 hover:text-white"
              title="New message"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>

          {dms.map((dm) => (
            <Link
              key={dm.id}
              to="/workspace/$workspaceId/channel/$channelId"
              params={{ workspaceId: currentWorkspace!.id, channelId: dm.id }}
              className={`flex items-center gap-2 px-2 py-1 rounded text-sm hover:bg-white/10 ${
                currentChannelId === dm.id ? 'bg-slack-sidebar-active text-white' : 'text-white/80'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-green-500" />
              <span className="truncate">{getDMDisplayName(dm)}</span>
            </Link>
          ))}
        </div>
      </div>

      {/* User menu */}
      <div className="p-3 border-t border-white/10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-slack-green flex items-center justify-center text-sm font-medium">
            {user?.display_name?.[0]?.toUpperCase() || user?.username?.[0]?.toUpperCase() || '?'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{user?.display_name}</div>
            <div className="text-xs text-white/60 truncate">@{user?.username}</div>
          </div>
          <button
            onClick={handleLogout}
            className="p-1 hover:bg-white/10 rounded text-white/60 hover:text-white"
            title="Logout"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
