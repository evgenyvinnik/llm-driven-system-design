# WhatsApp - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement

"I'll design the frontend for a real-time messaging platform like WhatsApp that supports one-on-one messaging, group chats, and presence indicators. The key frontend challenges are managing WebSocket connections for real-time updates, building an offline-first architecture with IndexedDB, virtualizing large message lists for performance, and matching WhatsApp's distinctive visual identity with message bubbles, delivery receipts, and typing indicators. Let me start by clarifying requirements."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Conversation List**
   - Display all active conversations with last message preview
   - Show unread message counts as badges
   - Real-time updates when new messages arrive
   - Sort by most recent activity

2. **Chat Interface**
   - Message bubbles with distinctive styling (green outgoing, white incoming)
   - Delivery status indicators (single tick, double tick, blue tick)
   - Typing indicators when other user is composing
   - Online/offline presence status

3. **Message Features**
   - Send/receive text messages in real-time
   - Message reactions with emoji picker
   - Reply-to-message threading
   - Infinite scroll for message history

4. **Offline Support**
   - Queue messages when offline
   - Display cached conversations and messages
   - Sync pending messages on reconnect
   - Clear offline/online status indication

### Non-Functional Requirements

| Requirement | Target | Implementation |
|-------------|--------|----------------|
| **Message List Performance** | 10,000+ messages smooth | Virtualized list rendering |
| **First Contentful Paint** | < 1.5s | Code splitting, service worker |
| **Offline Capability** | Full read, queue writes | PWA + IndexedDB |
| **Real-time Latency** | < 100ms UI update | WebSocket, optimistic updates |
| **Bundle Size** | < 200KB gzipped | Tree shaking, lazy loading |

---

## 2. Component Architecture (8-10 minutes)

### High-Level Component Tree

```
App
├── AuthProvider (session context)
├── WebSocketProvider (connection + message handling)
├── OfflineIndicator (connection status banner)
└── Routes
    ├── LoginPage
    ├── RegisterPage
    └── ChatLayout
        ├── Sidebar
        │   ├── SearchBar
        │   ├── ConversationList (virtualized)
        │   │   └── ConversationItem (badge, preview, avatar)
        │   └── NewChatButton
        └── ChatView
            ├── ChatHeader (name, status, avatar)
            ├── MessageList (virtualized infinite scroll)
            │   └── MessageBubble
            │       ├── MessageContent
            │       ├── MessageStatus (tick marks)
            │       ├── MessageReactions
            │       └── ReactionPicker
            ├── TypingIndicator
            └── MessageInput (compose area)
```

### Core Layout Structure

```tsx
// ChatLayout.tsx - Two-panel responsive layout
function ChatLayout() {
  const { conversationId } = useParams();

  return (
    <div className="flex h-screen bg-whatsapp-chat-bg">
      {/* Sidebar - conversation list */}
      <aside className="w-[30%] min-w-[300px] max-w-[400px] border-r border-gray-200 flex flex-col bg-white">
        <SidebarHeader />
        <SearchBar />
        <ConversationList />
      </aside>

      {/* Main chat area */}
      <main className="flex-1 flex flex-col">
        {conversationId ? (
          <>
            <ChatHeader conversationId={conversationId} />
            <MessageList conversationId={conversationId} />
            <TypingIndicator conversationId={conversationId} />
            <MessageInput conversationId={conversationId} />
          </>
        ) : (
          <EmptyState />
        )}
      </main>
    </div>
  );
}
```

---

## 3. Deep Dive: WhatsApp Brand Styling (6-7 minutes)

### Color Palette

```css
:root {
  /* Primary brand colors */
  --whatsapp-primary: #25D366;      /* Logo, accents */
  --whatsapp-teal-dark: #008069;    /* Header background */
  --whatsapp-teal-light: #00A884;   /* Active states */

  /* Message bubbles */
  --whatsapp-outgoing: #DCF8C6;     /* Sent message bubbles */
  --whatsapp-incoming: #FFFFFF;     /* Received message bubbles */
  --whatsapp-chat-bg: #ECE5DD;      /* Chat background */

  /* Text colors */
  --whatsapp-text-primary: #111B21;
  --whatsapp-text-secondary: #667781;
  --whatsapp-read-receipt: #53BDEB; /* Blue double-tick */
}
```

### Message Bubble Component

```tsx
// MessageBubble.tsx - Distinctive WhatsApp styling
interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  showTail: boolean; // First message in sequence from this sender
}

function MessageBubble({ message, isOwn, showTail }: MessageBubbleProps) {
  return (
    <div className={cn(
      'flex',
      isOwn ? 'justify-end' : 'justify-start'
    )}>
      <div className={cn(
        'relative max-w-[65%] px-[9px] py-[6px] rounded-lg',
        'shadow-sm',
        isOwn
          ? 'bg-[#DCF8C6] rounded-tr-none'
          : 'bg-white rounded-tl-none'
      )}>
        {/* Bubble tail */}
        {showTail && (
          <div className={cn(
            'absolute top-0 w-3 h-3',
            isOwn
              ? '-right-3 border-l-[12px] border-l-[#DCF8C6]'
              : '-left-3 border-r-[12px] border-r-white',
            'border-t-[6px] border-t-transparent',
            'border-b-[6px] border-b-transparent'
          )} />
        )}

        {/* Message content */}
        <p className="text-[14.2px] text-[#111B21] break-words">
          {message.content}
        </p>

        {/* Footer: timestamp + status */}
        <div className="flex items-center justify-end gap-1 mt-1">
          <span className="text-[11px] text-[#667781]">
            {formatTime(message.createdAt)}
          </span>
          {isOwn && <MessageStatus status={message.status} />}
        </div>

        {/* Reactions */}
        {message.reactions?.length > 0 && (
          <MessageReactions reactions={message.reactions} />
        )}
      </div>
    </div>
  );
}
```

### Delivery Status Indicators

```tsx
// MessageStatus.tsx - Tick marks with proper colors
type Status = 'sending' | 'sent' | 'delivered' | 'read';

function MessageStatus({ status }: { status: Status }) {
  const iconClass = status === 'read'
    ? 'text-[#53BDEB]'  // Blue for read
    : 'text-[#667781]'; // Gray for others

  return (
    <span className={cn('inline-flex', iconClass)}>
      {status === 'sending' && <ClockIcon className="w-4 h-4" />}
      {status === 'sent' && <SingleCheckIcon className="w-4 h-4" />}
      {status === 'delivered' && <DoubleCheckIcon className="w-4 h-4" />}
      {status === 'read' && <DoubleCheckIcon className="w-4 h-4" />}
    </span>
  );
}

// SVG Icons
function SingleCheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 15" fill="currentColor">
      <path d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666
        9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0
        0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32
        1.266c.143.14.361.125.484-.033l6.272-8.048a.366.366
        0 0 0-.064-.512z" />
    </svg>
  );
}

function DoubleCheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 15" fill="currentColor">
      <path d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666
        9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0
        0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32
        1.266c.143.14.361.125.484-.033l6.272-8.048a.366.366
        0 0 0-.064-.512z" />
      <path d="M10.893 8.162l-.478-.372a.365.365 0 0 0-.51.063L4.549
        14.725a.32.32 0 0 1-.484.033L.233 11.02a.365.365 0 0
        0-.522-.001l-.38.37a.365.365 0 0 0 .001.522l4.307
        4.21c.143.14.361.125.484-.033l6.84-8.784a.366.366
        0 0 0-.07-.512z" />
    </svg>
  );
}
```

### Typing Indicator

```tsx
// TypingIndicator.tsx - Animated dots
function TypingIndicator({ typingUsers }: { typingUsers: string[] }) {
  if (typingUsers.length === 0) return null;

  const text = typingUsers.length === 1
    ? `${typingUsers[0]} is typing`
    : `${typingUsers.slice(0, 2).join(', ')} are typing`;

  return (
    <div className="px-4 py-2 text-sm text-[#00A884] italic flex items-center gap-2">
      <span>{text}</span>
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-2 h-2 bg-[#00A884] rounded-full animate-bounce"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </span>
    </div>
  );
}
```

---

## 4. Deep Dive: WebSocket Real-Time Communication (6-7 minutes)

### WebSocket Provider

```tsx
// WebSocketProvider.tsx - Connection management
interface WebSocketContextType {
  isConnected: boolean;
  sendMessage: (msg: OutgoingMessage) => void;
  sendTyping: (conversationId: string) => void;
  sendReadReceipt: (conversationId: string, messageId: string) => void;
}

function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(`ws://${window.location.host}/ws`);
      socketRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        reconnectAttempts.current = 0;

        // Sync pending messages from offline queue
        syncPendingMessages();
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleIncomingMessage(message);
      };

      ws.onclose = () => {
        setIsConnected(false);
        // Exponential backoff reconnect
        const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30000);
        reconnectAttempts.current++;
        setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();
    return () => socketRef.current?.close();
  }, []);

  function handleIncomingMessage(msg: IncomingWSMessage) {
    switch (msg.type) {
      case 'message':
        chatStore.addMessage(msg.payload);
        // Auto-send delivery receipt
        sendDeliveryReceipt(msg.payload.conversationId, msg.payload.id);
        break;

      case 'message_status':
        chatStore.updateMessageStatus(
          msg.payload.messageId,
          msg.payload.status
        );
        break;

      case 'typing':
        chatStore.setTypingUser(
          msg.payload.conversationId,
          msg.payload.userId,
          msg.payload.isTyping
        );
        break;

      case 'presence':
        chatStore.updateUserPresence(
          msg.payload.userId,
          msg.payload.status,
          msg.payload.lastSeen
        );
        break;

      case 'reaction_update':
        chatStore.updateReactions(
          msg.payload.messageId,
          msg.payload.reactions
        );
        break;
    }
  }

  // ... context value and provider
}
```

### Optimistic Updates with Rollback

```tsx
// useSendMessage.ts - Optimistic UI pattern
function useSendMessage(conversationId: string) {
  const socket = useWebSocket();

  async function sendMessage(content: string) {
    const clientMessageId = crypto.randomUUID();

    // 1. Optimistically add to UI
    const optimisticMessage: Message = {
      id: clientMessageId,
      conversationId,
      content,
      senderId: currentUser.id,
      status: 'sending',
      createdAt: new Date().toISOString(),
    };

    chatStore.addMessage(optimisticMessage);

    // 2. Queue for offline if disconnected
    if (!socket.isConnected) {
      await offlineDb.queueMessage({
        clientMessageId,
        conversationId,
        content,
        status: 'pending',
        createdAt: Date.now(),
        retryCount: 0,
      });
      return;
    }

    // 3. Send via WebSocket
    try {
      socket.sendMessage({
        type: 'message',
        payload: { conversationId, content, clientMessageId }
      });
    } catch (error) {
      // Rollback on failure
      chatStore.updateMessageStatus(clientMessageId, 'failed');
    }
  }

  return { sendMessage };
}
```

### Typing Indicator Debouncing

```tsx
// useTypingIndicator.ts - Debounced typing events
function useTypingIndicator(conversationId: string) {
  const socket = useWebSocket();
  const lastTypingSent = useRef(0);
  const TYPING_INTERVAL = 2000; // Send at most every 2 seconds

  const handleInput = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSent.current >= TYPING_INTERVAL) {
      socket.sendTyping(conversationId);
      lastTypingSent.current = now;
    }
  }, [conversationId, socket]);

  return { handleInput };
}
```

---

## 5. Deep Dive: Virtualized Message List (5-6 minutes)

### Why Virtualization?

| Messages | DOM Nodes (No Virtualization) | DOM Nodes (Virtualized) |
|----------|-------------------------------|-------------------------|
| 100 | ~100 | ~15 |
| 1,000 | ~1,000 (lag) | ~15 |
| 10,000 | ~10,000 (crash) | ~15 |

### Implementation with TanStack Virtual

```tsx
// MessageList.tsx - Virtualized infinite scroll
function MessageList({ conversationId }: { conversationId: string }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { messages, hasMore, isLoading, loadMore } = useMessages(conversationId);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60, // Estimated message height
    overscan: 5, // Render 5 extra items above/below viewport
    getItemKey: (index) => messages[index].id,
  });

  // Infinite scroll - load more when near top
  useEffect(() => {
    const scrollElement = parentRef.current;
    if (!scrollElement) return;

    const handleScroll = () => {
      if (scrollElement.scrollTop < 100 && hasMore && !isLoading) {
        loadMore();
      }
    };

    scrollElement.addEventListener('scroll', handleScroll);
    return () => scrollElement.removeEventListener('scroll', handleScroll);
  }, [hasMore, isLoading, loadMore]);

  // Auto-scroll to bottom on new messages
  const prevMessageCount = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevMessageCount.current) {
      virtualizer.scrollToIndex(messages.length - 1, { behavior: 'smooth' });
    }
    prevMessageCount.current = messages.length;
  }, [messages.length, virtualizer]);

  return (
    <div
      ref={parentRef}
      className="flex-1 overflow-y-auto bg-[#ECE5DD] px-4"
      style={{
        backgroundImage: 'url(/chat-bg-pattern.png)',
        backgroundRepeat: 'repeat',
      }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const message = messages[virtualItem.index];
          const prevMessage = messages[virtualItem.index - 1];
          const showTail = !prevMessage || prevMessage.senderId !== message.senderId;

          return (
            <div
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <MessageBubble
                message={message}
                isOwn={message.senderId === currentUser.id}
                showTail={showTail}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

### Scroll Position Preservation

```tsx
// useScrollPreservation.ts - Maintain position during prepend
function useScrollPreservation(
  scrollRef: RefObject<HTMLDivElement>,
  messages: Message[]
) {
  const prevFirstMessage = useRef<string | null>(null);
  const prevScrollHeight = useRef(0);

  // Before loading more
  const saveScrollPosition = useCallback(() => {
    const el = scrollRef.current;
    if (el && messages.length > 0) {
      prevFirstMessage.current = messages[0].id;
      prevScrollHeight.current = el.scrollHeight;
    }
  }, [messages, scrollRef]);

  // After messages prepended
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prevFirstMessage.current) {
      const heightDiff = el.scrollHeight - prevScrollHeight.current;
      el.scrollTop += heightDiff;
      prevFirstMessage.current = null;
    }
  }, [messages, scrollRef]);

  return { saveScrollPosition };
}
```

---

## 6. Deep Dive: Offline-First Architecture (5-6 minutes)

### IndexedDB Schema with Dexie

```typescript
// database.ts - Local storage schema
import Dexie, { Table } from 'dexie';

interface PendingMessage {
  clientMessageId: string;
  conversationId: string;
  content: string;
  status: 'pending' | 'sending' | 'failed';
  createdAt: number;
  retryCount: number;
}

interface CachedMessage {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  status: string;
  createdAt: string;
  cachedAt: number;
}

interface CachedConversation {
  id: string;
  name: string | null;
  type: 'direct' | 'group';
  lastMessagePreview: string;
  lastMessageAt: string;
  unreadCount: number;
  cachedAt: number;
}

class WhatsAppDatabase extends Dexie {
  pendingMessages!: Table<PendingMessage, string>;
  messages!: Table<CachedMessage, string>;
  conversations!: Table<CachedConversation, string>;

  constructor() {
    super('WhatsAppDB');

    this.version(1).stores({
      pendingMessages: 'clientMessageId, conversationId, status, createdAt',
      messages: 'id, conversationId, createdAt, [conversationId+createdAt]',
      conversations: 'id, lastMessageAt',
    });
  }
}

export const db = new WhatsAppDatabase();
```

### Offline Sync Service

```typescript
// offlineSync.ts - Message queue and cache
class OfflineSyncService {
  private syncInProgress = false;

  // Queue message for offline sending
  async queueMessage(message: PendingMessage): Promise<void> {
    await db.pendingMessages.add(message);
  }

  // Sync pending messages when back online
  async syncPendingMessages(socket: WebSocket): Promise<void> {
    if (this.syncInProgress) return;
    this.syncInProgress = true;

    try {
      const pending = await db.pendingMessages
        .where('status')
        .equals('pending')
        .toArray();

      for (const msg of pending) {
        try {
          // Update status to sending
          await db.pendingMessages.update(msg.clientMessageId, {
            status: 'sending'
          });

          // Send via WebSocket
          socket.send(JSON.stringify({
            type: 'message',
            payload: {
              conversationId: msg.conversationId,
              content: msg.content,
              clientMessageId: msg.clientMessageId,
            }
          }));

          // Remove from queue on success
          await db.pendingMessages.delete(msg.clientMessageId);

        } catch (error) {
          // Increment retry count
          const newRetryCount = msg.retryCount + 1;
          if (newRetryCount >= 3) {
            await db.pendingMessages.update(msg.clientMessageId, {
              status: 'failed',
              retryCount: newRetryCount,
            });
          } else {
            await db.pendingMessages.update(msg.clientMessageId, {
              status: 'pending',
              retryCount: newRetryCount,
            });
          }
        }
      }
    } finally {
      this.syncInProgress = false;
    }
  }

  // Cache messages on fetch
  async cacheMessages(messages: Message[]): Promise<void> {
    const cached = messages.map(msg => ({
      ...msg,
      cachedAt: Date.now(),
    }));
    await db.messages.bulkPut(cached);
  }

  // Get cached messages when offline
  async getCachedMessages(conversationId: string): Promise<CachedMessage[]> {
    return db.messages
      .where('conversationId')
      .equals(conversationId)
      .reverse()
      .limit(50)
      .toArray();
  }

  // Prune old cached data
  async pruneOldData(maxAgeDays: number = 7): Promise<void> {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

    await db.messages
      .where('cachedAt')
      .below(cutoff)
      .delete();

    await db.conversations
      .where('cachedAt')
      .below(cutoff)
      .delete();
  }
}

export const offlineSync = new OfflineSyncService();
```

### Online/Offline Status Hook

```tsx
// useOnlineStatus.ts - Browser connectivity detection
function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      if (!navigator.onLine) {
        setWasOffline(true);
        // Auto-dismiss "back online" message after 3 seconds
        setTimeout(() => setWasOffline(false), 3000);
      }
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return { isOnline, wasOffline };
}

// OfflineIndicator.tsx - Visual feedback
function OfflineIndicator() {
  const { isOnline, wasOffline } = useOnlineStatus();

  if (isOnline && !wasOffline) return null;

  return (
    <div className={cn(
      'fixed top-0 left-0 right-0 py-2 px-4 text-center text-white z-50',
      isOnline ? 'bg-green-600' : 'bg-red-600'
    )}>
      {isOnline
        ? 'Back online!'
        : "You're offline. Messages will be sent when you reconnect."
      }
    </div>
  );
}
```

---

## 7. State Management with Zustand (4-5 minutes)

### Chat Store

```typescript
// chatStore.ts - Global messaging state
interface ChatState {
  // Conversations
  conversations: Conversation[];
  activeConversationId: string | null;

  // Messages per conversation
  messagesByConversation: Record<string, Message[]>;
  paginationState: Record<string, { hasMore: boolean; loading: boolean }>;

  // Real-time state
  typingUsers: Record<string, string[]>; // conversationId -> usernames
  userPresence: Record<string, { status: string; lastSeen: string }>;

  // Actions
  setActiveConversation: (id: string) => void;
  addMessage: (message: Message) => void;
  updateMessageStatus: (messageId: string, status: string) => void;
  setTypingUser: (conversationId: string, userId: string, isTyping: boolean) => void;
  updateUserPresence: (userId: string, status: string, lastSeen: string) => void;
  updateReactions: (messageId: string, reactions: ReactionSummary[]) => void;
  loadMoreMessages: (conversationId: string, beforeId: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messagesByConversation: {},
  paginationState: {},
  typingUsers: {},
  userPresence: {},

  setActiveConversation: (id) => set({ activeConversationId: id }),

  addMessage: (message) => set((state) => {
    const convId = message.conversationId;
    const existing = state.messagesByConversation[convId] || [];

    // Check for duplicate (optimistic update + server response)
    const isDuplicate = existing.some(m =>
      m.id === message.id || m.id === message.clientMessageId
    );

    if (isDuplicate) {
      // Update existing message (e.g., add server ID, update status)
      return {
        messagesByConversation: {
          ...state.messagesByConversation,
          [convId]: existing.map(m =>
            m.id === message.clientMessageId ? { ...m, ...message } : m
          ),
        },
      };
    }

    return {
      messagesByConversation: {
        ...state.messagesByConversation,
        [convId]: [...existing, message].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        ),
      },
    };
  }),

  updateMessageStatus: (messageId, status) => set((state) => {
    const updated = { ...state.messagesByConversation };

    for (const convId in updated) {
      updated[convId] = updated[convId].map(msg =>
        msg.id === messageId ? { ...msg, status } : msg
      );
    }

    return { messagesByConversation: updated };
  }),

  setTypingUser: (conversationId, userId, isTyping) => set((state) => {
    const current = state.typingUsers[conversationId] || [];
    const updated = isTyping
      ? [...new Set([...current, userId])]
      : current.filter(id => id !== userId);

    return {
      typingUsers: {
        ...state.typingUsers,
        [conversationId]: updated,
      },
    };
  }),

  updateUserPresence: (userId, status, lastSeen) => set((state) => ({
    userPresence: {
      ...state.userPresence,
      [userId]: { status, lastSeen },
    },
  })),

  updateReactions: (messageId, reactions) => set((state) => {
    const updated = { ...state.messagesByConversation };

    for (const convId in updated) {
      updated[convId] = updated[convId].map(msg =>
        msg.id === messageId ? { ...msg, reactions } : msg
      );
    }

    return { messagesByConversation: updated };
  }),

  loadMoreMessages: async (conversationId, beforeId) => {
    const state = get();
    const pagination = state.paginationState[conversationId];

    if (pagination?.loading || pagination?.hasMore === false) return;

    set((s) => ({
      paginationState: {
        ...s.paginationState,
        [conversationId]: { ...pagination, loading: true },
      },
    }));

    try {
      const response = await api.getMessages(conversationId, { beforeId, limit: 50 });

      set((s) => ({
        messagesByConversation: {
          ...s.messagesByConversation,
          [conversationId]: [
            ...response.messages,
            ...(s.messagesByConversation[conversationId] || []),
          ],
        },
        paginationState: {
          ...s.paginationState,
          [conversationId]: {
            loading: false,
            hasMore: response.messages.length === 50,
          },
        },
      }));

      // Cache for offline
      await offlineSync.cacheMessages(response.messages);

    } catch (error) {
      set((s) => ({
        paginationState: {
          ...s.paginationState,
          [conversationId]: { ...pagination, loading: false },
        },
      }));
    }
  },
}));
```

---

## 8. PWA Configuration (3-4 minutes)

### Vite PWA Setup

```typescript
// vite.config.ts
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'WhatsApp Clone',
        short_name: 'WhatsApp',
        description: 'Real-time messaging platform',
        theme_color: '#008069',
        background_color: '#111b21',
        display: 'standalone',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\..*\/conversations/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'conversations-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 86400, // 24 hours
              },
            },
          },
          {
            urlPattern: /^https:\/\/api\..*\/messages/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'messages-cache',
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 86400,
              },
            },
          },
        ],
      },
    }),
  ],
});
```

### Service Worker Registration

```tsx
// main.tsx - PWA registration with update prompt
import { registerSW } from 'virtual:pwa-register';

const updateSW = registerSW({
  onNeedRefresh() {
    // Show update prompt to user
    if (confirm('New version available. Reload to update?')) {
      updateSW(true);
    }
  },
  onOfflineReady() {
    console.log('App ready to work offline');
  },
});
```

---

## 9. Trade-offs and Alternatives (3-4 minutes)

### State Management

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Zustand** | Simple, lightweight (2KB), no boilerplate | Less structured for complex apps | **Chosen** |
| Redux Toolkit | Mature, DevTools, middleware | More boilerplate, larger bundle | Overkill for this scope |
| Jotai/Recoil | Atomic updates, fine-grained | Newer, less ecosystem | Good alternative |

### Virtualization

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **TanStack Virtual** | Headless, flexible, dynamic heights | Manual integration | **Chosen** |
| react-window | Simple API, battle-tested | Fixed heights only | Doesn't fit message bubbles |
| react-virtuoso | Built-in infinite scroll | Larger bundle | Good alternative |

### Offline Storage

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Dexie (IndexedDB)** | Type-safe, promise-based, powerful queries | Learning curve | **Chosen** |
| localForage | Simple key-value API | Limited querying | Too simple for messages |
| Native IndexedDB | No dependencies | Verbose, callback-based | Dexie wraps this better |

### Real-Time Communication

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Native WebSocket** | Full control, lightweight | Manual reconnection | **Chosen** |
| Socket.IO | Auto-reconnect, rooms, fallbacks | Larger bundle, server required | Overkill for native WS |
| Ably/Pusher | Managed, scalable | Cost at scale, vendor lock-in | For production at scale |

---

## 10. Accessibility (2-3 minutes)

### Key Accessibility Features

```tsx
// Keyboard navigation for message list
function MessageList() {
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowUp':
        setFocusedIndex(prev => Math.max(0, prev - 1));
        break;
      case 'ArrowDown':
        setFocusedIndex(prev => Math.min(messages.length - 1, prev + 1));
        break;
      case 'Enter':
        // Open reaction picker or reply
        break;
    }
  };

  return (
    <div role="log" aria-label="Message history" onKeyDown={handleKeyDown}>
      {messages.map((msg, i) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          tabIndex={focusedIndex === i ? 0 : -1}
          aria-label={`Message from ${msg.senderName}: ${msg.content}`}
        />
      ))}
    </div>
  );
}

// Screen reader announcements for new messages
function useMessageAnnouncements() {
  const prevCount = useRef(0);
  const messages = useChatStore(s => s.messagesByConversation[s.activeConversationId!]);

  useEffect(() => {
    if (messages.length > prevCount.current) {
      const newMsg = messages[messages.length - 1];
      announce(`New message from ${newMsg.senderName}`);
    }
    prevCount.current = messages.length;
  }, [messages]);
}

// Live region for announcements
function announce(message: string) {
  const el = document.getElementById('sr-announcements');
  if (el) el.textContent = message;
}
```

### ARIA Patterns

```tsx
// Conversation list as listbox
<ul role="listbox" aria-label="Conversations">
  {conversations.map(conv => (
    <li
      key={conv.id}
      role="option"
      aria-selected={conv.id === activeId}
      aria-label={`${conv.name}, ${conv.unreadCount} unread messages`}
    >
      <ConversationItem conversation={conv} />
    </li>
  ))}
</ul>

// Status indicators
<span
  className="text-[#53BDEB]"
  aria-label="Message read"
  role="img"
>
  <DoubleCheckIcon />
</span>
```

---

## Summary

The WhatsApp frontend design addresses these key challenges:

1. **Real-Time Updates**: WebSocket provider with automatic reconnection, message handlers for all event types, and optimistic UI updates for instant feedback

2. **WhatsApp Brand Styling**: Authentic color palette, distinctive message bubbles with tails, delivery status tick marks, and typing indicators

3. **Performance at Scale**: TanStack Virtual for message list virtualization, supporting 10,000+ messages with only ~15 DOM nodes rendered

4. **Offline-First**: PWA with service worker, IndexedDB for message caching, offline message queue with retry logic

5. **State Management**: Zustand store with normalized message storage, real-time typing/presence state, and pagination tracking

The architecture supports the core messaging experience while maintaining performance and providing a seamless offline experience.
