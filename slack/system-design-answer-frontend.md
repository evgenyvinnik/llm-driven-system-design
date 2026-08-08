# Slack - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## 📋 Problem Statement

Design the frontend architecture for a team messaging platform that allows users to:
- Send and receive messages in real-time across channels
- Navigate between workspaces, channels, and threads
- See presence status and typing indicators
- Search across message history

## ✅ Requirements Clarification

### Functional Requirements
1. **Workspace Switcher**: Navigate between multiple workspaces
2. **Channel List**: Sidebar with public/private channels and DMs
3. **Message View**: Scrollable message history with infinite scroll
4. **Real-Time Updates**: Live message delivery, typing indicators, presence
5. **Thread View**: Slide-out panel for thread replies
6. **Search**: Full-text search with result highlighting

### Non-Functional Requirements
1. **Performance**: Message list should scroll smoothly with 10K+ messages
2. **Responsiveness**: Desktop and mobile layouts
3. **Accessibility**: Keyboard navigation, screen reader support
4. **Offline Resilience**: Show cached data when offline

### UI/UX Requirements
- Messages should appear instantly (optimistic updates)
- Unread indicators for channels with new messages
- Typing indicators when others are composing
- Visual distinction between own messages and others

---

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           React Application                                  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                          TanStack Router                                │ │
│  │    /workspace/:id           ──▶ Workspace Layout                        │ │
│  │    /workspace/:id/channel/:channelId ──▶ Channel View                   │ │
│  │    /workspace/:id/dm/:dmId  ──▶ Direct Message View                     │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────┐  ┌──────────────────────┐  ┌─────────────────────┐    │
│  │    Sidebar      │  │     Message Area     │  │    Thread Panel     │    │
│  │ ┌─────────────┐ │  │ ┌──────────────────┐ │  │ ┌─────────────────┐ │    │
│  │ │  Workspace  │ │  │ │  Channel Header  │ │  │ │   Parent Msg    │ │    │
│  │ │  Switcher   │ │  │ └──────────────────┘ │  │ └─────────────────┘ │    │
│  │ └─────────────┘ │  │ ┌──────────────────┐ │  │ ┌─────────────────┐ │    │
│  │ ┌─────────────┐ │  │ │   MessageList    │ │  │ │     Replies     │ │    │
│  │ │  Channels   │ │  │ │  (virtualized)   │ │  │ │   (scrollable)  │ │    │
│  │ └─────────────┘ │  │ └──────────────────┘ │  │ └─────────────────┘ │    │
│  │ ┌─────────────┐ │  │ ┌──────────────────┐ │  │ ┌─────────────────┐ │    │
│  │ │    DMs      │ │  │ │    Composer      │ │  │ │    Composer     │ │    │
│  │ └─────────────┘ │  │ └──────────────────┘ │  │ └─────────────────┘ │    │
│  └─────────────────┘  └──────────────────────┘  └─────────────────────┘    │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         Zustand Store                                   │ │
│  │   workspaces │ channels │ messages │ threads │ presence │ typing       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                       WebSocket Connection                              │ │
│  │   Real-time: messages, presence, typing, reactions                     │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🗃️ Deep Dive 1: State Management with Zustand

### Store Design

The Zustand store manages all client-side state for the Slack application:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            SlackState Store                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│  WORKSPACE STATE                                                              │
│  ├── currentWorkspaceId: string │ null                                       │
│  └── workspaces: Workspace[]                                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│  CHANNEL STATE                                                                │
│  ├── currentChannelId: string │ null                                         │
│  ├── channels: Channel[]                                                     │
│  └── unreadCounts: Record<string, number>                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│  MESSAGE STATE                                                                │
│  ├── messages: Record<channelId, Message[]>                                  │
│  ├── isLoadingMessages: boolean                                              │
│  └── hasMoreMessages: Record<channelId, boolean>                             │
├──────────────────────────────────────────────────────────────────────────────┤
│  THREAD STATE                                                                 │
│  ├── activeThreadId: string │ null                                           │
│  └── threadMessages: Record<parentId, Message[]>                             │
├──────────────────────────────────────────────────────────────────────────────┤
│  PRESENCE & TYPING                                                            │
│  ├── onlineUsers: Set<string>                                                │
│  └── typingUsers: Record<channelId, userId[]>                                │
├──────────────────────────────────────────────────────────────────────────────┤
│  ACTIONS                                                                      │
│  ├── setCurrentWorkspace(id)    ├── openThread(messageId)                    │
│  ├── setCurrentChannel(id)      ├── closeThread()                            │
│  ├── addMessage(channelId, msg) ├── setTyping(channelId, userId)             │
│  └── loadMoreMessages(channelId)└── clearTyping(channelId, userId)           │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Key Implementation Details:**

- **setCurrentChannel**: Automatically triggers message loading if not cached
- **addMessage**: Appends to the channel's message array, updates unread counts
- **loadMoreMessages**: Fetches older messages using cursor-based pagination
- **openThread/closeThread**: Manages the slide-out thread panel state

### Why Zustand Over Redux?

| Factor | Zustand | Redux |
|--------|---------|-------|
| Boilerplate | Minimal | Significant |
| Bundle size | ~1KB | ~7KB + middleware |
| Learning curve | Simple | Steeper |
| DevTools | Supported | Excellent |
| Selective subscriptions | Built-in | Requires selectors |

> "Zustand provides the power we need with less ceremony. Real-time apps benefit from its simple subscription model."

---

## 🔧 Deep Dive 2: Virtualized Message List

### The Problem

A busy channel can have 10,000+ messages. Rendering all of them would be extremely slow and memory-intensive.

### Solution: @tanstack/react-virtual

```
┌────────────────────────────────────────────────────────────────┐
│                    Virtualized Message List                     │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ▲ Load more trigger (scrollTop < 100px)                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ [Not Rendered - Above Viewport]                          │   │
│  │ Messages 0-47 (estimateSize: 80px each)                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ [Overscan Buffer - 10 items]                             │   │
│  │ Messages 48-57                                           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                            │                                    │
│                            ▼                                    │
│  ╔═════════════════════════════════════════════════════════╗   │
│  ║ [VISIBLE VIEWPORT]                                      ║   │
│  ║                                                         ║   │
│  ║  ┌───────────────────────────────────────────────────┐  ║   │
│  ║  │ Avatar │ Username    │ 10:30 AM                   │  ║   │
│  ║  │        │ Message content with dynamic height...   │  ║   │
│  ║  │        │ [Thread: 5 replies] [Reactions: +3]      │  ║   │
│  ║  └───────────────────────────────────────────────────┘  ║   │
│  ║                                                         ║   │
│  ║  Messages 58-72 (measured with measureElement)          ║   │
│  ╚═════════════════════════════════════════════════════════╝   │
│                            │                                    │
│                            ▼                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ [Overscan Buffer - 10 items]                             │   │
│  │ Messages 73-82                                           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ [Not Rendered - Below Viewport]                          │   │
│  │ Messages 83-9999                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

**Virtualizer Configuration:**
- count: messages.length
- estimateSize: 80px (average message height)
- overscan: 10 (extra items above/below viewport)
- measureElement: Dynamic height measurement via getBoundingClientRect

**Key Behaviors:**
- **Load More**: Triggered when scrollTop < 100px, fetches older messages
- **Scroll to Bottom**: Auto-scrolls when user sends their own message
- **Dynamic Heights**: Messages measured individually for accurate positioning

### Message Item Structure

```
┌─────────────────────────────────────────────────────────────────┐
│ Message Item (hover to show actions)                             │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────┐                                                       │
│  │       │  Username              10:30 AM                       │
│  │ Avatar│  ──────────────────────────────                       │
│  │  36px │  Message content goes here with                       │
│  │       │  whitespace preserved (pre-wrap)                      │
│  └───────┘                                                       │
│                                                                  │
│  ┌──────────────────────────────────────────┐                    │
│  │ Thread Icon │ 5 replies (clickable)      │                    │
│  └──────────────────────────────────────────┘                    │
│                                                                  │
│  ┌──────────────────────────────────────────┐    ┌─────────────┐│
│  │ Reactions: [+2] [thumbsup] [heart]       │    │ Hover Menu  ││
│  └──────────────────────────────────────────┘    │ [emoji][rply││
│                                                   └─────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔌 Deep Dive 3: WebSocket Integration

### Connection Manager

```
┌────────────────────────────────────────────────────────────────────┐
│                    WebSocket Connection Flow                        │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────┐     ┌──────────────────┐     ┌──────────────────┐    │
│  │  Client  │────▶│    Connect       │────▶│   Authenticate   │    │
│  │  Init    │     │  wss://api/ws    │     │   Send token     │    │
│  └──────────┘     └──────────────────┘     └──────────────────┘    │
│                                                     │               │
│                                                     ▼               │
│                                            ┌──────────────────┐    │
│                                            │   Listen for     │    │
│                                            │   Messages       │    │
│                                            └──────────────────┘    │
│                                                     │               │
│       ┌─────────────────────────────────────────────┼───────────┐  │
│       │                                             │           │  │
│       ▼                                             ▼           ▼  │
│  ┌──────────┐                              ┌──────────┐ ┌────────┐ │
│  │ onclose  │                              │ message  │ │presence│ │
│  │ ──────── │                              │ ──────── │ │reaction│ │
│  │ Reconnect│                              │ addMsg() │ │ typing │ │
│  │ (3s wait)│                              │ to store │ │ update │ │
│  └──────────┘                              └──────────┘ └────────┘ │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

**Message Type Handling:**

| Message Type | Handler Action |
|--------------|----------------|
| message | addMessage to Zustand store |
| presence | Add/remove from onlineUsers Set |
| typing | setTyping with channel and user |
| reaction_added | Update message reactions |

**Reconnection Strategy:**
- onclose triggers setTimeout(connect, 3000)
- Reconnect timeout cleared on unmount
- Auth token resent on each connection

### Typing Indicator Component

```
┌─────────────────────────────────────────────────────────────────┐
│                     Typing Indicator                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────┐  ┌──────┐  ┌──────┐                                   │
│  │  ●   │  │  ●   │  │  ●   │   "{user} is typing..."           │
│  │ 0ms  │  │150ms │  │300ms │                                   │
│  │bounce│  │delay │  │delay │   or "{user1} and {user2}..."     │
│  └──────┘  └──────┘  └──────┘   or "3 people are typing..."     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔧 Deep Dive 4: Optimistic Sends, Threads, and the Sidebar

These three surfaces share one problem: the server is the authority, but the UI
cannot wait for it. I'll take the send path first because it's the one where
getting it wrong is most visible.

### Optimistic message send

```
User presses Enter
   │
   ├──▶ Create temp message  { id: "temp-1712…", pending: true }
   │      append to store, clear the input immediately
   │
   └──▶ POST /api/channels/:id/messages   (idempotency key = temp id)
            │
            ├── 200 ──▶ replace temp row with the server row (real id, real ts)
            │
            └── error ─▶ mark { pending: false, failed: true }
                          render inline "Failed to send — Retry"
```

> "I render the message before the server has acknowledged it because a chat
> input that freezes for 200ms feels broken — users type the next sentence while
> the last one is still in flight. The temp id is what makes this safe to
> reconcile: it's also the idempotency key, so a retry after a timeout can't
> produce two messages. The cost is that I now have three message states in the
> store instead of one — pending, confirmed, failed — and every component that
> renders a message has to handle all three. I accept that because the
> alternative, a spinner on every send, makes the product feel slower than the
> network actually is."

The subtle case is **ordering**. An optimistic message is appended locally at
the moment of send, but the server assigns the real timestamp and id. If two
people send simultaneously, my local ordering can briefly disagree with
everyone else's. I reconcile on the server row rather than trying to predict
ordering client-side — the message may visibly jump position once, which is
better than showing a different history than the person next to you.

**Keyboard handling:** Enter submits, Shift+Enter inserts a newline, and the
textarea auto-grows to a 200px cap. Typing is debounced 1s before emitting a
`typing` event, so a fast typist produces one event per second rather than one
per keystroke.

### Thread panel

Threads open as a fixed-width right-hand panel rather than a route. That's a
deliberate choice: a thread is read *in the context of* its channel, and a
route change would unmount the virtualized channel list and lose its scroll
position. The panel holds `activeThreadId` in the store; closing sets it to
null. The parent message renders at the top in a variant style, followed by a
scrollable reply list and a dedicated reply composer that posts with
`thread_ts` set.

Replies arrive over the same WebSocket as channel messages, so a thread open in
the panel updates live without its own subscription — the reducer just routes
any message carrying a `thread_ts` to both the thread and the parent's reply
count.

### Channel sidebar

| Element | Behavior |
|---------|----------|
| Chevron | Toggles section expansion |
| `#` / lock icon | Public / private channel |
| Presence dot | Online (green) / offline (hollow) |
| Unread badge | Red pill with count |
| Bold text | Unread messages present |
| Blue background | Currently selected channel |

Unread counts are derived from each channel's `last_read_at` cursor against the
latest message id, computed once per channel in a selector rather than stored
as a separate counter. A stored counter would need to be decremented on read,
incremented on receive, and reconciled on reconnect — three places to drift.
Deriving it means the badge is always consistent with the messages actually in
the store, at the cost of recomputing on every message arrival, which is cheap
relative to the render it triggers anyway.

---

## ⚡ Performance Optimizations

### 1. Selective Store Subscriptions

> "Only subscribe to the exact state slice needed. A ChannelHeader only needs currentChannelId and the matching channel object, not the entire messages map."

```
┌────────────────────────────────────────────────────────────────┐
│                  Selective Subscription                         │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Component: ChannelHeader                                       │
│                                                                 │
│  ┌─────────────────────┐     ┌─────────────────────────────┐   │
│  │ Zustand Store       │     │ Subscribed State            │   │
│  │ ─────────────────── │     │ ──────────────────────────  │   │
│  │ currentWorkspaceId  │     │ currentChannelId ✓          │   │
│  │ workspaces          │     │ channel (filtered) ✓        │   │
│  │ currentChannelId ───┼────▶│                             │   │
│  │ channels ───────────┼────▶│ Re-render: only when        │   │
│  │ unreadCounts        │     │ channel changes             │   │
│  │ messages ✗          │     │                             │   │
│  │ threadMessages ✗    │     │                             │   │
│  │ onlineUsers ✗       │     │                             │   │
│  └─────────────────────┘     └─────────────────────────────┘   │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 2. Memoized Message Rendering

Messages are wrapped in React.memo with custom comparison:
- Only re-renders if message.id changes
- Prevents cascade re-renders when new messages arrive

### 3. Debounced Typing Indicator

- Typing events throttled to 1 event per second
- Reduces WebSocket traffic significantly
- Uses useMemo with debounce wrapper

### 4. Optimistic Updates Summary

| Action | Optimistic | Server Sync |
|--------|------------|-------------|
| Send message | Show immediately with pending state | Replace temp ID with real ID |
| React to message | Update reactions array | Confirm or rollback |
| Mark as read | Clear unread count | Background sync |

---

## ♿ Accessibility (a11y)

### Keyboard Navigation

| Shortcut | Action |
|----------|--------|
| Alt + Arrow Up | Previous channel |
| Alt + Arrow Down | Next channel |
| Escape | Close thread panel |
| Cmd/Ctrl + K | Open search |
| Enter | Send message |
| Shift + Enter | New line |

**Implementation Notes:**
- Skip keyboard handlers if target is input/textarea
- Focus management for thread panel open/close
- Trap focus within modals

### ARIA Labels

```
┌────────────────────────────────────────────────────────────────┐
│                    ARIA Structure                               │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  <aside role="navigation" aria-label="Channel list">           │
│    <ul role="list" aria-label="Channels">                      │
│      <li role="listitem">                                      │
│        <button                                                 │
│          aria-current="page" (if active)                       │
│          aria-label="#general, 5 unread messages">             │
│          #general                                              │
│        </button>                                                │
│      </li>                                                     │
│    </ul>                                                       │
│  </aside>                                                      │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

---

## ⚖️ Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Zustand over Redux | Less boilerplate, simpler | Less tooling ecosystem |
| Virtualized list | Smooth scrolling, low memory | Complex scroll handling |
| Optimistic updates | Instant feedback | Rollback complexity |
| WebSocket in React | Real-time updates | Reconnection handling |
| Debounced typing | Reduces network traffic | Slight delay in indicator |

---

## 🚀 Future Frontend Enhancements

1. **Rich Text Editor**: WYSIWYG with markdown support
2. **Drag & Drop Files**: Upload by dropping anywhere
3. **Emoji Picker**: Searchable emoji selection
4. **Mentions Autocomplete**: @user and #channel suggestions
5. **Dark Mode**: System preference and manual toggle
6. **Mobile Layout**: Collapsible sidebar, swipe gestures
