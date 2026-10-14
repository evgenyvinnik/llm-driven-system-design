import { create } from 'zustand';
import type { Organization, Team, Channel, Message, ChannelMember } from '../types';
import { orgApi, teamApi, channelApi, messageApi, presenceApi, reactionApi } from '../services/api';
import { useAuthStore } from './authStore';
import {
  applyChannelEvent,
  applyReaction,
  mergeOlder,
  upsertMessage,
  withDefaults,
} from './messageReducers';

/** Connection state of the open channel's event stream, shown as a banner when not live. */
export type StreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting';

const STREAM_EVENTS = [
  'new_message',
  'message_edited',
  'message_deleted',
  'reaction_added',
  'reaction_removed',
] as const;

interface ChatState {
  // Data
  organizations: Organization[];
  teams: Team[];
  channels: Channel[];
  messages: Message[];
  threadMessages: Message[];
  channelMembers: ChannelMember[];

  // Selection (the URL is the source of truth; these record what the loaded data belongs to)
  currentOrgId: string | null;
  currentTeamId: string | null;
  currentChannelId: string | null;
  threadParentId: string | null;

  // UI state
  loading: boolean;
  loadError: string | null;
  loadingOlder: boolean;
  hasMore: boolean;
  streamStatus: StreamStatus;
  showMemberList: boolean;

  // Actions
  loadOrganizations: () => Promise<void>;
  loadTeams: (orgId: string) => Promise<void>;
  loadChannels: (teamId: string) => Promise<void>;
  openChannel: (channelId: string) => Promise<void>;
  closeChannel: () => void;
  loadMoreMessages: () => Promise<void>;
  loadThread: (messageId: string) => Promise<void>;
  loadChannelMembers: (channelId: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  retryMessage: (clientMessageId: string) => Promise<void>;
  sendThreadReply: (content: string) => Promise<void>;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  openThread: (messageId: string) => void;
  closeThread: () => void;
  toggleMemberList: () => void;
  startPresenceHeartbeat: () => () => void;
}

/**
 * Bookkeeping for the open channel, kept outside React state because nothing renders it.
 * `session` increments on every channel switch, so a response that arrives for a channel the
 * user has already left is dropped instead of overwriting the new one. `lastSeq` is the highest
 * stream event applied; history and the stream meet exactly at it.
 */
const live = {
  session: 0,
  lastSeq: 0,
  source: null as EventSource | null,
  retryTimer: undefined as number | undefined,
};
let orgRequest = 0;
let teamRequest = 0;

function closeSource(): void {
  window.clearTimeout(live.retryTimer);
  live.source?.close();
  live.source = null;
}

/** Chat state managing org/team/channel hierarchy, messages, threads, the event stream, and presence. */
export const useChatStore = create<ChatState>((set, get) => {
  /** Loads the newest history page and records the stream position it corresponds to. */
  async function loadLatestPage(channelId: string, session: number): Promise<boolean> {
    try {
      const page = await messageApi.list(channelId);
      if (session !== live.session) return false;
      live.lastSeq = page.latestSeq;
      // Keep sends that are still in flight (or failed) on top of the fresh page.
      const unsent = get().messages.filter((m) => m.status);
      set({
        messages: [...page.messages.map(withDefaults).reverse(), ...unsent],
        hasMore: page.hasMore,
        loading: false,
        loadError: null,
      });
      return true;
    } catch (err) {
      if (session !== live.session) return false;
      set({ loading: false, loadError: err instanceof Error ? err.message : 'Request failed' });
      return false;
    }
  }

  /** Opens the stream after the last applied seq; the server replays anything newer first. */
  function connectStream(channelId: string, session: number): void {
    closeSource();
    const source = new EventSource(`/api/sse/${channelId}?after=${live.lastSeq}`, {
      withCredentials: true,
    });
    live.source = source;
    set({ streamStatus: 'connecting' });

    const onEvent = (type: string) => (event: MessageEvent<string>) => {
      if (session !== live.session) return;
      const seq = Number(event.lastEventId);
      if (!Number.isSafeInteger(seq) || seq <= live.lastSeq) return; // already applied
      if (seq > live.lastSeq + 1) {
        // Something was skipped: reopen from the last applied seq and let the server replay it.
        connectStream(channelId, session);
        return;
      }
      live.lastSeq = seq;
      set((state) => applyChannelEvent(state, type, JSON.parse(event.data)));
    };
    for (const type of STREAM_EVENTS) source.addEventListener(type, onEvent(type));

    // The server cannot replay this gap (too old, or never logged): reload, then reconnect.
    source.addEventListener('resync', () => {
      if (session !== live.session) return;
      closeSource();
      void loadLatestPage(channelId, session).then((ok) => {
        if (ok) connectStream(channelId, session);
      });
    });
    source.onopen = () => {
      if (session === live.session) set({ streamStatus: 'live' });
    };
    source.onerror = () => {
      if (session !== live.session) return;
      set({ streamStatus: 'reconnecting' });
      // EventSource retries network errors itself, resending Last-Event-ID. It gives up when the
      // server answers with an error status (a restart mid-request, an expired session); then
      // retry from our own cursor after a pause.
      if (source.readyState === EventSource.CLOSED) {
        live.retryTimer = window.setTimeout(() => {
          if (session === live.session) connectStream(channelId, session);
        }, 5000);
      }
    };
  }

  async function postMessage(pending: Message): Promise<void> {
    const session = live.session;
    try {
      // Retries resend the same clientMessageId, so a send whose response was lost is not
      // posted twice: the server answers with the original message.
      const { message } = await messageApi.send(
        pending.channel_id,
        pending.content,
        pending.client_message_id!,
      );
      if (session === live.session) {
        set((state) => ({ messages: upsertMessage(state.messages, withDefaults(message)) }));
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      if (session !== live.session) return;
      set((state) => ({
        messages: state.messages.map((m) =>
          m.status === 'pending' && m.client_message_id === pending.client_message_id
            ? { ...m, status: 'failed' as const }
            : m,
        ),
      }));
    }
  }

  return {
    organizations: [],
    teams: [],
    channels: [],
    messages: [],
    threadMessages: [],
    channelMembers: [],
    currentOrgId: null,
    currentTeamId: null,
    currentChannelId: null,
    threadParentId: null,
    loading: false,
    loadError: null,
    loadingOlder: false,
    hasMore: false,
    streamStatus: 'idle',
    showMemberList: false,

    loadOrganizations: async () => {
      try {
        const { organizations } = await orgApi.list();
        set({ organizations });
      } catch (err) {
        console.error('Failed to load organizations:', err);
      }
    },

    loadTeams: async (orgId: string) => {
      const request = ++orgRequest;
      try {
        const { teams } = await teamApi.list(orgId);
        if (request === orgRequest) set({ teams, currentOrgId: orgId });
      } catch (err) {
        console.error('Failed to load teams:', err);
      }
    },

    loadChannels: async (teamId: string) => {
      // Only the latest request may win: an older team's list must not replace a newer one.
      const request = ++teamRequest;
      try {
        const { channels } = await channelApi.list(teamId);
        if (request === teamRequest) set({ channels, currentTeamId: teamId });
      } catch (err) {
        console.error('Failed to load channels:', err);
      }
    },

    openChannel: async (channelId: string) => {
      const session = ++live.session;
      closeSource();
      set({
        currentChannelId: channelId,
        messages: [],
        threadParentId: null,
        threadMessages: [],
        hasMore: false,
        loading: true,
        loadError: null,
        loadingOlder: false,
        streamStatus: 'idle',
      });
      // History first, then the stream from the position the page was read at: nothing falls
      // between the two, and nothing is applied twice.
      if (await loadLatestPage(channelId, session)) connectStream(channelId, session);
      if (session === live.session) void get().loadChannelMembers(channelId);
    },

    closeChannel: () => {
      live.session++;
      closeSource();
      set({ currentChannelId: null, streamStatus: 'idle' });
    },

    loadMoreMessages: async () => {
      const { currentChannelId, messages, hasMore, loadingOlder } = get();
      const oldest = messages.find((m) => !m.status);
      if (!currentChannelId || !hasMore || loadingOlder || !oldest) return;

      const session = live.session;
      set({ loadingOlder: true });
      try {
        const page = await messageApi.list(currentChannelId, oldest.seq);
        if (session !== live.session) return;
        set((state) => ({
          messages: mergeOlder(state.messages, page.messages.map(withDefaults).reverse()),
          hasMore: page.hasMore,
          loadingOlder: false,
        }));
      } catch (err) {
        console.error('Failed to load older messages:', err);
        if (session === live.session) set({ loadingOlder: false });
      }
    },

    loadThread: async (messageId: string) => {
      try {
        const { messages } = await messageApi.getThread(messageId);
        if (get().threadParentId !== messageId) return; // another thread was opened meanwhile
        // The server answers with the whole thread even when asked from a reply.
        set({ threadMessages: messages.map(withDefaults), threadParentId: messages[0]?.id ?? messageId });
      } catch (err) {
        console.error('Failed to load thread:', err);
      }
    },

    loadChannelMembers: async (channelId: string) => {
      try {
        const { members } = await presenceApi.getChannelPresence(channelId);
        if (get().currentChannelId === channelId) set({ channelMembers: members });
      } catch (err) {
        console.error('Failed to load channel members:', err);
      }
    },

    sendMessage: async (content: string) => {
      const channelId = get().currentChannelId;
      if (!channelId) return;
      const user = useAuthStore.getState().user;
      const clientMessageId = crypto.randomUUID();
      const now = new Date().toISOString();
      // Shown at once, dimmed, and replaced in place by the server's copy (REST response or
      // stream event, whichever arrives first) because both carry the same clientMessageId.
      const pending: Message = {
        id: `pending-${clientMessageId}`,
        client_message_id: clientMessageId,
        channel_id: channelId,
        user_id: user?.id ?? '',
        parent_message_id: null,
        content,
        is_edited: false,
        seq: 0,
        created_at: now,
        updated_at: now,
        username: user?.username ?? '',
        display_name: user?.displayName ?? user?.username ?? '',
        reply_count: 0,
        reactions: [],
        status: 'pending',
      };
      set((state) => ({ messages: upsertMessage(state.messages, pending) }));
      await postMessage(pending);
    },

    retryMessage: async (clientMessageId: string) => {
      const failed = get().messages.find(
        (m) => m.status === 'failed' && m.client_message_id === clientMessageId,
      );
      if (!failed) return;
      const pending = { ...failed, status: 'pending' as const };
      set((state) => ({ messages: state.messages.map((m) => (m === failed ? pending : m)) }));
      await postMessage(pending);
    },

    sendThreadReply: async (content: string) => {
      const { currentChannelId, threadParentId } = get();
      if (!currentChannelId || !threadParentId) return;

      try {
        const { message } = await messageApi.send(
          currentChannelId,
          content,
          crypto.randomUUID(),
          threadParentId,
        );
        if (get().threadParentId !== threadParentId) return;
        set((state) => ({
          threadMessages: upsertMessage(state.threadMessages, withDefaults(message)),
        }));
      } catch (err) {
        console.error('Failed to send thread reply:', err);
      }
    },

    toggleReaction: async (messageId: string, emoji: string) => {
      const username = useAuthStore.getState().user?.username;
      const target = [...get().messages, ...get().threadMessages].find((m) => m.id === messageId);
      if (!username || !target) return;

      const mine = target.reactions.some((r) => r.emoji === emoji && r.users.includes(username));
      const apply = (added: boolean) =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === messageId ? applyReaction(m, emoji, username, added) : m,
          ),
          threadMessages: state.threadMessages.map((m) =>
            m.id === messageId ? applyReaction(m, emoji, username, added) : m,
          ),
        }));

      // Optimistic: the matching stream event is a no-op when it arrives, because reactions are
      // applied as a set of usernames rather than as counter increments.
      apply(!mine);
      try {
        if (mine) await reactionApi.remove(messageId, emoji);
        else await reactionApi.add(messageId, emoji);
      } catch (err) {
        console.error('Failed to update reaction:', err);
        apply(mine);
      }
    },

    openThread: (messageId: string) => {
      set({ threadParentId: messageId, threadMessages: [] });
      void get().loadThread(messageId);
    },

    closeThread: () => {
      set({ threadParentId: null, threadMessages: [] });
    },

    toggleMemberList: () => {
      set((state) => ({ showMemberList: !state.showMemberList }));
    },

    startPresenceHeartbeat: () => {
      // Send heartbeat every 30 seconds
      presenceApi.heartbeat().catch(() => {});
      const interval = setInterval(() => {
        presenceApi.heartbeat().catch(() => {});
      }, 30000);

      return () => clearInterval(interval);
    },
  };
});
