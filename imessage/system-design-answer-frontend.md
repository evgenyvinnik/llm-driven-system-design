# iMessage - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement (1 minute)

"I'll design iMessage, Apple's end-to-end encrypted messaging platform. As a frontend engineer, I'll focus on the conversation UI with real-time message delivery, client-side encryption workflows, offline-first architecture with IndexedDB persistence, and building responsive multi-device experiences.

The core frontend challenges are: managing encryption key state securely in the browser, implementing optimistic UI updates with reliable sync, and creating a responsive conversation interface that works offline."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Conversation List**: Real-time updates, unread counts, last message preview
- **Message Thread**: Send/receive with delivery and read receipts
- **Typing Indicators**: Real-time typing status
- **Offline Support**: Read messages and queue sends when offline
- **Multi-Device**: Sync across all user devices seamlessly

### Non-Functional Requirements
- **Perceived Latency**: Instant message send (optimistic updates)
- **Offline-First**: Full functionality without network
- **Security**: Private keys never leave device, encryption in Web Crypto API
- **Accessibility**: Screen reader support, keyboard navigation

### Frontend-Specific Questions
1. How do we securely store private keys in the browser?
2. What's the UX for message delivery states (sending, sent, delivered, read)?
3. How do we handle conflicts when syncing across devices?

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                      React Application                           │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────┐   │
│  │  Conversation │  │    Message    │  │     Composer      │   │
│  │     List      │  │    Thread     │  │                   │   │
│  │               │  │               │  │   [Text Input]    │   │
│  │  • Badge      │  │  • Messages   │  │   [Attachments]   │   │
│  │  • Preview    │  │  • Receipts   │  │   [Send Button]   │   │
│  │  • Timestamp  │  │  • Typing     │  │                   │   │
│  └───────────────┘  └───────────────┘  └───────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                     State Management (Zustand)                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │Conversation │  │   Message   │  │      Encryption         │ │
│  │   Store     │  │   Store     │  │        Store            │ │
│  │             │  │             │  │                         │ │
│  │ • List      │  │ • Messages  │  │ • Identity Key          │ │
│  │ • Selected  │  │ • Pending   │  │ • Prekeys               │ │
│  │ • Unread    │  │ • Receipts  │  │ • Session Keys          │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                       Service Layer                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  WebSocket   │  │   Crypto     │  │      Sync            │  │
│  │   Manager    │  │   Service    │  │     Service          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                    Offline Storage (IndexedDB)                   │
│       Messages │ Conversations │ Keys │ Pending Queue           │
└─────────────────────────────────────────────────────────────────┘
```

### Core Frontend Components

1. **Conversation List**: Virtualized list of chats with real-time updates
2. **Message Thread**: Scrollable message view with encryption/decryption
3. **Composer**: Input with attachment support and send state
4. **Crypto Service**: Web Crypto API wrapper for E2E encryption

## Deep Dive: Message Thread Component (8 minutes)

### Component Structure

```tsx
// MessageThread.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMessageStore } from '../stores/messageStore';
import { useEncryptionService } from '../services/encryption';

interface Message {
  id: string;
  senderId: string;
  encryptedContent: string;
  iv: string;
  status: 'pending' | 'sent' | 'delivered' | 'read';
  timestamp: Date;
}

export function MessageThread({ conversationId }: { conversationId: string }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { messages, loadMore, hasMore } = useMessageStore(
    (state) => state.getConversationMessages(conversationId)
  );
  const { decryptMessage } = useEncryptionService();
  const [decryptedMessages, setDecryptedMessages] = useState<Map<string, string>>(new Map());

  // Virtualized list for performance
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 5,
    // Stick to bottom for new messages
    initialOffset: messages.length * 72,
  });

  // Decrypt messages on mount and when new ones arrive
  useEffect(() => {
    const decryptAll = async () => {
      const newDecrypted = new Map(decryptedMessages);

      for (const msg of messages) {
        if (!newDecrypted.has(msg.id) && msg.encryptedContent) {
          try {
            const plaintext = await decryptMessage(msg.encryptedContent, msg.iv);
            newDecrypted.set(msg.id, plaintext);
          } catch (error) {
            console.error('Decryption failed:', msg.id, error);
            newDecrypted.set(msg.id, '[Unable to decrypt]');
          }
        }
      }

      setDecryptedMessages(newDecrypted);
    };

    decryptAll();
  }, [messages]);

  // Load more on scroll to top
  const handleScroll = useCallback(() => {
    const element = parentRef.current;
    if (!element) return;

    if (element.scrollTop < 100 && hasMore) {
      loadMore(conversationId);
    }
  }, [hasMore, conversationId]);

  return (
    <div
      ref={parentRef}
      onScroll={handleScroll}
      className="flex-1 overflow-auto"
      role="log"
      aria-label="Message history"
      aria-live="polite"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const message = messages[virtualRow.index];
          return (
            <MessageBubble
              key={message.id}
              message={message}
              content={decryptedMessages.get(message.id) || ''}
              style={{
                position: 'absolute',
                top: virtualRow.start,
                height: virtualRow.size,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
```

### Message Bubble with Delivery Status

```tsx
// MessageBubble.tsx
interface MessageBubbleProps {
  message: Message;
  content: string;
  style: React.CSSProperties;
}

export function MessageBubble({ message, content, style }: MessageBubbleProps) {
  const currentUserId = useAuthStore((state) => state.userId);
  const isOwn = message.senderId === currentUserId;

  return (
    <div
      style={style}
      className={`flex ${isOwn ? 'justify-end' : 'justify-start'} px-4 py-1`}
    >
      <div
        className={`
          max-w-[70%] rounded-2xl px-4 py-2
          ${isOwn
            ? 'bg-blue-500 text-white rounded-br-sm'
            : 'bg-gray-200 text-gray-900 rounded-bl-sm'
          }
        `}
        role="article"
        aria-label={`Message from ${isOwn ? 'you' : 'contact'}`}
      >
        <p className="break-words">{content}</p>

        <div className="flex items-center justify-end gap-1 mt-1">
          <span className="text-xs opacity-70">
            {formatTime(message.timestamp)}
          </span>

          {isOwn && <DeliveryStatus status={message.status} />}
        </div>
      </div>
    </div>
  );
}

function DeliveryStatus({ status }: { status: Message['status'] }) {
  const statusConfig = {
    pending: { icon: ClockIcon, label: 'Sending', className: 'text-gray-400' },
    sent: { icon: CheckIcon, label: 'Sent', className: 'text-gray-400' },
    delivered: { icon: CheckDoubleIcon, label: 'Delivered', className: 'text-gray-400' },
    read: { icon: CheckDoubleIcon, label: 'Read', className: 'text-blue-300' },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <span className={config.className} aria-label={config.label}>
      <Icon className="w-4 h-4" />
    </span>
  );
}
```

### Typing Indicator

```tsx
// TypingIndicator.tsx
export function TypingIndicator({ conversationId }: { conversationId: string }) {
  const typingUsers = useMessageStore((state) => state.typingUsers[conversationId] || []);

  if (typingUsers.length === 0) return null;

  const text = typingUsers.length === 1
    ? `${typingUsers[0].name} is typing...`
    : `${typingUsers.length} people are typing...`;

  return (
    <div
      className="flex items-center gap-2 px-4 py-2 text-sm text-gray-500"
      aria-live="polite"
    >
      <div className="flex gap-1">
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span>{text}</span>
    </div>
  );
}
```

## Deep Dive: Client-Side Encryption (8 minutes)

### Web Crypto API Service

```typescript
// services/encryption.ts
class EncryptionService {
  private identityKey: CryptoKeyPair | null = null;
  private preKeys: Map<number, CryptoKeyPair> = new Map();
  private sessionKeys: Map<string, CryptoKey> = new Map(); // deviceId -> shared secret

  async initialize() {
    // Try to load from secure storage first
    const storedKeys = await this.loadKeysFromStorage();

    if (storedKeys) {
      this.identityKey = storedKeys.identityKey;
      this.preKeys = storedKeys.preKeys;
    } else {
      // Generate new keys for this device
      await this.generateKeys();
    }
  }

  private async generateKeys() {
    // Generate identity key pair (ECDSA for signing)
    this.identityKey = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, // extractable for backup
      ['sign', 'verify']
    );

    // Generate 100 prekeys (ECDH for key exchange)
    for (let i = 0; i < 100; i++) {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
      );
      this.preKeys.set(i, keyPair);
    }

    // Store in IndexedDB (encrypted with device passphrase)
    await this.saveKeysToStorage();

    // Upload public keys to server
    await this.uploadPublicKeys();
  }

  async encryptMessage(plaintext: string, recipientDevices: DeviceKey[]): Promise<EncryptedMessage> {
    // Generate random message key
    const messageKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    // Generate IV
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Encrypt content
    const encryptedContent = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      messageKey,
      new TextEncoder().encode(plaintext)
    );

    // Wrap message key for each recipient device
    const encryptedKeys: EncryptedKey[] = [];

    for (const device of recipientDevices) {
      const wrappedKey = await this.wrapKeyForDevice(messageKey, device);
      encryptedKeys.push({
        deviceId: device.deviceId,
        encryptedKey: wrappedKey.wrappedKey,
        ephemeralPublicKey: wrappedKey.ephemeralPublicKey,
      });
    }

    return {
      iv: this.arrayBufferToBase64(iv),
      encryptedContent: this.arrayBufferToBase64(encryptedContent),
      encryptedKeys,
    };
  }

  private async wrapKeyForDevice(messageKey: CryptoKey, device: DeviceKey) {
    // X3DH key agreement
    // Generate ephemeral key pair
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );

    // Import recipient's public keys
    const identityKey = await crypto.subtle.importKey(
      'raw',
      this.base64ToArrayBuffer(device.identityPublicKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    const preKey = await crypto.subtle.importKey(
      'raw',
      this.base64ToArrayBuffer(device.preKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    // DH1: ephemeral private + identity public
    const dh1 = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: identityKey },
      ephemeral.privateKey,
      256
    );

    // DH2: ephemeral private + prekey public
    const dh2 = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: preKey },
      ephemeral.privateKey,
      256
    );

    // Combine and derive wrapping key
    const combined = new Uint8Array([...new Uint8Array(dh1), ...new Uint8Array(dh2)]);
    const kdfResult = await crypto.subtle.digest('SHA-256', combined);

    const wrappingKey = await crypto.subtle.importKey(
      'raw',
      kdfResult,
      { name: 'AES-KW' },
      false,
      ['wrapKey']
    );

    // Wrap message key
    const wrappedKey = await crypto.subtle.wrapKey('raw', messageKey, wrappingKey, 'AES-KW');

    // Export ephemeral public key
    const ephemeralPublicKey = await crypto.subtle.exportKey('raw', ephemeral.publicKey);

    return {
      wrappedKey: this.arrayBufferToBase64(wrappedKey),
      ephemeralPublicKey: this.arrayBufferToBase64(ephemeralPublicKey),
    };
  }

  async decryptMessage(encryptedContent: string, iv: string): Promise<string> {
    // Get our device's encrypted key from message
    const messageKey = await this.unwrapMessageKey(/* ... */);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.base64ToArrayBuffer(iv) },
      messageKey,
      this.base64ToArrayBuffer(encryptedContent)
    );

    return new TextDecoder().decode(decrypted);
  }

  // Secure key storage using IndexedDB with key derivation
  private async saveKeysToStorage() {
    const db = await this.openKeyDatabase();

    // Export keys (they're extractable)
    const exportedIdentity = {
      publicKey: await crypto.subtle.exportKey('raw', this.identityKey!.publicKey),
      privateKey: await crypto.subtle.exportKey('pkcs8', this.identityKey!.privateKey),
    };

    // In production, encrypt with device passcode before storing
    await db.put('keys', exportedIdentity, 'identity');
  }
}

export const encryptionService = new EncryptionService();
```

## Deep Dive: Offline-First Architecture (7 minutes)

### IndexedDB Schema

```typescript
// services/offlineStorage.ts
interface OfflineDatabase {
  messages: {
    key: string;
    value: {
      id: string;
      conversationId: string;
      senderId: string;
      encryptedContent: string;
      iv: string;
      status: 'pending' | 'sent' | 'delivered' | 'read';
      timestamp: number;
      syncedAt?: number;
    };
    indexes: {
      'by-conversation': string;
      'by-status': string;
    };
  };
  conversations: {
    key: string;
    value: Conversation;
  };
  pendingQueue: {
    key: string;
    value: PendingOperation;
  };
  syncCursors: {
    key: string;
    value: { conversationId: string; lastMessageId: string; syncedAt: number };
  };
}

class OfflineStorage {
  private db: IDBDatabase | null = null;

  async initialize() {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('imessage', 1);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Messages store
        const messagesStore = db.createObjectStore('messages', { keyPath: 'id' });
        messagesStore.createIndex('by-conversation', 'conversationId');
        messagesStore.createIndex('by-status', 'status');

        // Conversations store
        db.createObjectStore('conversations', { keyPath: 'id' });

        // Pending operations queue
        db.createObjectStore('pendingQueue', { keyPath: 'id', autoIncrement: true });

        // Sync cursors
        db.createObjectStore('syncCursors', { keyPath: 'conversationId' });
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };

      request.onerror = () => reject(request.error);
    });
  }

  async getConversationMessages(conversationId: string): Promise<Message[]> {
    const tx = this.db!.transaction('messages', 'readonly');
    const index = tx.objectStore('messages').index('by-conversation');

    return new Promise((resolve, reject) => {
      const request = index.getAll(conversationId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async saveMessage(message: Message): Promise<void> {
    const tx = this.db!.transaction('messages', 'readwrite');
    const store = tx.objectStore('messages');

    return new Promise((resolve, reject) => {
      const request = store.put(message);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async queuePendingOperation(operation: PendingOperation): Promise<void> {
    const tx = this.db!.transaction('pendingQueue', 'readwrite');
    const store = tx.objectStore('pendingQueue');

    await new Promise<void>((resolve, reject) => {
      const request = store.add(operation);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getPendingOperations(): Promise<PendingOperation[]> {
    const tx = this.db!.transaction('pendingQueue', 'readonly');
    const store = tx.objectStore('pendingQueue');

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

export const offlineStorage = new OfflineStorage();
```

### Optimistic Updates with Sync

```typescript
// stores/messageStore.ts
interface MessageState {
  messages: Map<string, Message[]>;
  pendingMessages: Message[];
  typingUsers: Record<string, User[]>;

  sendMessage: (conversationId: string, content: string) => Promise<void>;
  syncConversation: (conversationId: string) => Promise<void>;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: new Map(),
  pendingMessages: [],
  typingUsers: {},

  sendMessage: async (conversationId: string, content: string) => {
    const userId = useAuthStore.getState().userId;
    const clientMessageId = crypto.randomUUID();

    // 1. Encrypt message
    const recipientDevices = await keyService.getRecipientDevices(conversationId);
    const encrypted = await encryptionService.encryptMessage(content, recipientDevices);

    // 2. Create optimistic local message
    const optimisticMessage: Message = {
      id: clientMessageId,
      conversationId,
      senderId: userId,
      encryptedContent: encrypted.encryptedContent,
      iv: encrypted.iv,
      status: 'pending',
      timestamp: new Date(),
    };

    // 3. Store locally immediately (user sees it)
    await offlineStorage.saveMessage(optimisticMessage);

    // 4. Update UI immediately
    set((state) => {
      const conversationMessages = state.messages.get(conversationId) || [];
      return {
        messages: new Map(state.messages).set(
          conversationId,
          [...conversationMessages, optimisticMessage]
        ),
        pendingMessages: [...state.pendingMessages, optimisticMessage],
      };
    });

    // 5. Try to send to server
    if (navigator.onLine) {
      try {
        const result = await api.sendMessage({
          conversationId,
          clientMessageId,
          ...encrypted,
        });

        // Update status to 'sent'
        await get().updateMessageStatus(clientMessageId, 'sent');
      } catch (error) {
        // Queue for retry
        await offlineStorage.queuePendingOperation({
          type: 'send_message',
          data: { conversationId, clientMessageId, ...encrypted },
        });
      }
    } else {
      // Queue for when online
      await offlineStorage.queuePendingOperation({
        type: 'send_message',
        data: { conversationId, clientMessageId, ...encrypted },
      });
    }
  },

  syncConversation: async (conversationId: string) => {
    const cursor = await offlineStorage.getSyncCursor(conversationId);

    const response = await api.syncMessages(conversationId, cursor);

    for (const message of response.messages) {
      // Check if we already have this message (sent from this device)
      const existing = await offlineStorage.getMessage(message.id);

      if (existing) {
        // Update status only
        await offlineStorage.saveMessage({ ...existing, status: message.status });
      } else {
        // New message from server
        await offlineStorage.saveMessage(message);
      }
    }

    // Update sync cursor
    if (response.messages.length > 0) {
      await offlineStorage.saveSyncCursor({
        conversationId,
        lastMessageId: response.messages[response.messages.length - 1].id,
        syncedAt: Date.now(),
      });
    }

    // Refresh UI from storage
    const messages = await offlineStorage.getConversationMessages(conversationId);
    set((state) => ({
      messages: new Map(state.messages).set(conversationId, messages),
    }));
  },
}));
```

### Online/Offline Handler

```typescript
// hooks/useOnlineStatus.ts
export function useOnlineStatus() {
  const syncPending = useMessageStore((state) => state.syncPending);

  useEffect(() => {
    const handleOnline = async () => {
      console.log('Back online, syncing pending operations...');

      // Flush pending queue
      const pending = await offlineStorage.getPendingOperations();

      for (const operation of pending) {
        try {
          if (operation.type === 'send_message') {
            await api.sendMessage(operation.data);
          }
          await offlineStorage.removePendingOperation(operation.id);
        } catch (error) {
          console.error('Failed to sync operation:', error);
        }
      }

      // Sync all conversations
      const conversations = await offlineStorage.getAllConversations();
      for (const conv of conversations) {
        await syncPending(conv.id);
      }
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [syncPending]);

  return navigator.onLine;
}
```

## Deep Dive: WebSocket Real-Time Updates (5 minutes)

### WebSocket Manager

```typescript
// services/websocket.ts
class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private heartbeatInterval: number | null = null;

  connect(sessionToken: string) {
    this.ws = new WebSocket(`wss://api.imessage.com/ws?token=${sessionToken}`);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.scheduleReconnect(sessionToken);
    };
  }

  private handleMessage(message: WebSocketMessage) {
    switch (message.type) {
      case 'new_message':
        this.handleNewMessage(message.payload);
        break;
      case 'delivery_receipt':
        this.handleDeliveryReceipt(message.payload);
        break;
      case 'read_receipt':
        this.handleReadReceipt(message.payload);
        break;
      case 'typing':
        this.handleTyping(message.payload);
        break;
    }
  }

  private async handleNewMessage(payload: { messageId: string; conversationId: string }) {
    // Fetch and decrypt the message
    const message = await api.getMessage(payload.messageId);

    // Save to local storage
    await offlineStorage.saveMessage(message);

    // Update UI
    useMessageStore.getState().addMessage(payload.conversationId, message);

    // Send delivery receipt
    this.send({
      type: 'delivery_receipt',
      messageId: payload.messageId,
    });
  }

  private handleTyping(payload: { conversationId: string; userId: string; isTyping: boolean }) {
    useMessageStore.getState().setTyping(
      payload.conversationId,
      payload.userId,
      payload.isTyping
    );
  }

  send(message: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  sendTyping(conversationId: string, isTyping: boolean) {
    this.send({
      type: 'typing',
      conversationId,
      isTyping,
    });
  }

  private startHeartbeat() {
    this.heartbeatInterval = window.setInterval(() => {
      this.send({ type: 'ping' });
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
  }

  private scheduleReconnect(sessionToken: string) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      setTimeout(() => {
        this.reconnectAttempts++;
        this.connect(sessionToken);
      }, delay);
    }
  }
}

export const wsManager = new WebSocketManager();
```

## Accessibility and Responsive Design (3 minutes)

### Keyboard Navigation

```tsx
// hooks/useKeyboardNavigation.ts
export function useConversationKeyboard(conversationId: string) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape to go back to conversation list
      if (e.key === 'Escape') {
        useConversationStore.getState().clearSelection();
      }

      // Cmd/Ctrl + Enter to send message
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        document.querySelector<HTMLButtonElement>('[data-send-button]')?.click();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [conversationId]);
}
```

### Responsive Layout

```tsx
// components/MessagingLayout.tsx
export function MessagingLayout() {
  const selectedConversation = useConversationStore((state) => state.selected);
  const isMobile = useMediaQuery('(max-width: 768px)');

  return (
    <div className="flex h-screen">
      {/* Conversation List - hidden on mobile when conversation selected */}
      <aside
        className={`
          w-full md:w-80 border-r border-gray-200
          ${isMobile && selectedConversation ? 'hidden' : 'block'}
        `}
      >
        <ConversationList />
      </aside>

      {/* Message Thread - full width on mobile */}
      <main
        className={`
          flex-1 flex flex-col
          ${isMobile && !selectedConversation ? 'hidden' : 'block'}
        `}
      >
        {selectedConversation ? (
          <>
            <ConversationHeader />
            <MessageThread conversationId={selectedConversation} />
            <MessageComposer conversationId={selectedConversation} />
          </>
        ) : (
          <EmptyState message="Select a conversation to start messaging" />
        )}
      </main>
    </div>
  );
}
```

## Trade-offs and Alternatives (5 minutes)

### 1. Key Storage Location

| Approach | Pros | Cons |
|----------|------|------|
| **IndexedDB (chosen)** | Persistent, encrypted | Browser-specific, no cross-browser sync |
| localStorage | Simple | Size limits, no structured data |
| WebAuthn/Passkeys | Hardware-backed security | Browser support, UX complexity |

**Decision**: IndexedDB with encryption. Consider WebAuthn for key protection in future.

### 2. Offline Sync Strategy

| Approach | Pros | Cons |
|----------|------|------|
| **Optimistic + queue (chosen)** | Instant UX | Conflict handling complexity |
| Pessimistic (wait for server) | Simple | Poor offline experience |
| CRDT | Automatic merge | Complex implementation |

**Decision**: Optimistic updates with pending queue. Messages are append-only, conflicts rare.

### 3. Message Decryption Timing

| Approach | Pros | Cons |
|----------|------|------|
| **On render (chosen)** | Memory efficient | CPU spikes on scroll |
| Pre-decrypt all | Fast scroll | High memory, slow initial load |
| Background worker | Non-blocking | Complexity, worker overhead |

**Decision**: Decrypt on render with caching. Consider Web Workers for heavy threads.

### 4. Real-Time Updates

| Approach | Pros | Cons |
|----------|------|------|
| **WebSocket (chosen)** | Low latency, bidirectional | Connection management |
| Server-Sent Events | Simpler | One-way only |
| Polling | Simple | Higher latency, more bandwidth |

**Decision**: WebSocket for real-time delivery and typing indicators.

## Closing Summary (1 minute)

"The iMessage frontend is built on three pillars:

1. **Client-Side Encryption** using Web Crypto API with X3DH key agreement, ensuring messages are encrypted before leaving the device and private keys never touch the network.

2. **Offline-First Architecture** with IndexedDB persistence, optimistic updates for instant send UX, and a pending operation queue that syncs when connectivity returns.

3. **Real-Time Experience** via WebSocket with typing indicators, delivery receipts, and automatic reconnection with exponential backoff.

The main trade-off is complexity vs. security. We accept the overhead of client-side encryption because user privacy is non-negotiable. Future improvements would include Web Workers for background decryption and WebAuthn for hardware-backed key protection."
