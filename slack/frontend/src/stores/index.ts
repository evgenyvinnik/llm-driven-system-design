import { create } from 'zustand';
import type { User, Workspace, Channel, DMChannel, Message, Thread, PresenceUpdate } from '../types';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  setUser: (user) => set({ user }),
  setLoading: (isLoading) => set({ isLoading }),
}));

interface WorkspaceState {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  members: Record<string, User[]>;
  setWorkspaces: (workspaces: Workspace[]) => void;
  setCurrentWorkspace: (workspace: Workspace | null) => void;
  setMembers: (workspaceId: string, members: User[]) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspaces: [],
  currentWorkspace: null,
  members: {},
  setWorkspaces: (workspaces) => set({ workspaces }),
  setCurrentWorkspace: (currentWorkspace) => set({ currentWorkspace }),
  setMembers: (workspaceId, members) =>
    set((state) => ({ members: { ...state.members, [workspaceId]: members } })),
}));

interface ChannelState {
  channels: Channel[];
  dms: DMChannel[];
  currentChannel: Channel | DMChannel | null;
  setChannels: (channels: Channel[]) => void;
  setDMs: (dms: DMChannel[]) => void;
  setCurrentChannel: (channel: Channel | DMChannel | null) => void;
  updateChannel: (channel: Channel) => void;
  updateUnreadCount: (channelId: string, count: number) => void;
}

export const useChannelStore = create<ChannelState>((set) => ({
  channels: [],
  dms: [],
  currentChannel: null,
  setChannels: (channels) => set({ channels }),
  setDMs: (dms) => set({ dms }),
  setCurrentChannel: (currentChannel) => set({ currentChannel }),
  updateChannel: (channel) =>
    set((state) => ({
      channels: state.channels.map((c) => (c.id === channel.id ? { ...c, ...channel } : c)),
    })),
  updateUnreadCount: (channelId, count) =>
    set((state) => ({
      channels: state.channels.map((c) => (c.id === channelId ? { ...c, unread_count: count } : c)),
    })),
}));

interface MessageState {
  messages: Record<string, Message[]>;
  activeThread: Thread | null;
  typingUsers: Record<string, string[]>;
  setMessages: (channelId: string, messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (message: Message) => void;
  deleteMessage: (messageId: number, channelId: string) => void;
  setActiveThread: (thread: Thread | null) => void;
  addThreadReply: (reply: Message) => void;
  setTypingUsers: (channelId: string, users: string[]) => void;
  addReaction: (messageId: number, channelId: string, userId: string, emoji: string) => void;
  removeReaction: (messageId: number, channelId: string, userId: string, emoji: string) => void;
}

export const useMessageStore = create<MessageState>((set) => ({
  messages: {},
  activeThread: null,
  typingUsers: {},
  setMessages: (channelId, messages) =>
    set((state) => ({ messages: { ...state.messages, [channelId]: messages } })),
  addMessage: (message) =>
    set((state) => {
      const channelMessages = state.messages[message.channel_id] || [];
      // Check if message already exists
      if (channelMessages.some((m) => m.id === message.id)) {
        return state;
      }
      return {
        messages: {
          ...state.messages,
          [message.channel_id]: [...channelMessages, message],
        },
      };
    }),
  updateMessage: (message) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [message.channel_id]: (state.messages[message.channel_id] || []).map((m) =>
          m.id === message.id ? message : m
        ),
      },
    })),
  deleteMessage: (messageId, channelId) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [channelId]: (state.messages[channelId] || []).filter((m) => m.id !== messageId),
      },
    })),
  setActiveThread: (activeThread) => set({ activeThread }),
  addThreadReply: (reply) =>
    set((state) => {
      if (!state.activeThread) return state;
      // Check if reply already exists
      if (state.activeThread.replies.some((r) => r.id === reply.id)) {
        return state;
      }
      return {
        activeThread: {
          ...state.activeThread,
          replies: [...state.activeThread.replies, reply],
        },
      };
    }),
  setTypingUsers: (channelId, users) =>
    set((state) => ({ typingUsers: { ...state.typingUsers, [channelId]: users } })),
  addReaction: (messageId, channelId, userId, emoji) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [channelId]: (state.messages[channelId] || []).map((m) => {
          if (m.id !== messageId) return m;
          const reactions = m.reactions || [];
          return { ...m, reactions: [...reactions, { emoji, user_id: userId }] };
        }),
      },
    })),
  removeReaction: (messageId, channelId, userId, emoji) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [channelId]: (state.messages[channelId] || []).map((m) => {
          if (m.id !== messageId) return m;
          const reactions = (m.reactions || []).filter(
            (r) => !(r.emoji === emoji && r.user_id === userId)
          );
          return { ...m, reactions };
        }),
      },
    })),
}));

interface PresenceState {
  onlineUsers: Record<string, boolean>;
  setOnline: (userId: string) => void;
  setOffline: (userId: string) => void;
  updatePresence: (update: PresenceUpdate) => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  onlineUsers: {},
  setOnline: (userId) =>
    set((state) => ({ onlineUsers: { ...state.onlineUsers, [userId]: true } })),
  setOffline: (userId) =>
    set((state) => ({ onlineUsers: { ...state.onlineUsers, [userId]: false } })),
  updatePresence: (update) =>
    set((state) => ({
      onlineUsers: {
        ...state.onlineUsers,
        [update.userId]: update.status !== 'offline',
      },
    })),
}));

interface UIState {
  isSidebarOpen: boolean;
  isThreadPanelOpen: boolean;
  isSearchOpen: boolean;
  searchQuery: string;
  toggleSidebar: () => void;
  setThreadPanelOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  isSidebarOpen: true,
  isThreadPanelOpen: false,
  isSearchOpen: false,
  searchQuery: '',
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setThreadPanelOpen: (isThreadPanelOpen) => set({ isThreadPanelOpen }),
  setSearchOpen: (isSearchOpen) => set({ isSearchOpen }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
}));
