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
┌─────────────────────────────────────────────────────────────────────────────┐
│                           React Application                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────────────┐   │
│   │  Conversation   │   │     Message     │   │        Composer         │   │
│   │      List       │   │     Thread      │   │                         │   │
│   │                 │   │                 │   │   Text Input            │   │
│   │   Badge         │   │   Messages      │   │   Attachments           │   │
│   │   Preview       │   │   Receipts      │   │   Send Button           │   │
│   │   Timestamp     │   │   Typing        │   │                         │   │
│   └─────────────────┘   └─────────────────┘   └─────────────────────────┘   │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                        State Management (Zustand)                            │
│   ┌───────────────┐   ┌───────────────┐   ┌───────────────────────────────┐ │
│   │ Conversation  │   │    Message    │   │         Encryption            │ │
│   │    Store      │   │     Store     │   │           Store               │ │
│   │               │   │               │   │                               │ │
│   │  List         │   │  Messages     │   │   Identity Key                │ │
│   │  Selected     │   │  Pending      │   │   Prekeys                     │ │
│   │  Unread       │   │  Receipts     │   │   Session Keys                │ │
│   └───────────────┘   └───────────────┘   └───────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│                           Service Layer                                      │
│   ┌────────────────┐   ┌────────────────┐   ┌────────────────────────────┐  │
│   │   WebSocket    │   │     Crypto     │   │          Sync              │  │
│   │    Manager     │   │    Service     │   │         Service            │  │
│   └────────────────┘   └────────────────┘   └────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│                       Offline Storage (IndexedDB)                            │
│          Messages │ Conversations │ Keys │ Pending Queue                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Frontend Components

1. **Conversation List**: Virtualized list of chats with real-time updates
2. **Message Thread**: Scrollable message view with encryption/decryption
3. **Composer**: Input with attachment support and send state
4. **Crypto Service**: Web Crypto API wrapper for E2E encryption

---

## Deep Dive: Message Thread Component (8 minutes)

### Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      MessageThread                               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   Virtualized List                         │  │
│  │   (@tanstack/react-virtual)                                │  │
│  │                                                            │  │
│  │   ┌─────────────────────────────────────────────────────┐  │  │
│  │   │  MessageBubble                                      │  │  │
│  │   │   Content (decrypted) ──▶ Timestamp ──▶ Status     │  │  │
│  │   └─────────────────────────────────────────────────────┘  │  │
│  │                          ...                               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    TypingIndicator                         │  │
│  │   Bouncing dots + "X is typing..."                        │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Message Thread Behavior

The MessageThread component uses **@tanstack/react-virtual** for virtualization with these key behaviors:

- **Estimate Size**: 72px per message with 5 items overscan
- **Stick to Bottom**: New messages scroll into view automatically
- **Load on Scroll**: Scrolling to top triggers `loadMore` for older messages
- **ARIA Support**: `role="log"` with `aria-live="polite"` for accessibility

### Message Bubble States

```
┌────────────────────────────────────────────────────────────────┐
│                    Message Delivery States                      │
├────────────────┬───────────────────────────────────────────────┤
│    pending     │  Clock icon (gray) - "Sending"                │
├────────────────┼───────────────────────────────────────────────┤
│      sent      │  Single check (gray) - "Sent"                 │
├────────────────┼───────────────────────────────────────────────┤
│   delivered    │  Double check (gray) - "Delivered"            │
├────────────────┼───────────────────────────────────────────────┤
│      read      │  Double check (blue) - "Read"                 │
└────────────────┴───────────────────────────────────────────────┘
```

### Decryption Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Messages   │────▶│  Decrypt     │────▶│  Cache in    │
│   Array      │     │  Service     │     │  State Map   │
└──────────────┘     └──────────────┘     └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │  Error?      │
                     │  "[Unable    │
                     │  to decrypt]"│
                     └──────────────┘
```

"I decrypt messages on render with caching. Each message ID maps to its plaintext in a Map. Failed decryptions show an error message rather than crashing."

---

## Deep Dive: Client-Side Encryption (8 minutes)

### Encryption Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EncryptionService                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐  │
│   │    Identity Key    │   │      Prekeys       │   │   Session Keys     │  │
│   │    (ECDSA P-256)   │   │   (ECDH P-256)     │   │   (per device)     │  │
│   │                    │   │                    │   │                    │  │
│   │   Sign / Verify    │   │   100 one-time     │   │   Derived shared   │  │
│   │                    │   │   keys             │   │   secrets          │  │
│   └────────────────────┘   └────────────────────┘   └────────────────────┘  │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                              Web Crypto API                                  │
│                                                                              │
│   generateKey() ──▶ deriveBits() ──▶ encrypt() ──▶ wrapKey()               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Generation Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Initialize │────▶│  Load from  │────▶│  Generate   │────▶│   Upload    │
│   Service   │     │  IndexedDB  │     │  if needed  │     │  Public     │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                           │                   │
                           ▼                   ▼
                    ┌─────────────┐     ┌─────────────┐
                    │   Found?    │     │  Identity   │
                    │   Restore   │     │  + 100      │
                    │   Keys      │     │  Prekeys    │
                    └─────────────┘     └─────────────┘
```

### X3DH Key Agreement (Sending)

"I implement X3DH (Extended Triple Diffie-Hellman) for forward secrecy. Here's how message encryption works:"

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Message Encryption Flow                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. Generate random AES-256-GCM message key + IV                           │
│                                                                              │
│   2. Encrypt content:                                                        │
│      plaintext ──▶ AES-GCM ──▶ encryptedContent                             │
│                                                                              │
│   3. For each recipient device:                                              │
│                                                                              │
│      ┌──────────────────────────────────────────────────────────────────┐   │
│      │  Generate ephemeral ECDH key pair                                │   │
│      │                                                                   │   │
│      │  DH1: ephemeral_private + recipient_identity_public              │   │
│      │  DH2: ephemeral_private + recipient_prekey_public                │   │
│      │                                                                   │   │
│      │  Combined = DH1 || DH2                                           │   │
│      │  SHA-256(Combined) ──▶ Wrapping Key                              │   │
│      │                                                                   │   │
│      │  AES-KW(message_key, wrapping_key) ──▶ wrapped_key               │   │
│      └──────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   4. Return: { iv, encryptedContent, encryptedKeys[] }                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Secure Key Storage

```
┌─────────────────────────────────────────────────────────────────┐
│                     Key Storage Strategy                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   IndexedDB (imessage database)                                 │
│   ├── keys store                                                 │
│   │   ├── identity: { publicKey, privateKey (PKCS8) }           │
│   │   └── prekeys: Map<number, KeyPair>                         │
│   │                                                              │
│   └── Production enhancement:                                    │
│       Encrypt with device passcode before storing               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Offline-First Architecture (7 minutes)

### IndexedDB Schema

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          IndexedDB: imessage                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────┐   ┌─────────────────────┐                         │
│   │      messages       │   │    conversations    │                         │
│   ├─────────────────────┤   ├─────────────────────┤                         │
│   │  keyPath: id        │   │  keyPath: id        │                         │
│   │                     │   │                     │                         │
│   │  Indexes:           │   │  Fields:            │                         │
│   │  - by-conversation  │   │  - participants     │                         │
│   │  - by-status        │   │  - lastMessage      │                         │
│   │                     │   │  - unreadCount      │                         │
│   └─────────────────────┘   └─────────────────────┘                         │
│                                                                              │
│   ┌─────────────────────┐   ┌─────────────────────┐                         │
│   │    pendingQueue     │   │     syncCursors     │                         │
│   ├─────────────────────┤   ├─────────────────────┤                         │
│   │  keyPath: id        │   │  keyPath:           │                         │
│   │  autoIncrement      │   │  conversationId     │                         │
│   │                     │   │                     │                         │
│   │  Fields:            │   │  Fields:            │                         │
│   │  - type             │   │  - lastMessageId    │                         │
│   │  - data             │   │  - syncedAt         │                         │
│   └─────────────────────┘   └─────────────────────┘                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Optimistic Send Flow

"When a user sends a message, I show it immediately in the UI before the server confirms. This is critical for perceived performance."

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Optimistic Send Flow                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   User clicks Send                                                           │
│          │                                                                   │
│          ▼                                                                   │
│   ┌──────────────┐                                                          │
│   │ 1. Encrypt   │──────▶ Get recipient device keys                         │
│   │    message   │        Run X3DH + AES-GCM                                │
│   └──────────────┘                                                          │
│          │                                                                   │
│          ▼                                                                   │
│   ┌──────────────┐                                                          │
│   │ 2. Create    │──────▶ id: crypto.randomUUID()                           │
│   │  optimistic  │        status: 'pending'                                 │
│   │   message    │        timestamp: now                                    │
│   └──────────────┘                                                          │
│          │                                                                   │
│          ▼                                                                   │
│   ┌──────────────┐                                                          │
│   │ 3. Save to   │──────▶ IndexedDB (user sees message immediately)         │
│   │  IndexedDB   │                                                          │
│   └──────────────┘                                                          │
│          │                                                                   │
│          ▼                                                                   │
│   ┌──────────────┐                                                          │
│   │ 4. Update    │──────▶ Zustand store (triggers re-render)                │
│   │    UI state  │                                                          │
│   └──────────────┘                                                          │
│          │                                                                   │
│          ▼                                                                   │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │  5. Online?                                                          │  │
│   │     ├── Yes ──▶ POST to server ──▶ Success? Update to 'sent'        │  │
│   │     │                          └── Fail? Queue for retry            │  │
│   │     │                                                                │  │
│   │     └── No ──▶ Queue in pendingQueue store                          │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Sync Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                     Conversation Sync                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   For each message from server:                                 │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Existing in IndexedDB?                                 │   │
│   │     ├── Yes ──▶ Update status only (sent→delivered→read)│   │
│   │     └── No ──▶ Save new message to IndexedDB            │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   Update sync cursor:                                           │
│   { conversationId, lastMessageId, syncedAt }                   │
│                                                                  │
│   Refresh UI from IndexedDB                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Online/Offline Handler

```
┌─────────────────────────────────────────────────────────────────┐
│                   Coming Back Online                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   window 'online' event fires                                   │
│          │                                                       │
│          ▼                                                       │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  1. Get all pending operations from pendingQueue        │   │
│   │  2. For each operation:                                 │   │
│   │     ├── send_message ──▶ POST to server                 │   │
│   │     └── Success? Remove from queue                      │   │
│   │  3. Sync all conversations (fetch new messages)         │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: WebSocket Real-Time Updates (5 minutes)

### WebSocket Manager Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         WebSocketManager                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Connection: wss://api.imessage.com/ws?token={sessionToken}                │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                        Message Types                                 │   │
│   ├──────────────────┬──────────────────────────────────────────────────┤   │
│   │   new_message    │  Fetch, decrypt, save to IndexedDB, update UI    │   │
│   │                  │  Send delivery_receipt back                       │   │
│   ├──────────────────┼──────────────────────────────────────────────────┤   │
│   │ delivery_receipt │  Update message status to 'delivered'            │   │
│   ├──────────────────┼──────────────────────────────────────────────────┤   │
│   │   read_receipt   │  Update message status to 'read'                 │   │
│   ├──────────────────┼──────────────────────────────────────────────────┤   │
│   │     typing       │  Update typingUsers in store                     │   │
│   ├──────────────────┼──────────────────────────────────────────────────┤   │
│   │      ping        │  Heartbeat (every 30 seconds)                    │   │
│   └──────────────────┴──────────────────────────────────────────────────┘   │
│                                                                              │
│   Reconnection: Exponential backoff (1s, 2s, 4s... up to 30s)              │
│   Max attempts: 10                                                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Incoming Message Flow

```
new_message event
       │
       ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Fetch     │────▶│   Save to   │────▶│   Update    │────▶│    Send     │
│  message    │     │  IndexedDB  │     │    UI       │     │  delivery   │
│  from API   │     │             │     │   store     │     │  receipt    │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

---

## Accessibility and Responsive Design (3 minutes)

### Keyboard Navigation

| Shortcut | Action |
|----------|--------|
| Escape | Go back to conversation list |
| Cmd/Ctrl + Enter | Send message |
| Up/Down arrows | Navigate history (in composer) |

### Responsive Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Desktop Layout                                      │
│                                                                              │
│   ┌───────────────────┐   ┌───────────────────────────────────────────────┐ │
│   │  Conversation     │   │                                                │ │
│   │  List             │   │              Message Thread                    │ │
│   │  (w-80, 320px)    │   │              + Composer                        │ │
│   │                   │   │              (flex-1)                          │ │
│   └───────────────────┘   └───────────────────────────────────────────────┘ │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                          Mobile Layout (<768px)                              │
│                                                                              │
│   No conversation selected:     │     Conversation selected:                │
│   ┌─────────────────────────┐   │     ┌─────────────────────────┐           │
│   │  Conversation List      │   │     │  Message Thread         │           │
│   │  (full width)           │   │     │  + Composer             │           │
│   └─────────────────────────┘   │     │  (full width)           │           │
│                                 │     │                         │           │
│                                 │     │  ← Back button          │           │
│                                 │     └─────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs and Alternatives (5 minutes)

### 1. Key Storage Location

| Approach | Pros | Cons |
|----------|------|------|
| **IndexedDB (chosen)** | Persistent, encrypted | Browser-specific, no cross-browser sync |
| localStorage | Simple | Size limits, no structured data |
| WebAuthn/Passkeys | Hardware-backed security | Browser support, UX complexity |

**Decision**: "IndexedDB with encryption. Consider WebAuthn for key protection in future."

### 2. Offline Sync Strategy

| Approach | Pros | Cons |
|----------|------|------|
| **Optimistic + queue (chosen)** | Instant UX | Conflict handling complexity |
| Pessimistic (wait for server) | Simple | Poor offline experience |
| CRDT | Automatic merge | Complex implementation |

**Decision**: "Optimistic updates with pending queue. Messages are append-only, conflicts rare."

### 3. Message Decryption Timing

| Approach | Pros | Cons |
|----------|------|------|
| **On render (chosen)** | Memory efficient | CPU spikes on scroll |
| Pre-decrypt all | Fast scroll | High memory, slow initial load |
| Background worker | Non-blocking | Complexity, worker overhead |

**Decision**: "Decrypt on render with caching. Consider Web Workers for heavy threads."

### 4. Real-Time Updates

| Approach | Pros | Cons |
|----------|------|------|
| **WebSocket (chosen)** | Low latency, bidirectional | Connection management |
| Server-Sent Events | Simpler | One-way only |
| Polling | Simple | Higher latency, more bandwidth |

**Decision**: "WebSocket for real-time delivery and typing indicators."

---

## Closing Summary (1 minute)

"The iMessage frontend is built on three pillars:

1. **Client-Side Encryption** using Web Crypto API with X3DH key agreement, ensuring messages are encrypted before leaving the device and private keys never touch the network.

2. **Offline-First Architecture** with IndexedDB persistence, optimistic updates for instant send UX, and a pending operation queue that syncs when connectivity returns.

3. **Real-Time Experience** via WebSocket with typing indicators, delivery receipts, and automatic reconnection with exponential backoff.

The main trade-off is complexity vs. security. We accept the overhead of client-side encryption because user privacy is non-negotiable. Future improvements would include Web Workers for background decryption and WebAuthn for hardware-backed key protection."
