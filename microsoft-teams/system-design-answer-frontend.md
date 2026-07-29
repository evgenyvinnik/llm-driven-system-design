# Microsoft Teams - Frontend System Design Answer

## 🏗️ Architecture Overview

> "I'm designing the frontend for an enterprise chat application like Microsoft Teams. The core challenge is building a responsive, real-time chat UI that handles thousands of messages per channel, threaded conversations in a side panel, and live presence indicators -- all while maintaining smooth scrolling performance and instant message delivery."

The frontend is a React SPA using TanStack Router for file-based routing, Zustand for state management, Server-Sent Events for real-time updates, and Tailwind CSS with a Teams-branded color system.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Browser Application                            │
│                                                                        │
│  ┌──────────┐  ┌──────────────────────────────────────────────────────┐ │
│  │          │  │                  Main Content                        │ │
│  │  Sidebar │  │  ┌────────────┐  ┌─────────────────┐  ┌──────────┐ │ │
│  │  (Orgs + │  │  │  Channel   │  │                 │  │  Thread  │ │ │
│  │  Teams)  │  │  │   List     │  │    Chat Area    │  │  Panel   │ │ │
│  │          │  │  │            │  │   (Messages +   │  │          │ │ │
│  │  64px    │  │  │  240px     │  │    Input)       │  │  320px   │ │ │
│  │          │  │  │            │  │                 │  │          │ │ │
│  └──────────┘  │  └────────────┘  └─────────────────┘  └──────────┘ │ │
│                └──────────────────────────────────────────────────────┘ │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────────┤
│  │  State: AuthStore (user, session) + ChatStore (messages, channels) │ │
│  │  SSE: EventSource per channel, auto-reconnect                      │ │
│  │  API: Fetch with credentials, proxy via Vite                       │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## 🧩 Component Architecture

> "The UI follows a three-column layout typical of enterprise chat apps. The leftmost column is a narrow sidebar for organization and team selection. The middle column lists channels. The right area is the chat view with an optional thread panel and member list that slide in from the right."

### Component Hierarchy

```
__root.tsx (auth check, loading state)
├── /login (LoginPage)
├── /register (RegisterPage)
├── / (IndexPage - redirect to first org)
└── /org (OrgLayout - sidebar + presence heartbeat)
    └── /org/$orgId (OrgPage - load teams, channel list)
        └── /org/$orgId/team/$teamId (TeamPage - load channels)
            └── /org/$orgId/team/$teamId/channel/$channelId (ChannelPage)
                ├── ChatArea
                │   ├── ChannelHeader (name, description, member toggle)
                │   ├── MessageList
                │   │   └── MessageItem (avatar, content, reactions, thread count)
                │   │       └── ReactionPicker (emoji grid)
                │   └── MessageInput (text + file attach)
                ├── ThreadPanel (conditional)
                │   ├── Parent message
                │   ├── Reply list
                │   └── Reply input
                └── MemberList (conditional, with PresenceIndicator)
```

### Key Components (~15)

| Component | Responsibility | Key Props/State |
|-----------|---------------|-----------------|
| Sidebar | Org icons + team buttons | organizations, teams, currentTeamId |
| OrgSelector | Organization icon buttons | organizations, currentOrgId |
| ChannelList | Channel list + create button | channels, currentChannelId |
| ChatArea | Message feed + header + input | messages, currentChannel |
| MessageList | Date-grouped messages | messages array |
| MessageItem | Single message with hover actions | message object |
| MessageInput | Text area + file button | onSend callback, channelId |
| ThreadPanel | Side panel for replies | threadMessages, parentMessage |
| ReactionPicker | Emoji selection grid | onSelect callback |
| MemberList | Online/offline member sections | channelMembers |
| PresenceIndicator | Green/gray dot | isOnline boolean |
| TypingIndicator | "User is typing..." text | typing users array |
| FileAttachment | File card with download | fileId, filename, size |
| CreateChannelModal | New channel form | teamId, onClose |
| SearchUsers | User search autocomplete | onSelect callback |

## 🧭 Routing Architecture

> "The routing structure mirrors the data hierarchy. TanStack Router's file-based routing with nested layouts means each route level loads its corresponding data. Navigation between channels only re-renders the innermost component, not the entire page."

### Route-to-Data Mapping

```
/org                          → OrgLayout loads orgs, starts heartbeat
  /org/$orgId                 → OrgPage loads teams for this org
    /org/$orgId/team/$teamId  → TeamPage loads channels for this team
      .../channel/$channelId  → ChannelPage loads messages, connects SSE
```

### Why TanStack Router Over React Router

| Approach | Pros | Cons |
|----------|------|------|
| ✅ TanStack Router | Type-safe params, file-based, nested layouts | Newer, smaller ecosystem |
| ❌ React Router v6 | Mature, well-documented | No file-based routing, less type safety |

> "TanStack Router's file-based routing with typed parameters is ideal for this app's deep hierarchy. The route `/org/$orgId/team/$teamId/channel/$channelId` has three dynamic segments -- TanStack Router validates these at compile time, preventing runtime crashes from typos in parameter names. React Router would require manual type assertions at each level."

### Navigation-Driven Data Loading

Data loading is triggered by route transitions, not by user actions in the UI. When the user clicks a channel name:
1. TanStack Router navigates to the new channel route
2. The ChannelPage component's `useEffect` fires with the new channelId
3. ChatStore calls `setCurrentChannel(channelId)` which disconnects the old SSE, clears messages, loads new messages, connects new SSE

This approach ensures the URL is always the source of truth for application state. Users can share channel links, and browser back/forward navigation works correctly.

## 🔄 State Management

> "I split state into two Zustand stores: AuthStore for authentication and ChatStore for everything chat-related. This separation ensures auth state doesn't trigger unnecessary re-renders in chat components."

### AuthStore
- `user` (User or null), `loading`, `error`
- Actions: `login`, `register`, `logout`, `checkAuth`
- Persists session via HTTP-only cookies (server-managed)

### ChatStore

The ChatStore is the largest piece of state, containing:

**Data**: organizations, teams, channels, messages, threadMessages, channelMembers

**Selection**: currentOrgId, currentTeamId, currentChannelId, threadParentId

**Connection**: sseConnection (EventSource reference), showMemberList toggle

**Actions**: ~18 actions including loadOrganizations, loadTeams, loadChannels, loadMessages, loadMoreMessages, loadThread, loadChannelMembers, sendMessage, sendThreadReply, setCurrentOrg, setCurrentTeam, setCurrentChannel, openThread, closeThread, toggleMemberList, connectSSE, disconnectSSE, addMessageFromSSE, startPresenceHeartbeat

### Why Two Stores

> "Auth changes (login/logout) are rare events that should trigger a full page transition. Chat state changes (new message, reaction, presence) happen constantly and should update surgically. With a single store, every message arrival would trigger Zustand's equality check against the entire state tree. Two stores isolate these concerns -- auth re-renders the root layout, chat re-renders only the affected message or presence indicator."

### Selector-Based Re-rendering

Zustand's selector pattern prevents unnecessary re-renders:
- `useAuthStore(s => s.user)` only re-renders when user changes
- `useChatStore(s => s.messages)` only re-renders when messages array changes
- Components like PresenceIndicator use `useChatStore(s => s.channelMembers)` and won't re-render on message changes

## 🔧 Deep Dive 1: Message List Performance

> "The message list is the most performance-critical component. A busy channel might have thousands of messages. Rendering all of them would freeze the browser. The key optimization strategies are pagination, scroll anchoring, and smart re-rendering."

### Pagination Strategy

Messages are loaded newest-first from the API (`ORDER BY created_at DESC LIMIT 50`), then reversed client-side for display. Older messages are loaded when the user scrolls to the top.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Cursor-based (before timestamp) | Consistent with insertions | Slightly more complex API |
| ❌ Offset-based | Simple | New messages shift offsets, duplicates |
| ❌ Load all messages | Simple display logic | Memory explosion on large channels |

> "I chose cursor-based pagination using the `before` timestamp parameter because offset-based pagination breaks when new messages arrive. If 5 new messages are posted while the user loads page 2 at offset 50, they'd see 5 duplicates. Cursor pagination always returns messages older than the cursor timestamp, immune to new insertions."

### Scroll Behavior

- **New message arrives**: Auto-scroll to bottom if user is already near the bottom (within 100px of the scroll end). If scrolled up reading history, show a "New messages" badge instead of disrupting their reading position.
- **Load older messages**: When the user scrolls to the top, fetch older messages and prepend them. Preserve scroll position by measuring content height before and after insertion.
- **Date separators**: Group messages by date and insert visual separators. This is a rendering-only concern -- the MessageList component compares each message's date to the previous message's date and inserts a separator when they differ.

### Re-Render Optimization

> "Each MessageItem receives a single message object. When a reaction is added via SSE, only the affected message's reactions array changes. Zustand updates the specific message in the messages array using `map()`, which creates a new reference for that message but preserves references for all other messages. React's reconciliation sees that only one MessageItem's props changed, and only re-renders that one."

### Virtual Scrolling (Future Enhancement)

For channels with 10K+ messages loaded in memory, virtual scrolling with `@tanstack/react-virtual` would render only visible messages plus a small overscan buffer. The challenge with chat is variable message heights -- short text messages differ from messages with file attachments and multiple reactions. This requires `measureElement` for dynamic height measurement:

1. Estimate initial height (e.g., 60px for text-only messages)
2. After render, measure actual DOM height via `getBoundingClientRect`
3. Update virtualizer's height cache for accurate scroll position calculation
4. Overscan 3-5 items above and below viewport for smooth scrolling

## 🔧 Deep Dive 2: Real-Time Updates via SSE

> "SSE (Server-Sent Events) drives all real-time updates. When the user opens a channel, the client establishes an EventSource connection to `/api/sse/:channelId`. The server pushes events for new messages, edits, and reaction changes."

### Connection Lifecycle

1. **Connect**: When `setCurrentChannel` is called, disconnect any existing SSE, then create a new EventSource for the channel
2. **Receive**: Event listeners for `new_message`, `message_edited`, `reaction_added`, `reaction_removed`
3. **Disconnect**: When navigating away from a channel or unmounting, close the EventSource
4. **Reconnect**: EventSource handles reconnection automatically on network errors

### Event Processing

| Event | Client Action |
|-------|--------------|
| `new_message` (top-level) | Append to messages array, auto-scroll if near bottom |
| `new_message` (thread reply) | Increment parent's reply_count, append to threadMessages if open |
| `message_edited` | Update message content in-place by ID, set is_edited flag |
| `reaction_added` | Find message, add/increment reaction, update users list |
| `reaction_removed` | Find message, decrement/remove reaction, filter users list |

### Deduplication

> "When the sender posts a message, two things happen: the REST response returns the created message, and the SSE stream delivers the same message to all clients (including the sender). Without deduplication, the sender sees their message twice."

The SSE handler checks `if (state.messages.some(m => m.id === message.id)) return state` before appending. This ID-based deduplication ensures messages are never duplicated regardless of race conditions between REST responses and SSE events.

### SSE vs. WebSocket Trade-off

| Aspect | SSE | WebSocket |
|--------|-----|-----------|
| Direction | Server-to-client only | Bidirectional |
| Reconnection | Built into EventSource API | Must implement manually |
| Protocol | Standard HTTP | Protocol upgrade required |
| Proxy support | Works through HTTP proxies | May require special config |
| Browser limit | ~6 connections per domain | ~200 connections per domain |
| Message format | Text only (UTF-8) | Text and binary |

> "For chat, the asymmetry is natural: messages are sent via REST POST (which gives us request/response semantics, error handling, and rate limiting for free), while real-time delivery is server-to-client push. SSE's built-in reconnection with EventSource means the client automatically recovers from network drops without custom retry logic. The trade-off is the 6-connection-per-domain limit in older browsers -- if a user has multiple channels open in tabs, they could exhaust this limit. Modern browsers have relaxed this to ~100 for HTTP/2, and our single-channel-per-page design avoids the issue entirely."

## 🔧 Deep Dive 3: Offline and Reconnection Handling

> "Enterprise users switch between WiFi and VPN, close laptop lids, and resume hours later. The client must handle these transitions gracefully without losing messages or showing stale state."

### Reconnection Flow

1. **Network loss detected**: EventSource fires `onerror`, begins automatic retry with increasing intervals
2. **Reconnection succeeds**: SSE stream resumes, but messages sent during the offline period are missing
3. **Gap fill**: On reconnection, the client should fetch messages newer than the last received message's timestamp
4. **State reconciliation**: Merge fetched messages with existing state, deduplicating by message ID

### Current Implementation vs. Production

The current implementation relies on EventSource's auto-reconnect but doesn't implement gap-fill. In production, I'd track `lastEventId` via the SSE `id` field, and on reconnect, the server would replay events since that ID. Alternatively, the client compares its latest message timestamp with the server and fetches the gap.

### Presence During Offline

- Heartbeat interval stops when the tab is hidden (detectable via `document.visibilitychange` event)
- Redis TTL expires after 60 seconds of no heartbeat, marking the user as offline
- On tab focus, immediately send a heartbeat to restore online status
- This prevents "phantom online" status for backgrounded tabs

### Optimistic Updates

> "When a user sends a message, they expect to see it immediately -- not after a 200ms round trip to the server. Optimistic updates display the message instantly in the UI before the server confirms."

The current implementation waits for the SSE event to display sent messages. A production implementation would:
1. Generate a client-side temporary ID
2. Add the message to state with a "pending" visual indicator (slightly dimmed text)
3. On server success via SSE, replace the temp ID with the real UUID, remove pending indicator
4. On server failure, mark the message as "failed" with a retry button
5. Track pending messages separately to avoid conflicts with SSE deduplication

## 🎨 UI/UX Design

### Layout Specifications

- **Sidebar** (64px): Dark background (#292929), organization icons stacked vertically with first-letter avatars, team buttons below a divider
- **Channel List** (240px): White background, team dropdown at top, channel names with # prefix, "+" button for creating channels
- **Chat Area** (flexible): Light gray background (#F5F5F5), channel header bar (48px), scrollable message list, message input with attachment button
- **Thread Panel** (320px): Slides in from right when user clicks "Reply in thread", parent message at top, replies below, dedicated reply input
- **Member List** (240px): Slides in from right, toggle via member icon in header, online/offline sections with presence dots

### Teams Color System

| Token | Value | Usage |
|-------|-------|-------|
| teams-bg | #F5F5F5 | Page background |
| teams-surface | #FFFFFF | Cards, panels, inputs |
| teams-sidebar | #292929 | Left sidebar background |
| teams-primary | #5B5FC7 | Buttons, links, active states |
| teams-hover | #4F52B2 | Primary hover state |
| teams-text | #242424 | Body text |
| teams-secondary | #616161 | Secondary text, labels |
| teams-border | #E0E0E0 | Dividers, input borders |
| teams-success | #6BB700 | Online presence indicator |
| teams-chat | #E8EBFA | Active channel highlight, own message background |

### Message Hover Actions

When hovering over a message, a floating action bar appears at the top-right corner with reaction (emoji face) and thread reply (speech bubble) buttons. This pattern keeps the default UI clean while providing quick access to common actions. The hover bar uses `position: absolute` relative to the message container to avoid layout shift.

### Accessibility Considerations

- Keyboard navigation through channels and messages
- Screen reader labels on presence indicators ("User is online" / "User is offline")
- High contrast ratios between text and background (WCAG AA compliant)
- Focus indicators on all interactive elements (buttons, inputs, links)

## ⚡ Performance Considerations

### Bundle Optimization

- Code split by route -- TanStack Router handles this automatically via dynamic imports
- SSE connection managed at the channel level, not globally (no unnecessary connections)
- Zustand selectors prevent cascading re-renders

### Network Optimization

- Vite dev server proxies `/api` to backend on port 3001, eliminating CORS preflight requests
- Credentials included via `fetch` with `credentials: 'include'` for session cookies
- Presence heartbeat is a lightweight POST with empty body (minimal payload)
- File downloads use presigned MinIO URLs, offloading bandwidth from the API server

### Memory Management

- Messages are cleared when switching channels (`setCurrentChannel` resets the messages array)
- Thread state is cleared when closing the thread panel
- SSE connections are properly closed on channel switch and component unmount
- No accumulation of messages across channel switches

## 🗂️ State: Server Cache vs. UI State

Two kinds of state, deliberately kept apart. Organizations, teams, channels, messages, and presence are *server* state — the client holds a copy that can go stale. Which panel is open, which thread is expanded, and draft text are *UI* state that no server ever needs to know about.

Collapsing them into one store is the common mistake, and it produces a specific bug: a refetch of server data blows away the open thread panel, because both live in the same object and the refetch replaced it. Keeping them separate means the message list can refresh under an open thread panel without disturbing it.

| State | Where | Why |
|-------|-------|-----|
| Channels, messages, presence | Zustand store, refetched and stream-updated | Shared across components; must survive navigation within an org |
| Open thread, member list visibility, drafts | Component or store slice never touched by refetch | Purely local; a server refresh must not disturb it |

The trade-off is discipline rather than machinery — nothing enforces the split, so it's a convention that has to hold as features are added. A data-fetching library with its own cache would enforce it structurally, at the cost of a second state system alongside the store.

## 🧭 Routing the Hierarchy

The URL is `/org/:orgId/team/:teamId/channel/:channelId`, and the route tree mirrors the containment hierarchy exactly — each segment is a layout that loads its own level and renders an outlet for the next.

That structure buys real things. Every level's data loads once at the level that owns it rather than being refetched by children; the sidebar rail lives in the org layout and survives channel navigation without remounting; and any view in the app is a shareable, bookmarkable URL, which for a work chat tool is not a nicety — "here's the channel" is how people hand off context.

**The trap in this shape** is the convenience redirect. Each layout wants to pick a sensible default for the level below: land on the first team, then its first channel. Written as an effect that fires when the child data arrives, it will happily rewrite a URL that already named a channel — the effect can't tell "no channel chosen yet" from "a channel was chosen, and the list just finished loading." The symptom is specific and confusing: clicking a channel works, but reloading that page or opening the link from Slack silently lands on a different channel. The fix is that the redirect must be conditional on the child param being *absent*, not merely on the data being present.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Redirect only when the child param is absent | Deep links and reloads work; defaults still apply on entry | Every layout that picks a default needs the guard |
| ❌ Redirect whenever the child list loads | Trivial to write | Silently clobbers deep links — the bug only appears on reload, never while clicking |

> "What makes this worth calling out is that it's invisible to the person who wrote it. You build the app by clicking through it, and clicking is the one path that works. It only shows up when someone pastes a link — which is to say, the first time a real user tries to share something."

## 🔌 Rendering a Stream

The message list is fed by two sources that have to agree: an initial `GET` for history, and an `EventSource` pushing everything after. The subtlety is that those overlap. A message can arrive over the stream while the history fetch is still in flight, and naive append gives you either a duplicate or a message that vanishes when the fetch resolves and replaces the list.

Keying by message ID and merging rather than appending is what makes this safe, and it's the same property that makes the optimistic-send path work: the optimistic message carries a temporary ID, the server's response carries the real one, and the merge reconciles them. Without ID-keyed merging you need send-order assumptions that break the moment two people post at once.

The cost is that the client holds the reconciliation logic — the server just broadcasts and has no idea what any given client already has. The alternative, sequence numbers per channel so a reconnecting client can ask for the gap, moves that burden to the server and would also fix the missed-message problem SSE currently has. It's the right next step, and it's not built.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| ✅ Zustand | Lightweight, selector-based | ❌ Redux | Chat state is simple, no middleware needed |
| ✅ SSE (EventSource) | Auto-reconnect, HTTP-native | ❌ WebSocket | Unidirectional push, simpler client |
| ✅ TanStack Router | File-based, type-safe params | ❌ React Router | Nested layouts match hierarchy |
| ✅ Cursor pagination | Stable with concurrent writes | ❌ Offset pagination | No duplicate/gap issues |
| ✅ Two stores | Separate auth/chat concerns | ❌ Single store | Auth changes don't re-render chat |
| ✅ Tailwind CSS | Utility-first, theme tokens | ❌ CSS Modules | Faster iteration, consistent design |
| ✅ Route-driven loading | URL is source of truth | ❌ Store-driven loading | Shareable links, browser nav works |
| ✅ Date separators in render | No extra state | ❌ Pre-computed grouping | Simpler, derived from message timestamps |
