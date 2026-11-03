import { create } from 'zustand';
import type {
  Organization,
  Team,
  Channel,
  Message,
  ChannelMember,
  DeletedMessage,
} from '../types';
import {
  ApiError,
  orgApi,
  teamApi,
  channelApi,
  messageApi,
  presenceApi,
  reactionApi,
} from '../services/api';

interface ChatState {
  // Data
  organizations: Organization[];
  teams: Team[];
  channels: Channel[];
  messages: Message[];
  threadMessages: Message[];
  channelMembers: ChannelMember[];
  hasMoreMessages: boolean;
  loadingOlder: boolean;
  /** Which org/team the `teams`/`channels` arrays belong to (null until loaded). */
  teamsLoadedFor: string | null;
  channelsLoadedFor: string | null;

  // Selection
  currentOrgId: string | null;
  currentTeamId: string | null;
  currentChannelId: string | null;
  threadParentId: string | null;

  // UI state
  loading: boolean;
  channelError: string | null;
  sseConnection: EventSource | null;
  showMemberList: boolean;

  // Actions
  loadOrganizations: () => Promise<void>;
  loadTeams: (orgId: string) => Promise<void>;
  loadChannels: (teamId: string) => Promise<void>;
  loadMessages: (channelId: string) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  loadThread: (messageId: string) => Promise<void>;
  loadChannelMembers: (channelId: string) => Promise<void>;
  sendMessage: (content: string, fileIds?: string[]) => Promise<void>;
  sendThreadReply: (content: string, fileIds?: string[]) => Promise<void>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  toggleReaction: (messageId: string, emoji: string, username: string) => Promise<void>;
  markChannelRead: (channelId: string) => void;
  setCurrentChannel: (channelId: string) => void;
  openThread: (messageId: string) => void;
  closeThread: () => void;
  toggleMemberList: () => void;
  connectSSE: (channelId: string) => void;
  disconnectSSE: () => void;
  addMessageFromSSE: (message: Message) => void;
  startPresenceHeartbeat: () => () => void;
  reset: () => void;
}

// Request counters: a response is applied only if no newer request of the same
// kind was issued meanwhile. Without them, switching org/team/channel quickly
// let a slow response for the previous selection overwrite the current one.
let teamsRequest = 0;
let channelsRequest = 0;
let messagesRequest = 0;
const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Our own sends and deletes are applied from the HTTP response and then echoed
// back over SSE (in either order). These sets make both paths idempotent, so a
// reply is counted once and a deletion decrements once.
const appliedDeletions = new Set<string>();
const countedReplies = new Set<string>();

const initialState = {
  organizations: [] as Organization[],
  teams: [] as Team[],
  channels: [] as Channel[],
  messages: [] as Message[],
  threadMessages: [] as Message[],
  channelMembers: [] as ChannelMember[],
  hasMoreMessages: false,
  loadingOlder: false,
  teamsLoadedFor: null as string | null,
  channelsLoadedFor: null as string | null,
  currentOrgId: null as string | null,
  currentTeamId: null as string | null,
  currentChannelId: null as string | null,
  threadParentId: null as string | null,
  loading: false,
  channelError: null as string | null,
  sseConnection: null as EventSource | null,
  showMemberList: false,
};

/** Applies `fn` to a message wherever it is shown: the channel list and the open thread. */
function mapMessage(
  state: Pick<ChatState, 'messages' | 'threadMessages'>,
  id: string,
  fn: (m: Message) => Message,
) {
  return {
    messages: state.messages.map((m) => (m.id === id ? fn(m) : m)),
    threadMessages: state.threadMessages.map((m) => (m.id === id ? fn(m) : m)),
  };
}

function withReaction(m: Message, emoji: string, username: string, added: boolean): Message {
  const existing = m.reactions.find((r) => r.emoji === emoji);
  // Idempotent: the local optimistic update and the SSE echo both land here.
  if (added) {
    if (existing?.users.includes(username)) return m;
    if (existing) {
      return {
        ...m,
        reactions: m.reactions.map((r) =>
          r.emoji === emoji ? { ...r, count: r.count + 1, users: [...r.users, username] } : r,
        ),
      };
    }
    return { ...m, reactions: [...m.reactions, { emoji, count: 1, users: [username] }] };
  }
  if (!existing?.users.includes(username)) return m;
  return {
    ...m,
    reactions: m.reactions
      .map((r) =>
        r.emoji === emoji
          ? { ...r, count: r.count - 1, users: r.users.filter((u) => u !== username) }
          : r,
      )
      .filter((r) => r.count > 0),
  };
}

const tombstone = (m: Message): Message => ({
  ...m,
  content: '',
  deleted_at: m.deleted_at ?? new Date().toISOString(),
  reactions: [],
  attachments: [],
});

/** Chat state managing org/team/channel hierarchy, messages, threads, SSE connection, and presence. */
export const useChatStore = create<ChatState>((set, get) => {
  /** Removes or tombstones a deleted message (a root with replies stays as a tombstone). */
  const applyDeletion = (d: DeletedMessage) => {
    if (appliedDeletions.has(d.id)) return;
    appliedDeletions.add(d.id);
    set((state) => {
      if (d.parent_message_id) {
        return {
          messages: state.messages.map((m) =>
            m.id === d.parent_message_id
              ? { ...m, reply_count: Math.max(0, (m.reply_count || 0) - 1) }
              : m,
          ),
          threadMessages: state.threadMessages.filter((m) => m.id !== d.id),
        };
      }
      return {
        messages: state.messages.flatMap((m) =>
          m.id !== d.id ? [m] : (m.reply_count || 0) > 0 ? [tombstone(m)] : [],
        ),
        threadMessages: state.threadMessages.map((m) => (m.id === d.id ? tombstone(m) : m)),
      };
    });
  };

  /** Sends a message, retrying once with the same id if the request may not have arrived. */
  const sendWithRetry = async (input: Parameters<typeof messageApi.send>[0]) => {
    try {
      return await messageApi.send(input);
    } catch (err) {
      if (err instanceof ApiError) throw err; // the server answered; don't retry
      return messageApi.send(input); // same id, so the server dedupes if the first one landed
    }
  };

  return {
    ...initialState,

    loadOrganizations: async () => {
      try {
        const { organizations } = await orgApi.list();
        set({ organizations });
      } catch (err) {
        console.error('Failed to load organizations:', err);
      }
    },

    loadTeams: async (orgId: string) => {
      const req = ++teamsRequest;
      if (get().currentOrgId !== orgId) {
        set({ currentOrgId: orgId, teams: [], teamsLoadedFor: null });
      }
      try {
        const { teams } = await teamApi.list(orgId);
        if (req !== teamsRequest) return;
        set({ teams, teamsLoadedFor: orgId });
      } catch (err) {
        if (req !== teamsRequest) return;
        console.error('Failed to load teams:', err);
        set({ teams: [], teamsLoadedFor: orgId });
      }
    },

    loadChannels: async (teamId: string) => {
      const req = ++channelsRequest;
      if (get().currentTeamId !== teamId) {
        set({ currentTeamId: teamId, channels: [], channelsLoadedFor: null });
      }
      try {
        const { channels } = await channelApi.list(teamId);
        if (req !== channelsRequest) return;
        // The open channel is being read right now, whatever the count says.
        const open = get().currentChannelId;
        set({
          channels: channels.map((c) => (c.id === open ? { ...c, unread_count: 0 } : c)),
          channelsLoadedFor: teamId,
        });
      } catch (err) {
        if (req !== channelsRequest) return;
        console.error('Failed to load channels:', err);
        set({ channels: [], channelsLoadedFor: teamId });
      }
    },

    loadMessages: async (channelId: string) => {
      const req = ++messagesRequest;
      set({ loading: true });
      try {
        const { messages, hasMore } = await messageApi.list(channelId);
        if (req !== messagesRequest || get().currentChannelId !== channelId) return;
        set((state) => {
          // Keep anything SSE delivered while the page was in flight.
          const page = [...messages].reverse();
          const ids = new Set(page.map((m) => m.id));
          return {
            messages: [...page, ...state.messages.filter((m) => !ids.has(m.id))],
            hasMoreMessages: hasMore,
            loading: false,
            channelError: null,
          };
        });
        get().markChannelRead(channelId);
      } catch (err) {
        if (req !== messagesRequest) return;
        console.error('Failed to load messages:', err);
        set({
          loading: false,
          channelError:
            err instanceof ApiError && err.status === 404
              ? 'This channel does not exist or you do not have access to it.'
              : 'Could not load messages.',
        });
      }
    },

    loadMoreMessages: async () => {
      const { messages, currentChannelId, hasMoreMessages, loadingOlder } = get();
      if (!currentChannelId || !hasMoreMessages || loadingOlder || messages.length === 0) return;

      set({ loadingOlder: true });
      try {
        // The cursor is the oldest loaded message's id, not its timestamp:
        // JSON timestamps lose Postgres's microseconds, which skipped messages.
        const { messages: older, hasMore } = await messageApi.list(currentChannelId, messages[0].id);
        if (get().currentChannelId !== currentChannelId) return;
        set((state) => {
          const ids = new Set(state.messages.map((m) => m.id));
          return {
            messages: [...[...older].reverse().filter((m) => !ids.has(m.id)), ...state.messages],
            hasMoreMessages: hasMore,
            loadingOlder: false,
          };
        });
      } catch (err) {
        console.error('Failed to load more messages:', err);
        set({ loadingOlder: false });
      }
    },

    loadThread: async (messageId: string) => {
      try {
        const { messages } = await messageApi.getThread(messageId);
        if (get().threadParentId !== messageId) return;
        set({ threadMessages: messages });
      } catch (err) {
        console.error('Failed to load thread:', err);
      }
    },

    loadChannelMembers: async (channelId: string) => {
      try {
        const { members } = await presenceApi.getChannelPresence(channelId);
        if (get().currentChannelId !== channelId) return;
        set({ channelMembers: members });
      } catch (err) {
        console.error('Failed to load channel members:', err);
      }
    },

    sendMessage: async (content: string, fileIds?: string[]) => {
      const { currentChannelId } = get();
      if (!currentChannelId) return;
      const { message } = await sendWithRetry({
        id: crypto.randomUUID(),
        channelId: currentChannelId,
        content,
        fileIds,
      });
      // Show it from the response, not only from SSE: if the stream is
      // reconnecting the sender would otherwise never see their own message.
      get().addMessageFromSSE(message);
    },

    sendThreadReply: async (content: string, fileIds?: string[]) => {
      const { currentChannelId, threadParentId } = get();
      if (!currentChannelId || !threadParentId) return;

      const { message } = await sendWithRetry({
        id: crypto.randomUUID(),
        channelId: currentChannelId,
        content,
        parentMessageId: threadParentId,
        fileIds,
      });
      // Same path as the SSE echo, which may arrive before or after this.
      get().addMessageFromSSE(message);
    },

    editMessage: async (messageId: string, content: string) => {
      const { message } = await messageApi.edit(messageId, content);
      set((state) => mapMessage(state, messageId, (m) => ({ ...m, ...message })));
    },

    deleteMessage: async (messageId: string) => {
      const target =
        get().messages.find((m) => m.id === messageId) ??
        get().threadMessages.find((m) => m.id === messageId);
      await messageApi.delete(messageId);
      if (target) {
        applyDeletion({
          id: messageId,
          channel_id: target.channel_id,
          parent_message_id: target.parent_message_id ?? null,
        });
      }
    },

    toggleReaction: async (messageId: string, emoji: string, username: string) => {
      const target =
        get().messages.find((m) => m.id === messageId) ??
        get().threadMessages.find((m) => m.id === messageId);
      const reacted = !!target?.reactions.find((r) => r.emoji === emoji)?.users.includes(username);
      // Clicking a reaction you already gave removes it (it used to re-add it,
      // and every client counted that as one more).
      if (reacted) await reactionApi.remove(messageId, emoji);
      else await reactionApi.add(messageId, emoji);
      set((state) => mapMessage(state, messageId, (m) => withReaction(m, emoji, username, !reacted)));
    },

    markChannelRead: (channelId: string) => {
      set((state) => ({
        channels: state.channels.map((c) => (c.id === channelId ? { ...c, unread_count: 0 } : c)),
      }));
      // Debounced per channel so a burst of incoming messages costs one request.
      const pending = readTimers.get(channelId);
      if (pending) clearTimeout(pending);
      readTimers.set(
        channelId,
        setTimeout(() => {
          readTimers.delete(channelId);
          channelApi.markRead(channelId).catch(() => {});
        }, 750),
      );
    },

    setCurrentChannel: (channelId: string) => {
      const { currentChannelId, sseConnection } = get();
      // Re-entering the same channel only counts as "already here" while the
      // stream is live. The old early-return on the id alone left the channel
      // without SSE after any unmount/remount — including React StrictMode's
      // dev double-mount, which closed the stream immediately on every load,
      // so nothing arrived in real time during development.
      if (currentChannelId === channelId && sseConnection) return;

      get().disconnectSSE();
      set({
        currentChannelId: channelId,
        messages: [],
        hasMoreMessages: false,
        loadingOlder: false,
        threadParentId: null,
        threadMessages: [],
        channelMembers: [],
        channelError: null,
      });
      get().loadMessages(channelId);
      get().loadChannelMembers(channelId);
      get().connectSSE(channelId);
    },

    openThread: (messageId: string) => {
      set({ threadParentId: messageId, threadMessages: [] });
      get().loadThread(messageId);
    },

    closeThread: () => {
      set({ threadParentId: null, threadMessages: [] });
    },

    toggleMemberList: () => {
      set((state) => ({ showMemberList: !state.showMemberList }));
    },

    connectSSE: (channelId: string) => {
      get().disconnectSSE();
      const eventSource = new EventSource(`/api/sse/${channelId}`, {
        withCredentials: true,
      });
      // The server identifies us from the session cookie and echoes the id.
      let selfId: string | null = null;

      eventSource.addEventListener('connected', (event) => {
        selfId = JSON.parse((event as MessageEvent).data).userId;
      });

      eventSource.addEventListener('new_message', (event) => {
        const message = JSON.parse(event.data) as Message;
        get().addMessageFromSSE(message);
        if (message.user_id !== selfId && get().currentChannelId === channelId) {
          get().markChannelRead(channelId);
        }
      });

      eventSource.addEventListener('message_edited', (event) => {
        const edited = JSON.parse(event.data) as Message;
        set((state) => mapMessage(state, edited.id, (m) => ({ ...m, ...edited })));
      });

      eventSource.addEventListener('message_deleted', (event) => {
        applyDeletion(JSON.parse(event.data) as DeletedMessage);
      });

      eventSource.addEventListener('reaction_added', (event) => {
        const data = JSON.parse(event.data);
        set((state) =>
          mapMessage(state, data.messageId, (m) => withReaction(m, data.emoji, data.username, true)),
        );
      });

      eventSource.addEventListener('reaction_removed', (event) => {
        const data = JSON.parse(event.data);
        set((state) =>
          mapMessage(state, data.messageId, (m) => withReaction(m, data.emoji, data.username, false)),
        );
      });

      // Someone lost access to this channel. If it was us, the server has
      // already closed our stream; stop EventSource from retrying and clear
      // what we were shown.
      eventSource.addEventListener('member_removed', (event) => {
        const { userId } = JSON.parse((event as MessageEvent).data);
        if (userId === selfId) {
          eventSource.close();
          set({
            sseConnection: null,
            messages: [],
            threadParentId: null,
            threadMessages: [],
            channelMembers: [],
            hasMoreMessages: false,
            channelError: 'You no longer have access to this channel.',
          });
          const { currentTeamId } = get();
          if (currentTeamId) get().loadChannels(currentTeamId);
        } else {
          get().loadChannelMembers(channelId);
        }
      });

      eventSource.onerror = () => {
        // EventSource retries on its own; a refused stream (404) closes it.
        if (eventSource.readyState === EventSource.CLOSED && get().sseConnection === eventSource) {
          set({ sseConnection: null });
        }
      };

      set({ sseConnection: eventSource });
    },

    disconnectSSE: () => {
      const { sseConnection } = get();
      if (sseConnection) {
        sseConnection.close();
        set({ sseConnection: null });
      }
    },

    addMessageFromSSE: (message: Message) => {
      set((state) => {
        if (message.channel_id !== state.currentChannelId) return state;

        if (message.parent_message_id) {
          // Thread reply: bump the parent's count once, append to the open thread once.
          const firstSeen = !countedReplies.has(message.id);
          countedReplies.add(message.id);
          const messages = firstSeen
            ? state.messages.map((m) =>
                m.id === message.parent_message_id
                  ? { ...m, reply_count: (m.reply_count || 0) + 1 }
                  : m,
              )
            : state.messages;
          const showInThread =
            state.threadParentId === message.parent_message_id &&
            !state.threadMessages.some((m) => m.id === message.id);
          return {
            messages,
            threadMessages: showInThread ? [...state.threadMessages, message] : state.threadMessages,
          };
        }

        // Top-level message (the sender's own response and its SSE echo dedupe here)
        if (state.messages.some((m) => m.id === message.id)) return state;
        return { messages: [...state.messages, message] };
      });
    },

    startPresenceHeartbeat: () => {
      // Every 30 seconds: keep our presence key alive, and refresh the channel
      // list so unread badges for channels we aren't viewing stay current
      // (SSE only streams the open channel).
      const tick = () => {
        presenceApi.heartbeat().catch(() => {});
        const { currentTeamId, channelsLoadedFor } = get();
        if (currentTeamId && channelsLoadedFor === currentTeamId) get().loadChannels(currentTeamId);
      };
      presenceApi.heartbeat().catch(() => {});
      const interval = setInterval(tick, 30000);

      return () => clearInterval(interval);
    },

    /** Clears everything on logout so the next user never sees the previous one's data. */
    reset: () => {
      get().disconnectSSE();
      teamsRequest++;
      channelsRequest++;
      messagesRequest++;
      readTimers.forEach(clearTimeout);
      readTimers.clear();
      appliedDeletions.clear();
      countedReplies.clear();
      set({ ...initialState });
    },
  };
});
