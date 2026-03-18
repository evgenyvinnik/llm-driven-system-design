# Discord (Real-Time Chat System) - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

---

## Introduction

"Today I'll design a real-time chat system similar to Discord from a frontend perspective. I'll focus on the component architecture, real-time message handling, state management with Zustand, WebSocket/SSE integration, and building a responsive Discord-like UI with Tailwind CSS. The core challenge is creating a seamless real-time experience that handles thousands of messages efficiently."

---

## 📋 Step 1: Requirements Clarification

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

## 🏗️ Step 2: Component Architecture

### Application Structure

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              App Shell                                        │
├────────┬─────────────────────────────────────────────────────────────────────┤
│ Server │                     Channels Layout                                  │
│  List  ├──────────────────┬──────────────────────────────────────────────────┤
│        │ Channel Sidebar  │              Chat View                            │
│ ┌────┐ │ ┌──────────────┐ │ ┌──────────────────────────────────────────────┐ │
│ │ S1 │ │ │Text Channels │ │ │           Channel Header                     │ │
│ ├────┤ │ │ # general    │ │ ├──────────────────────────────────────────────┤ │
│ │ S2 │ │ │ # random     │ │ │                                              │ │
│ ├────┤ │ ├──────────────┤ │ │           Message List                       │ │
│ │ S3 │ │ │Voice Channels│ │ │           (Virtualized)                      │ │
│ ├────┤ │ │ Voice Gen    │ │ │                                              │ │
│ │ DM │ │ ├──────────────┤ │ ├──────────────────────────────────────────────┤ │
│ └────┘ │ │ User Panel   │ │ │           Message Input                      │ │
│        │ └──────────────┘ │ └──────────────────────────────────────────────┘ │
└────────┴──────────────────┴──────────────────────────────────────────────────┘
```

### Component Organization

| Module | Purpose | Key Files |
|--------|---------|-----------|
| routes | Page-level route components (TanStack Router) | __root, index, login, channels, channels/@me, channels/$serverId.$channelId |
| components/layout | App shell and navigation chrome | ServerList, ChannelSidebar, UserPanel, MemberList |
| components/chat | Message display and input | ChannelHeader, MessageList, Message, MessageInput, MessageReactions, TypingIndicator |
| stores | Zustand state slices | authStore, channelStore, messageStore, presenceStore |
| hooks | Reusable logic for real-time features | useWebSocket, useMessages, usePresence |

---

## 🔍 Step 3: State Management with Zustand

### Auth Store

"I'm choosing Zustand with persist middleware for auth state. It provides simple API with built-in persistence to localStorage, making session management straightforward."

Key state:
- user, token, isAuthenticated
- login/logout/setUser actions
- Persists only token to localStorage

### Message Store with Optimistic Updates

"I'm choosing Zustand with subscribeWithSelector for granular subscriptions. This prevents unnecessary re-renders when unrelated state changes."

Key state:
- messagesByChannel: Map<string, Message[]>
- hasMoreByChannel, isLoadingByChannel: Map<string, boolean>

Key actions:
- **addMessage**: Appends message, avoids duplicates
- **sendMessage**: Creates optimistic message with tempId and pending: true, sends via API, replaces with real message on success or marks failed: true on error
- **fetchMessages**: Loads history with pagination (before cursor)
- **addReaction/removeReaction**: Updates reaction counts optimistically

### Presence Store

Key state:
- presences: Map<string, PresenceStatus>
- customStatuses: Map<string, string>

Key actions:
- setPresence, setCustomStatus, setBulkPresences
- getPresence (returns 'offline' if not found)

---

## 📡 Step 4: WebSocket Connection Management

### WebSocket Client Design

"I'm choosing a custom WebSocket client class over Socket.io for smaller bundle size and full control over reconnection logic."

Key features:
- **Heartbeat**: Sends ping every 30 seconds
- **Reconnection**: Exponential backoff up to 30s, max 5 attempts
- **Message Queue**: Queues messages during disconnection, flushes on reconnect
- **Pub/Sub Pattern**: Internal handlers Map for subscribe/unsubscribe

### WebSocket Hook

The useWebSocket hook:
- Connects on mount, disconnects on unmount
- Subscribes to events: MESSAGE_CREATE, MESSAGE_UPDATE, MESSAGE_DELETE, REACTION_ADD, REACTION_REMOVE, PRESENCE_UPDATE, TYPING_START
- Returns unsubscribe functions for cleanup

---

## 🎯 Step 5: Virtualized Message List

"I'm choosing @tanstack/react-virtual for message virtualization. It handles dynamic heights well and has a small bundle size."

### MessageList Component Design

Key patterns:
- **Message grouping**: Groups consecutive messages from same author within 5 minutes
- **estimateSize**: Calculates based on group (48px base + 24px per message)
- **overscan**: 5 items for smooth scrolling
- **getItemKey**: Uses group ID for stable keys

### Scroll Behavior

- **Load more on scroll up**: When scrollTop < 100px, fetch older messages
- **Auto-scroll on new messages**: If near bottom (within 200px), scroll to bottom smoothly
- **Preserve position on history load**: Uses bottomRef for stable anchor

### MessageGroup Component

Wrapped in memo() for performance. Shows:
- Avatar with OnlineIndicator overlay
- Username with relative timestamp
- List of MessageContent components
- Hover actions (reaction, reply, more)

### MessageContent Component

Shows:
- "Sending..." / "Failed to send" status for pending/failed messages
- Content text with opacity-50 when pending
- "(edited)" indicator
- MessageReactions component

---

## 💬 Step 6: Message Input with Typing Indicator

### MessageInput Component

Key features:
- **Auto-resize textarea**: Adjusts height up to 200px max
- **Debounced typing indicator**: 1 second debounce to avoid spamming
- **Enter to send**: Shift+Enter for new line
- **Paste handling**: Detects pasted files for upload
- **File upload**: FormData POST to attachments endpoint

### TypingIndicator Component

- Subscribes to TYPING_START events filtered by channelId
- Maintains typingUsers array with timestamps
- Removes stale entries (> 5 seconds) via interval
- Formats text: "X is typing...", "X and Y are typing...", "X, Y, and 3 others are typing..."
- Animated dots with staggered bounce animation

---

## 🏠 Step 7: Server and Channel Navigation

### ServerList Component

Layout:
- 72px wide column
- Home button (DMs) at top with tooltip
- Separator line
- Server icons with unread indicators
- Add server button at bottom

Server icon states:
- Default: rounded-2xl, bg-gray-700
- Hover: rounded-xl, bg-indigo-500
- Active: rounded-xl with white indicator bar on left
- Unread: small white dot on left

### ChannelSidebar Component

Sections:
- **Server header**: Name with dropdown chevron
- **Channel categories**: Collapsible with text/voice channels
- **User panel**: Current user info at bottom

ChannelLink shows:
- Hash icon for text, volume icon for voice
- Truncated channel name
- Unread count badge (if any)
- Active state with gray background

---

## 👥 Step 8: Presence Indicators

### OnlineIndicator Component

Props: userId, className, size (sm/md/lg)

Status colors:
- online: bg-green-500
- idle: bg-yellow-500
- dnd: bg-red-500
- offline: bg-gray-500

Styling: rounded-full with border-2 border-gray-800

### MemberList Component

Groups members by presence:
- Online section (all non-offline members)
- Offline section

Each member row shows:
- Avatar with OnlineIndicator
- Username
- Custom status (if any)

---

## 📱 Step 9: Responsive Design

### ResponsiveLayout Component

Uses useMediaQuery('(max-width: 768px)') hook.

Desktop layout:
- Full three-column layout
- Optional MemberList toggle

Mobile layout:
- Full-screen chat only
- Hamburger menu opens slide-out sidebar
- Overlay backdrop closes sidebar

### useMediaQuery Hook

- Initializes with window.matchMedia
- Adds change event listener for dynamic updates
- Returns boolean match state

---

## 🌐 Step 10: Accessibility

### Keyboard Navigation

MessageList:
- role="log" with aria-label="Message history"
- Arrow up/down to move focus between messages
- Enter to open message actions
- Escape to clear focus
- tabIndex management for focused item

### Screen Reader Announcements

LiveRegion component:
- role="status" with aria-live="polite"
- sr-only class for visual hiding
- Announces new messages: "New message from {username}: {content}"

### Skip Link

SkipLink component:
- sr-only by default
- Visible on focus
- Links to #main-content

---

## 🚀 Step 11: Performance Optimizations

### Memoization

- useMemo for groupedMessages computation
- memo() on MessageGroup and MessageContent components

### Debouncing

- Search input: 300ms debounce
- Typing indicator: 1s debounce with leading edge

### Lazy Loading

- React.lazy() for EmojiPicker, GifPicker, UserProfile
- Suspense fallback with LoadingSpinner
- Image loading="lazy" decoding="async"

### Preloading

- Prefetch channel messages on hover
- Uses queryClient.prefetchQuery with 30s staleTime

---

## ⚖️ Trade-offs and Alternatives

| Decision | ✅ Chosen | ❌ Alternative | Reasoning |
|----------|-----------|----------------|-----------|
| State Management | Zustand | Redux Toolkit | Simpler API, smaller bundle |
| Virtualization | @tanstack/react-virtual | react-window | Better dynamic height support |
| Real-time | Custom WebSocket | Socket.io | Smaller bundle, full control |
| Styling | Tailwind CSS | styled-components | Faster iteration, smaller runtime |
| Reconnection | Exponential backoff | Linear retry | Prevents server overload |

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
