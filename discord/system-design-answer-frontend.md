# Discord (Real-Time Chat System) - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

---

## Introduction

"Today I'll design a real-time chat system similar to Discord from a frontend perspective. I'll focus on the component architecture, real-time message handling, state management with Zustand, WebSocket/SSE integration, and building a responsive Discord-like UI with Tailwind CSS. The core challenge is creating a seamless real-time experience that handles thousands of messages efficiently."

---

## Step 1: Requirements Clarification

### Functional Requirements

1. **Server & Channel Navigation**: Users browse servers and channels
2. **Real-Time Messaging**: Messages appear instantly without page refresh
3. **Message History**: Infinite scroll with lazy loading
4. **Presence Indicators**: Show who's online/offline/idle
5. **Direct Messages**: Private conversations
6. **Message Reactions**: Emoji reactions on messages

### Non-Functional Requirements

- **Performance**: Handle channels with thousands of messages smoothly
- **Responsiveness**: Work on desktop and mobile
- **Accessibility**: Keyboard navigation, screen reader support
- **Offline Resilience**: Queue messages when connection drops
- **Low Latency**: Messages appear within 100ms

---

## Step 2: Component Architecture

### Application Structure

```
┌────────────────────────────────────────────────────────────────────┐
│                         App Shell                                   │
├─────────┬──────────────────────────────────────────────────────────┤
│ Server  │                    Channels Layout                        │
│  List   ├──────────────────┬───────────────────────────────────────┤
│         │ Channel Sidebar  │         Chat View                      │
│ ┌─────┐ │ ┌──────────────┐ │ ┌─────────────────────────────────────┐│
│ │ S1  │ │ │ Text Channels│ │ │      Channel Header                 ││
│ ├─────┤ │ │ # general    │ │ ├─────────────────────────────────────┤│
│ │ S2  │ │ │ # random     │ │ │                                     ││
│ ├─────┤ │ ├──────────────┤ │ │      Message List                   ││
│ │ S3  │ │ │Voice Channels│ │ │      (Virtualized)                  ││
│ ├─────┤ │ │ 🔊 General   │ │ │                                     ││
│ │ DM  │ │ ├──────────────┤ │ ├─────────────────────────────────────┤│
│ └─────┘ │ │ User Panel   │ │ │      Message Input                  ││
│         │ └──────────────┘ │ └─────────────────────────────────────┘│
└─────────┴──────────────────┴───────────────────────────────────────┘
```

### Directory Structure

```
frontend/src/
├── routes/
│   ├── __root.tsx              # Root layout
│   ├── index.tsx               # Auth redirect
│   ├── login.tsx               # Login page
│   ├── channels.tsx            # Channels layout
│   └── channels/
│       ├── @me.tsx             # Home/DM list
│       └── $serverId.$channelId.tsx  # Channel view
├── components/
│   ├── layout/
│   │   ├── ServerList.tsx      # Left-most icon column
│   │   ├── ChannelSidebar.tsx  # Channel navigation
│   │   ├── UserPanel.tsx       # Bottom user info
│   │   └── MemberList.tsx      # Right sidebar
│   ├── chat/
│   │   ├── ChannelHeader.tsx   # Channel name, topic
│   │   ├── MessageList.tsx     # Virtualized messages
│   │   ├── Message.tsx         # Single message
│   │   ├── MessageInput.tsx    # Compose area
│   │   ├── MessageReactions.tsx
│   │   └── TypingIndicator.tsx
│   ├── presence/
│   │   ├── OnlineIndicator.tsx
│   │   └── PresenceProvider.tsx
│   └── common/
│       ├── Avatar.tsx
│       ├── Tooltip.tsx
│       └── Modal.tsx
├── stores/
│   ├── authStore.ts            # User session
│   ├── channelStore.ts         # Channel state
│   ├── messageStore.ts         # Messages cache
│   └── presenceStore.ts        # Online status
├── hooks/
│   ├── useWebSocket.ts         # WebSocket connection
│   ├── useMessages.ts          # Message fetching
│   └── usePresence.ts          # Presence updates
└── services/
    ├── api.ts                  # REST API client
    └── websocket.ts            # WebSocket client
```

---

## Step 3: State Management with Zustand

### Auth Store

```typescript
// stores/authStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  email: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;

  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setUser: (user: User) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,

      login: async (email, password) => {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        if (!response.ok) {
          throw new Error('Login failed');
        }

        const { user, token } = await response.json();
        set({ user, token, isAuthenticated: true });
      },

      logout: () => {
        set({ user: null, token: null, isAuthenticated: false });
        // Disconnect WebSocket
        websocketClient.disconnect();
      },

      setUser: (user) => set({ user }),
    }),
    {
      name: 'discord-auth',
      partialize: (state) => ({ token: state.token }),
    }
  )
);
```

### Message Store with Optimistic Updates

```typescript
// stores/messageStore.ts
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

interface Message {
  id: string;
  channelId: string;
  authorId: string;
  author: {
    id: string;
    username: string;
    avatar: string | null;
  };
  content: string;
  timestamp: string;
  editedTimestamp: string | null;
  reactions: Reaction[];
  pending?: boolean;
  failed?: boolean;
}

interface Reaction {
  emoji: string;
  count: number;
  me: boolean;
}

interface MessageState {
  messagesByChannel: Map<string, Message[]>;
  hasMoreByChannel: Map<string, boolean>;
  isLoadingByChannel: Map<string, boolean>;

  addMessage: (channelId: string, message: Message) => void;
  addMessages: (channelId: string, messages: Message[], prepend?: boolean) => void;
  updateMessage: (channelId: string, messageId: string, updates: Partial<Message>) => void;
  deleteMessage: (channelId: string, messageId: string) => void;
  addReaction: (channelId: string, messageId: string, emoji: string, userId: string) => void;
  removeReaction: (channelId: string, messageId: string, emoji: string, userId: string) => void;

  sendMessage: (channelId: string, content: string) => Promise<void>;
  fetchMessages: (channelId: string, before?: string) => Promise<void>;
}

export const useMessageStore = create<MessageState>()(
  subscribeWithSelector((set, get) => ({
    messagesByChannel: new Map(),
    hasMoreByChannel: new Map(),
    isLoadingByChannel: new Map(),

    addMessage: (channelId, message) => {
      set((state) => {
        const messages = state.messagesByChannel.get(channelId) || [];
        // Avoid duplicates
        if (messages.some((m) => m.id === message.id)) {
          return state;
        }
        const newMap = new Map(state.messagesByChannel);
        newMap.set(channelId, [...messages, message]);
        return { messagesByChannel: newMap };
      });
    },

    addMessages: (channelId, messages, prepend = false) => {
      set((state) => {
        const existing = state.messagesByChannel.get(channelId) || [];
        const newMap = new Map(state.messagesByChannel);
        newMap.set(
          channelId,
          prepend ? [...messages, ...existing] : [...existing, ...messages]
        );
        return { messagesByChannel: newMap };
      });
    },

    updateMessage: (channelId, messageId, updates) => {
      set((state) => {
        const messages = state.messagesByChannel.get(channelId);
        if (!messages) return state;

        const newMap = new Map(state.messagesByChannel);
        newMap.set(
          channelId,
          messages.map((m) => (m.id === messageId ? { ...m, ...updates } : m))
        );
        return { messagesByChannel: newMap };
      });
    },

    deleteMessage: (channelId, messageId) => {
      set((state) => {
        const messages = state.messagesByChannel.get(channelId);
        if (!messages) return state;

        const newMap = new Map(state.messagesByChannel);
        newMap.set(
          channelId,
          messages.filter((m) => m.id !== messageId)
        );
        return { messagesByChannel: newMap };
      });
    },

    sendMessage: async (channelId, content) => {
      const { user } = useAuthStore.getState();
      if (!user) return;

      // Create optimistic message
      const tempId = `temp-${Date.now()}`;
      const optimisticMessage: Message = {
        id: tempId,
        channelId,
        authorId: user.id,
        author: { id: user.id, username: user.username, avatar: user.avatar },
        content,
        timestamp: new Date().toISOString(),
        editedTimestamp: null,
        reactions: [],
        pending: true,
      };

      get().addMessage(channelId, optimisticMessage);

      try {
        const response = await api.post(`/channels/${channelId}/messages`, { content });
        const realMessage = response.data;

        // Replace optimistic with real
        set((state) => {
          const messages = state.messagesByChannel.get(channelId) || [];
          const newMap = new Map(state.messagesByChannel);
          newMap.set(
            channelId,
            messages.map((m) => (m.id === tempId ? realMessage : m))
          );
          return { messagesByChannel: newMap };
        });
      } catch (error) {
        // Mark as failed
        get().updateMessage(channelId, tempId, { pending: false, failed: true });
      }
    },

    fetchMessages: async (channelId, before) => {
      const isLoading = get().isLoadingByChannel.get(channelId);
      if (isLoading) return;

      set((state) => {
        const newMap = new Map(state.isLoadingByChannel);
        newMap.set(channelId, true);
        return { isLoadingByChannel: newMap };
      });

      try {
        const params = new URLSearchParams({ limit: '50' });
        if (before) params.append('before', before);

        const response = await api.get(`/channels/${channelId}/messages?${params}`);
        const messages = response.data;

        get().addMessages(channelId, messages, true);

        set((state) => {
          const hasMoreMap = new Map(state.hasMoreByChannel);
          hasMoreMap.set(channelId, messages.length === 50);
          return { hasMoreByChannel: hasMoreMap };
        });
      } finally {
        set((state) => {
          const newMap = new Map(state.isLoadingByChannel);
          newMap.set(channelId, false);
          return { isLoadingByChannel: newMap };
        });
      }
    },

    addReaction: (channelId, messageId, emoji, userId) => {
      set((state) => {
        const messages = state.messagesByChannel.get(channelId);
        if (!messages) return state;

        const newMap = new Map(state.messagesByChannel);
        newMap.set(
          channelId,
          messages.map((m) => {
            if (m.id !== messageId) return m;

            const existingReaction = m.reactions.find((r) => r.emoji === emoji);
            if (existingReaction) {
              return {
                ...m,
                reactions: m.reactions.map((r) =>
                  r.emoji === emoji
                    ? { ...r, count: r.count + 1, me: userId === useAuthStore.getState().user?.id }
                    : r
                ),
              };
            } else {
              return {
                ...m,
                reactions: [
                  ...m.reactions,
                  { emoji, count: 1, me: userId === useAuthStore.getState().user?.id },
                ],
              };
            }
          })
        );
        return { messagesByChannel: newMap };
      });
    },

    removeReaction: (channelId, messageId, emoji, userId) => {
      set((state) => {
        const messages = state.messagesByChannel.get(channelId);
        if (!messages) return state;

        const newMap = new Map(state.messagesByChannel);
        newMap.set(
          channelId,
          messages.map((m) => {
            if (m.id !== messageId) return m;

            return {
              ...m,
              reactions: m.reactions
                .map((r) =>
                  r.emoji === emoji
                    ? { ...r, count: r.count - 1, me: userId === useAuthStore.getState().user?.id ? false : r.me }
                    : r
                )
                .filter((r) => r.count > 0),
            };
          })
        );
        return { messagesByChannel: newMap };
      });
    },
  }))
);
```

### Presence Store

```typescript
// stores/presenceStore.ts
import { create } from 'zustand';

type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

interface PresenceState {
  presences: Map<string, PresenceStatus>;
  customStatuses: Map<string, string>;

  setPresence: (userId: string, status: PresenceStatus) => void;
  setCustomStatus: (userId: string, status: string) => void;
  setBulkPresences: (presences: Record<string, PresenceStatus>) => void;
  getPresence: (userId: string) => PresenceStatus;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  presences: new Map(),
  customStatuses: new Map(),

  setPresence: (userId, status) => {
    set((state) => {
      const newMap = new Map(state.presences);
      newMap.set(userId, status);
      return { presences: newMap };
    });
  },

  setCustomStatus: (userId, status) => {
    set((state) => {
      const newMap = new Map(state.customStatuses);
      newMap.set(userId, status);
      return { customStatuses: newMap };
    });
  },

  setBulkPresences: (presences) => {
    set((state) => {
      const newMap = new Map(state.presences);
      Object.entries(presences).forEach(([userId, status]) => {
        newMap.set(userId, status);
      });
      return { presences: newMap };
    });
  },

  getPresence: (userId) => {
    return get().presences.get(userId) || 'offline';
  },
}));
```

---

## Step 4: WebSocket Connection Management

### WebSocket Client

```typescript
// services/websocket.ts
type MessageHandler = (data: any) => void;

interface WebSocketClient {
  connect: () => void;
  disconnect: () => void;
  send: (type: string, payload: any) => void;
  subscribe: (eventType: string, handler: MessageHandler) => () => void;
}

class DiscordWebSocket implements WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private messageQueue: { type: string; payload: any }[] = [];

  connect(): void {
    const { token } = useAuthStore.getState();
    if (!token) return;

    const wsUrl = `${import.meta.env.VITE_WS_URL}?token=${token}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.flushMessageQueue();
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleMessage(data);
    };

    this.ws.onclose = (event) => {
      console.log('WebSocket closed:', event.code);
      this.stopHeartbeat();
      this.handleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'User logout');
      this.ws = null;
    }
  }

  send(type: string, payload: any): void {
    const message = JSON.stringify({ type, ...payload });

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    } else {
      // Queue message for when connection is restored
      this.messageQueue.push({ type, payload });
    }
  }

  subscribe(eventType: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  private handleMessage(data: { type: string; [key: string]: any }): void {
    const handlers = this.handlers.get(data.type);
    if (handlers) {
      handlers.forEach((handler) => handler(data));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.send('HEARTBEAT', { timestamp: Date.now() });
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0) {
      const { type, payload } = this.messageQueue.shift()!;
      this.send(type, payload);
    }
  }
}

export const websocketClient = new DiscordWebSocket();
```

### WebSocket Hook

```typescript
// hooks/useWebSocket.ts
import { useEffect, useRef } from 'react';
import { websocketClient } from '../services/websocket';
import { useMessageStore } from '../stores/messageStore';
import { usePresenceStore } from '../stores/presenceStore';

export function useWebSocket() {
  const addMessage = useMessageStore((s) => s.addMessage);
  const updateMessage = useMessageStore((s) => s.updateMessage);
  const deleteMessage = useMessageStore((s) => s.deleteMessage);
  const addReaction = useMessageStore((s) => s.addReaction);
  const removeReaction = useMessageStore((s) => s.removeReaction);
  const setPresence = usePresenceStore((s) => s.setPresence);

  useEffect(() => {
    websocketClient.connect();

    const unsubscribers = [
      websocketClient.subscribe('MESSAGE_CREATE', (data) => {
        addMessage(data.channelId, data.message);
      }),

      websocketClient.subscribe('MESSAGE_UPDATE', (data) => {
        updateMessage(data.channelId, data.messageId, data.updates);
      }),

      websocketClient.subscribe('MESSAGE_DELETE', (data) => {
        deleteMessage(data.channelId, data.messageId);
      }),

      websocketClient.subscribe('REACTION_ADD', (data) => {
        addReaction(data.channelId, data.messageId, data.emoji, data.userId);
      }),

      websocketClient.subscribe('REACTION_REMOVE', (data) => {
        removeReaction(data.channelId, data.messageId, data.emoji, data.userId);
      }),

      websocketClient.subscribe('PRESENCE_UPDATE', (data) => {
        setPresence(data.userId, data.status);
      }),

      websocketClient.subscribe('TYPING_START', (data) => {
        // Handle typing indicator
      }),
    ];

    return () => {
      unsubscribers.forEach((unsub) => unsub());
      websocketClient.disconnect();
    };
  }, []);
}
```

---

## Step 5: Virtualized Message List

### MessageList Component

```typescript
// components/chat/MessageList.tsx
import { useRef, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Message } from './Message';
import { useMessageStore } from '../../stores/messageStore';

interface MessageListProps {
  channelId: string;
}

export function MessageList({ channelId }: MessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = useMessageStore(
    (s) => s.messagesByChannel.get(channelId) || []
  );
  const hasMore = useMessageStore((s) => s.hasMoreByChannel.get(channelId) ?? true);
  const isLoading = useMessageStore((s) => s.isLoadingByChannel.get(channelId) ?? false);
  const fetchMessages = useMessageStore((s) => s.fetchMessages);

  // Group messages by author for compact display
  const groupedMessages = useMemo(() => groupMessagesByAuthor(messages), [messages]);

  const virtualizer = useVirtualizer({
    count: groupedMessages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      // Estimate height based on message content
      const group = groupedMessages[index];
      const baseHeight = 48; // Avatar + username
      const messageHeight = group.messages.length * 24; // ~24px per message line
      return baseHeight + messageHeight;
    },
    overscan: 5,
    getItemKey: (index) => groupedMessages[index].id,
  });

  // Load more when scrolling to top
  const handleScroll = useCallback(() => {
    if (!parentRef.current || isLoading) return;

    const { scrollTop } = parentRef.current;
    if (scrollTop < 100 && hasMore) {
      const oldestMessage = messages[0];
      if (oldestMessage) {
        fetchMessages(channelId, oldestMessage.id);
      }
    }
  }, [channelId, hasMore, isLoading, messages, fetchMessages]);

  // Auto-scroll to bottom on new messages
  const prevMessagesLength = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevMessagesLength.current) {
      const isNearBottom =
        parentRef.current &&
        parentRef.current.scrollHeight - parentRef.current.scrollTop <
          parentRef.current.clientHeight + 200;

      if (isNearBottom) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
    prevMessagesLength.current = messages.length;
  }, [messages.length]);

  // Initial fetch
  useEffect(() => {
    if (messages.length === 0) {
      fetchMessages(channelId);
    }
  }, [channelId]);

  return (
    <div
      ref={parentRef}
      className="flex-1 overflow-y-auto overflow-x-hidden"
      onScroll={handleScroll}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {isLoading && (
          <div className="flex justify-center py-4">
            <LoadingSpinner />
          </div>
        )}

        {virtualizer.getVirtualItems().map((virtualRow) => {
          const group = groupedMessages[virtualRow.index];

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
            >
              <MessageGroup group={group} />
            </div>
          );
        })}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}

function groupMessagesByAuthor(messages: Message[]) {
  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup | null = null;

  for (const message of messages) {
    const timeDiff = currentGroup
      ? new Date(message.timestamp).getTime() -
        new Date(currentGroup.messages[currentGroup.messages.length - 1].timestamp).getTime()
      : Infinity;

    // Group messages from same author within 5 minutes
    if (
      currentGroup &&
      currentGroup.authorId === message.authorId &&
      timeDiff < 5 * 60 * 1000
    ) {
      currentGroup.messages.push(message);
    } else {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = {
        id: message.id,
        authorId: message.authorId,
        author: message.author,
        timestamp: message.timestamp,
        messages: [message],
      };
    }
  }

  if (currentGroup) groups.push(currentGroup);
  return groups;
}
```

### Message Component

```typescript
// components/chat/Message.tsx
import { memo } from 'react';
import { formatRelativeTime } from '../../utils/date';
import { Avatar } from '../common/Avatar';
import { MessageReactions } from './MessageReactions';
import { OnlineIndicator } from '../presence/OnlineIndicator';

interface MessageGroupProps {
  group: MessageGroup;
}

export const MessageGroup = memo(function MessageGroup({ group }: MessageGroupProps) {
  return (
    <div className="group relative flex px-4 py-0.5 hover:bg-gray-800/30">
      {/* Avatar */}
      <div className="mr-4 mt-0.5 flex-shrink-0">
        <div className="relative">
          <Avatar
            src={group.author.avatar}
            alt={group.author.username}
            size={40}
          />
          <OnlineIndicator
            userId={group.authorId}
            className="absolute -bottom-0.5 -right-0.5"
          />
        </div>
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-gray-100 hover:underline cursor-pointer">
            {group.author.username}
          </span>
          <span className="text-xs text-gray-400">
            {formatRelativeTime(group.timestamp)}
          </span>
        </div>

        {group.messages.map((message) => (
          <MessageContent key={message.id} message={message} />
        ))}
      </div>

      {/* Actions (shown on hover) */}
      <MessageActions messageId={group.messages[0].id} channelId={group.messages[0].channelId} />
    </div>
  );
});

const MessageContent = memo(function MessageContent({ message }: { message: Message }) {
  return (
    <div className="relative">
      {message.pending && (
        <span className="text-gray-400 text-sm mr-2">Sending...</span>
      )}
      {message.failed && (
        <span className="text-red-400 text-sm mr-2">Failed to send</span>
      )}
      <p className={`text-gray-300 break-words ${message.pending ? 'opacity-50' : ''}`}>
        {message.content}
      </p>
      {message.editedTimestamp && (
        <span className="text-xs text-gray-500 ml-1">(edited)</span>
      )}
      {message.reactions.length > 0 && (
        <MessageReactions reactions={message.reactions} messageId={message.id} />
      )}
    </div>
  );
});

function MessageActions({ messageId, channelId }: { messageId: string; channelId: string }) {
  return (
    <div className="absolute right-4 top-0 hidden group-hover:flex gap-1 bg-gray-900 rounded border border-gray-700">
      <button
        className="p-1.5 hover:bg-gray-700 rounded"
        aria-label="Add reaction"
      >
        <EmojiIcon className="w-4 h-4 text-gray-400" />
      </button>
      <button
        className="p-1.5 hover:bg-gray-700 rounded"
        aria-label="Reply"
      >
        <ReplyIcon className="w-4 h-4 text-gray-400" />
      </button>
      <button
        className="p-1.5 hover:bg-gray-700 rounded"
        aria-label="More options"
      >
        <MoreIcon className="w-4 h-4 text-gray-400" />
      </button>
    </div>
  );
}
```

---

## Step 6: Message Input with Typing Indicator

```typescript
// components/chat/MessageInput.tsx
import { useState, useRef, useCallback } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { websocketClient } from '../../services/websocket';
import { debounce } from '../../utils/debounce';

interface MessageInputProps {
  channelId: string;
  channelName: string;
}

export function MessageInput({ channelId, channelName }: MessageInputProps) {
  const [content, setContent] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useMessageStore((s) => s.sendMessage);

  // Debounced typing indicator
  const sendTypingIndicator = useCallback(
    debounce(() => {
      websocketClient.send('TYPING_START', { channelId });
    }, 1000),
    [channelId]
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    sendTypingIndicator();

    // Auto-resize textarea
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  };

  const handleSubmit = async () => {
    const trimmed = content.trim();
    if (!trimmed) return;

    setContent('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    await sendMessage(channelId, trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      await handleFileUpload(files);
    }
  };

  const handleFileUpload = async (files: File[]) => {
    setIsUploading(true);
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        await fetch(`/api/channels/${channelId}/attachments`, {
          method: 'POST',
          body: formData,
        });
      }
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="px-4 pb-6">
      <div className="bg-gray-700 rounded-lg flex items-end">
        {/* Attachment button */}
        <button
          className="p-3 hover:bg-gray-600 rounded-l-lg"
          aria-label="Attach file"
        >
          <PlusCircleIcon className="w-6 h-6 text-gray-400" />
        </button>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={`Message #${channelName}`}
          className="flex-1 bg-transparent text-gray-100 placeholder-gray-400 py-3 px-2
                     resize-none focus:outline-none min-h-[44px] max-h-[200px]"
          rows={1}
          disabled={isUploading}
        />

        {/* Emoji picker */}
        <button
          className="p-3 hover:bg-gray-600"
          aria-label="Select emoji"
        >
          <EmojiHappyIcon className="w-6 h-6 text-gray-400" />
        </button>

        {/* GIF picker */}
        <button
          className="p-3 hover:bg-gray-600 rounded-r-lg"
          aria-label="Send GIF"
        >
          <GifIcon className="w-6 h-6 text-gray-400" />
        </button>
      </div>

      {/* Typing indicator */}
      <TypingIndicator channelId={channelId} />
    </div>
  );
}
```

### Typing Indicator

```typescript
// components/chat/TypingIndicator.tsx
import { useState, useEffect } from 'react';
import { websocketClient } from '../../services/websocket';

interface TypingIndicatorProps {
  channelId: string;
}

interface TypingUser {
  userId: string;
  username: string;
  timestamp: number;
}

export function TypingIndicator({ channelId }: TypingIndicatorProps) {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);

  useEffect(() => {
    const unsubscribe = websocketClient.subscribe('TYPING_START', (data) => {
      if (data.channelId !== channelId) return;

      setTypingUsers((prev) => {
        const filtered = prev.filter((u) => u.userId !== data.userId);
        return [...filtered, { ...data, timestamp: Date.now() }];
      });
    });

    // Remove stale typing indicators
    const interval = setInterval(() => {
      setTypingUsers((prev) =>
        prev.filter((u) => Date.now() - u.timestamp < 5000)
      );
    }, 1000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [channelId]);

  if (typingUsers.length === 0) return null;

  const text = formatTypingText(typingUsers.map((u) => u.username));

  return (
    <div className="h-6 text-sm text-gray-400 flex items-center gap-2 pl-1">
      <TypingDots />
      <span>{text}</span>
    </div>
  );
}

function formatTypingText(usernames: string[]): string {
  if (usernames.length === 1) {
    return `${usernames[0]} is typing...`;
  } else if (usernames.length === 2) {
    return `${usernames[0]} and ${usernames[1]} are typing...`;
  } else if (usernames.length === 3) {
    return `${usernames[0]}, ${usernames[1]}, and ${usernames[2]} are typing...`;
  } else {
    return `${usernames.slice(0, 2).join(', ')} and ${usernames.length - 2} others are typing...`;
  }
}

function TypingDots() {
  return (
    <div className="flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}
```

---

## Step 7: Server and Channel Navigation

### Server List

```typescript
// components/layout/ServerList.tsx
import { Link, useParams } from '@tanstack/react-router';
import { useServerStore } from '../../stores/serverStore';

export function ServerList() {
  const servers = useServerStore((s) => s.servers);
  const { serverId } = useParams({ from: '/channels/$serverId/$channelId' });

  return (
    <nav className="w-[72px] bg-gray-900 flex flex-col items-center py-3 gap-2 overflow-y-auto">
      {/* Home button (DMs) */}
      <Link
        to="/channels/@me"
        className={`group relative w-12 h-12 rounded-2xl flex items-center justify-center
                    bg-gray-700 hover:bg-indigo-500 hover:rounded-xl transition-all
                    ${!serverId ? 'bg-indigo-500 rounded-xl' : ''}`}
      >
        <DiscordIcon className="w-7 h-7 text-white" />
        <Tooltip content="Direct Messages" side="right" />
      </Link>

      <div className="w-8 h-0.5 bg-gray-700 rounded-full my-1" />

      {/* Server icons */}
      {servers.map((server) => (
        <ServerIcon
          key={server.id}
          server={server}
          isActive={serverId === server.id}
        />
      ))}

      {/* Add server button */}
      <button
        className="w-12 h-12 rounded-2xl bg-gray-700 flex items-center justify-center
                   text-green-500 hover:bg-green-500 hover:text-white hover:rounded-xl transition-all"
        aria-label="Add a server"
      >
        <PlusIcon className="w-6 h-6" />
      </button>
    </nav>
  );
}

function ServerIcon({ server, isActive }: { server: Server; isActive: boolean }) {
  const hasUnread = server.unreadCount > 0;

  return (
    <Link
      to={`/channels/${server.id}/${server.defaultChannelId}`}
      className="group relative"
    >
      {/* Unread indicator */}
      {hasUnread && !isActive && (
        <span className="absolute -left-1 top-1/2 -translate-y-1/2 w-1 h-5 bg-white rounded-r-full" />
      )}

      {/* Server avatar */}
      <div
        className={`w-12 h-12 rounded-2xl flex items-center justify-center
                    hover:rounded-xl transition-all overflow-hidden
                    ${isActive ? 'rounded-xl' : ''}
                    ${server.icon ? '' : 'bg-gray-700 hover:bg-indigo-500'}`}
      >
        {server.icon ? (
          <img src={server.icon} alt={server.name} className="w-full h-full object-cover" />
        ) : (
          <span className="text-white font-medium">
            {getServerAcronym(server.name)}
          </span>
        )}
      </div>

      {/* Active indicator */}
      {isActive && (
        <span className="absolute -left-1 top-1/2 -translate-y-1/2 w-1 h-10 bg-white rounded-r-full" />
      )}

      <Tooltip content={server.name} side="right" />
    </Link>
  );
}

function getServerAcronym(name: string): string {
  return name
    .split(' ')
    .map((word) => word[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();
}
```

### Channel Sidebar

```typescript
// components/layout/ChannelSidebar.tsx
import { Link, useParams } from '@tanstack/react-router';
import { useServerStore } from '../../stores/serverStore';
import { useState } from 'react';

export function ChannelSidebar() {
  const { serverId, channelId } = useParams({ from: '/channels/$serverId/$channelId' });
  const server = useServerStore((s) => s.servers.find((s) => s.id === serverId));

  if (!server) return null;

  const textChannels = server.channels.filter((c) => c.type === 'text');
  const voiceChannels = server.channels.filter((c) => c.type === 'voice');

  return (
    <aside className="w-60 bg-gray-800 flex flex-col">
      {/* Server header */}
      <button className="h-12 px-4 flex items-center justify-between border-b border-gray-900
                        hover:bg-gray-700/50 transition-colors">
        <span className="font-semibold text-white truncate">{server.name}</span>
        <ChevronDownIcon className="w-4 h-4 text-gray-400" />
      </button>

      {/* Channels */}
      <div className="flex-1 overflow-y-auto py-4">
        <ChannelCategory name="Text Channels" channels={textChannels} />
        <ChannelCategory name="Voice Channels" channels={voiceChannels} />
      </div>

      {/* User panel */}
      <UserPanel />
    </aside>
  );
}

function ChannelCategory({ name, channels }: { name: string; channels: Channel[] }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { channelId } = useParams({ from: '/channels/$serverId/$channelId' });

  return (
    <div className="mb-4">
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="flex items-center gap-1 px-2 mb-1 text-xs font-semibold text-gray-400
                   uppercase tracking-wide hover:text-gray-300"
      >
        <ChevronRightIcon
          className={`w-3 h-3 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
        />
        {name}
      </button>

      {!isCollapsed && (
        <div className="space-y-0.5">
          {channels.map((channel) => (
            <ChannelLink
              key={channel.id}
              channel={channel}
              isActive={channel.id === channelId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelLink({ channel, isActive }: { channel: Channel; isActive: boolean }) {
  return (
    <Link
      to={`/channels/${channel.serverId}/${channel.id}`}
      className={`mx-2 px-2 py-1.5 rounded flex items-center gap-2 group
                  ${isActive
                    ? 'bg-gray-700/60 text-white'
                    : 'text-gray-400 hover:bg-gray-700/40 hover:text-gray-300'
                  }`}
    >
      {channel.type === 'text' ? (
        <HashtagIcon className="w-5 h-5 text-gray-400" />
      ) : (
        <VolumeUpIcon className="w-5 h-5 text-gray-400" />
      )}
      <span className="truncate">{channel.name}</span>
      {channel.unreadCount > 0 && (
        <span className="ml-auto text-xs bg-red-500 text-white px-1.5 py-0.5 rounded-full">
          {channel.unreadCount}
        </span>
      )}
    </Link>
  );
}
```

---

## Step 8: Presence Indicators

```typescript
// components/presence/OnlineIndicator.tsx
import { usePresenceStore } from '../../stores/presenceStore';

interface OnlineIndicatorProps {
  userId: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function OnlineIndicator({ userId, className = '', size = 'sm' }: OnlineIndicatorProps) {
  const presence = usePresenceStore((s) => s.getPresence(userId));

  const sizeClasses = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  };

  const statusColors = {
    online: 'bg-green-500',
    idle: 'bg-yellow-500',
    dnd: 'bg-red-500',
    offline: 'bg-gray-500',
  };

  return (
    <span
      className={`${sizeClasses[size]} ${statusColors[presence]}
                  rounded-full border-2 border-gray-800 ${className}`}
      aria-label={`Status: ${presence}`}
    />
  );
}

// Member list with presence
function MemberList({ members }: { members: Member[] }) {
  const presences = usePresenceStore((s) => s.presences);

  // Group by presence status
  const online = members.filter((m) => presences.get(m.id) !== 'offline');
  const offline = members.filter((m) => presences.get(m.id) === 'offline');

  return (
    <aside className="w-60 bg-gray-800 overflow-y-auto">
      <MemberSection title={`Online - ${online.length}`} members={online} />
      <MemberSection title={`Offline - ${offline.length}`} members={offline} />
    </aside>
  );
}

function MemberSection({ title, members }: { title: string; members: Member[] }) {
  return (
    <div className="py-4">
      <h3 className="px-4 text-xs font-semibold text-gray-400 uppercase mb-2">
        {title}
      </h3>
      {members.map((member) => (
        <div
          key={member.id}
          className="px-2 py-1 mx-2 rounded flex items-center gap-3 hover:bg-gray-700/40 cursor-pointer"
        >
          <div className="relative">
            <Avatar src={member.avatar} size={32} />
            <OnlineIndicator userId={member.id} className="absolute -bottom-0.5 -right-0.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-gray-300 truncate">{member.username}</p>
            {member.customStatus && (
              <p className="text-xs text-gray-500 truncate">{member.customStatus}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

## Step 9: Responsive Design

```typescript
// components/layout/ResponsiveLayout.tsx
import { useState } from 'react';
import { useMediaQuery } from '../../hooks/useMediaQuery';

export function ResponsiveLayout({ children }: { children: React.ReactNode }) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [showSidebar, setShowSidebar] = useState(false);
  const [showMemberList, setShowMemberList] = useState(true);

  if (isMobile) {
    return (
      <div className="h-screen flex flex-col bg-gray-900">
        {/* Mobile header */}
        <header className="h-12 flex items-center px-4 bg-gray-800 border-b border-gray-900">
          <button onClick={() => setShowSidebar(true)} className="p-2">
            <MenuIcon className="w-6 h-6 text-gray-400" />
          </button>
          <span className="ml-2 font-semibold text-white"># channel-name</span>
        </header>

        {/* Chat area */}
        <main className="flex-1 overflow-hidden">
          {children}
        </main>

        {/* Slide-out sidebar */}
        {showSidebar && (
          <div className="fixed inset-0 z-50 flex">
            <div className="flex">
              <ServerList />
              <ChannelSidebar />
            </div>
            <div
              className="flex-1 bg-black/50"
              onClick={() => setShowSidebar(false)}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-gray-900">
      <ServerList />
      <ChannelSidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        {children}
      </main>
      {showMemberList && <MemberList />}
    </div>
  );
}

// hooks/useMediaQuery.ts
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
```

---

## Step 10: Accessibility

```typescript
// Keyboard navigation for message list
function MessageListWithKeyboard({ channelId }: { channelId: string }) {
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const messages = useMessageStore((s) => s.messagesByChannel.get(channelId) || []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(0, prev - 1));
        break;
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(messages.length - 1, prev + 1));
        break;
      case 'Enter':
        if (focusedIndex >= 0) {
          // Open message actions
        }
        break;
      case 'Escape':
        setFocusedIndex(-1);
        break;
    }
  };

  return (
    <div
      role="log"
      aria-label="Message history"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {messages.map((message, index) => (
        <div
          key={message.id}
          role="article"
          aria-label={`Message from ${message.author.username}`}
          tabIndex={focusedIndex === index ? 0 : -1}
          className={focusedIndex === index ? 'ring-2 ring-indigo-500' : ''}
        >
          {/* Message content */}
        </div>
      ))}
    </div>
  );
}

// Screen reader announcements for new messages
function LiveRegion() {
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const unsubscribe = websocketClient.subscribe('MESSAGE_CREATE', (data) => {
      setAnnouncement(
        `New message from ${data.message.author.username}: ${data.message.content}`
      );
    });
    return unsubscribe;
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {announcement}
    </div>
  );
}

// Skip to main content link
function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4
                 bg-indigo-500 text-white px-4 py-2 rounded z-50"
    >
      Skip to main content
    </a>
  );
}
```

---

## Step 11: Performance Optimizations

```typescript
// Memoization for expensive computations
const groupedMessages = useMemo(
  () => groupMessagesByAuthor(messages),
  [messages]
);

// Debounced search input
const [searchQuery, setSearchQuery] = useState('');
const debouncedSearch = useDebouncedValue(searchQuery, 300);

useEffect(() => {
  if (debouncedSearch) {
    searchMessages(debouncedSearch);
  }
}, [debouncedSearch]);

// Lazy loading components
const EmojiPicker = lazy(() => import('./EmojiPicker'));
const GifPicker = lazy(() => import('./GifPicker'));
const UserProfile = lazy(() => import('./UserProfile'));

function MessageInput() {
  const [showEmoji, setShowEmoji] = useState(false);

  return (
    <>
      <button onClick={() => setShowEmoji(true)}>Emoji</button>
      {showEmoji && (
        <Suspense fallback={<LoadingSpinner />}>
          <EmojiPicker onSelect={handleEmoji} />
        </Suspense>
      )}
    </>
  );
}

// Image lazy loading
function MessageAttachment({ url, alt }: { url: string; alt: string }) {
  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      decoding="async"
      className="max-w-md rounded-lg"
    />
  );
}

// Preload critical resources
function preloadChannelData(channelId: string) {
  // Preload messages when hovering channel link
  const queryClient = useQueryClient();
  queryClient.prefetchQuery({
    queryKey: ['messages', channelId],
    queryFn: () => fetchMessages(channelId),
    staleTime: 30000,
  });
}
```

---

## Summary

"To summarize my Discord frontend design:

1. **Component Architecture**: Modular components organized by feature (chat, layout, presence)
2. **State Management**: Zustand stores for auth, messages, presence with optimistic updates
3. **Real-Time**: WebSocket client with automatic reconnection and message queuing
4. **Virtualization**: TanStack Virtual for efficient rendering of large message lists
5. **Accessibility**: Keyboard navigation, ARIA labels, live regions for screen readers

The key frontend insights are:
- Optimistic updates are essential for a responsive chat experience
- Message grouping by author reduces visual clutter and improves readability
- Virtualization is critical when channels have thousands of messages
- WebSocket reconnection with exponential backoff provides resilience
- Typing indicators require debouncing to avoid excessive network traffic

What aspects would you like me to elaborate on?"
