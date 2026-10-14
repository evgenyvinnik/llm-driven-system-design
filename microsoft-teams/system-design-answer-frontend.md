# 💬 Microsoft Teams — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "The hard part of a chat client isn't drawing messages. It's that the message list is fed by two sources at once, a history request and a live stream, and they have to meet exactly, with nothing missing and nothing shown twice, even when the network drops, the user scrolls back three days, or the same message arrives as both a REST response and a stream event. Everything else (virtualization, optimistic sends, reconnects) hangs off one idea: every event in a channel carries a sequence number, and the client keeps a cursor."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, performance and accessibility targets |
| A — Architecture | 9 min | Component tree, who owns which state, the data layer, three key flows |
| D — Data model | 5 min | The message store, the cursor, the pending outbox |
| I — Interface | 4 min | The API and stream as the client sees them |
| O — Optimizations & deep dives | 18 min | A fast live list, consistency at the cursor, offline and multi-tab |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"Let me confirm who uses this and where, because enterprise chat runs all day in a background tab on a work laptop."

### Functional requirements

1. **Navigate** organizations, teams and channels; every view has a shareable URL.
2. **Read** a channel: the newest messages first, older history on scroll, one-level threads in a side panel.
3. **Send** messages and thread replies that appear instantly and survive flaky networks; react with emoji.
4. **Live updates:** new messages, edits, deletions and reactions appear without refreshing.
5. **Presence and unread:** who's online in the member list, unread badges on other channels.

Out of scope: meetings UI, rich-text editor internals, file previews.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| LCP | < 2.5 s on a mid-range laptop | First load of the day |
| Channel switch | < 100 ms to cached content, < 300 ms cold | People hop between channels constantly |
| INP | < 200 ms while 20 events/s stream in | Typing must never stutter because messages arrive |
| Delivery to screen | < 100 ms after the event reaches the browser | The backend already spends ~400 ms |
| Memory | < 150 MB after 8 hours open | Runs all day in a background tab |
| Correctness | No missing, duplicated or reordered messages, including after reconnects | Trust in the conversation |
| Accessibility | WCAG 2.2 AA; new messages announced politely; every action keyboard-reachable | Workplace tool, legal requirement |

---

## 🏗️ A — Architecture (9 min)

"A client-rendered SPA. It's an authenticated app with no SEO, and the expensive part is the live list after load, not the first paint, so server rendering would buy little. I'd keep the initial bundle small and code-split the thread panel, settings and admin screens."

```
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │ Routes (TanStack Router) · the URL owns the selection                                    │
  │ /org/$orgId/team/$teamId/channel/$channelId                                              │
  └─────────┬──────────────────────────────────┬────────────────────────────────┬────────────┘
            ▼                                  ▼ (1) channel opens              ▼
  ┌────────────────────────┐    ┌──────────────────────────────┐    ┌────────────────────────┐
  │ Sidebar · ChannelList  │    │ ChannelPage · ChatArea       │    │ ThreadPanel            │
  │ team, channel pickers  │    │ MessageList (virtualized)    │    │ MemberList · presence  │
  └─────────┬──────────────┘    │ Composer                     │    └───────────┬────────────┘
            │ read lists        └───────┬──────────────────────┘                │ read thread
            │                           │ (2) send, load older                  │
            ▼                           ▼                                       ▼
  ┌────────────────────────────┐    ┌────────────────────────────────────────────────────────┐
  │ Server-state cache         │    │ Message store (Zustand) · the open channel             │
  │ orgs, teams, channels,     │    │ messages ordered by seq · cursor · pending sends       │
  │ members (TanStack Query)   │    │ open thread · stream status                            │
  └─────────┬──────────────────┘    └───┬─────────────┬──────────────────────────────────────┘
            │ GET lists                 │             │ persist outbox              ▲ (3) apply
            │                 GET, POST │             │                             │ if next seq
            ▼                           │             ▼                             │
  ┌──────────────────────────┐          │   ┌──────────────────────┐  ┌─────────────┴────────┐
  │ API client               │          │   │ IndexedDB            │  │ Event stream (SSE)   │
  │ fetch · AbortSignal      │◀─────────┘   │ outbox, recent pages │  │ reopen with cursors  │
  │ typed errors             │              └──────────────────────┘  └───────────┬──────────┘
  └─────────┬────────────────┘                                                    │
            │ HTTPS, session cookie                       GET /events?cursors=…   │
            ▼                                                                     ▼
  ┌──────────────────────────────────────────────────────────────────────────────────────────┐
  │ Chat API · Push Gateway  (backend design: system-design-answer-backend.md)               │
  └──────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Open a channel (1).** The URL changes, `ChannelPage` asks the message store to open the channel, the store fetches the newest page and its `latestSeq`, and only then adds the channel's cursor to the event stream.
2. **Send (2).** The composer hands text to the store, which inserts a pending row immediately, saves it to the IndexedDB outbox, and posts it with a client-generated `clientMessageId`.
3. **Live update (3).** The event stream delivers an event tagged with its channel and `seq`; the store applies it only if it is exactly the next number, and the virtualized list re-renders the rows that changed.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Selected org, team, channel, open thread | URL (router params) | Shareable, survives reload, back button works |
| Orgs, teams, channels, members | TanStack Query cache | Plain request/response data: caching, dedupe, retries for free |
| Messages, cursor, pending sends | Message store (Zustand) | Fed by history and the stream; ordering logic lives in one place |
| Unsent messages | IndexedDB outbox | Must survive a tab close or crash |
| Draft text, menus, hover state | Component state | Never shared |

"The rule I'm applying: request/response data goes in a query cache, but the message list is a live, event-sourced view, so it gets its own store with explicit merge rules. Putting messages in a generic query cache invites a refetch that overwrites events the stream already applied."

### Key interaction: opening a channel

```
 ChannelPage         Message store                     Chat API   Event stream
      │                    │                               │            │
      │ 1 openChannel(ch)  │                               │            │
      │───────────────────▶│                               │            │
      │                    │ 2 GET /messages?channelId=ch  │            │
      │                    │──────────────────────────────▶│            │
      │                    │ 3 {messages, latestSeq: 41}   │            │
      │                    │◀──────────────────────────────│            │
      │                    │ 4 render page; cursor = 41    │            │
      │                    │ 5 open with after=41                       │
      │                    │───────────────────────────────────────────▶│
      │                    │ 6 id 42, new_message                       │
      │                    │◀───────────────────────────────────────────│
      │                    │ 7 42 = cursor + 1: apply      │            │
      │                    │                               │            │
```

"History first, stream second, from the exact position the page was read at. If I opened the stream first, a message could arrive before the page and then be wiped when the page replaces the list; if I opened it after with no cursor, anything posted between the two requests would be lost. The cursor makes both orders correct."

### Key interaction: sending

```
Composer           Message store                              Chat API   Event stream
    │                    │                                        │            │
    │ 1 send("ship it")  │                                        │            │
    │───────────────────▶│                                        │            │
    │                    │ 2 add pending row, key K               │            │
    │                    │ 3 POST /messages {clientMessageId: K}  │            │
    │                    │───────────────────────────────────────▶│            │
    │                    │ 4 id 43: message with K                             │
    │                    │◀────────────────────────────────────────────────────│
    │                    │ 5 replace pending row in place         │            │
    │                    │ 6 201 message (same id): no-op         │            │
    │                    │◀───────────────────────────────────────│            │
    ····················· request fails: row shows Retry ·······················
    │                    │ 7 retry with the same K                │            │
    │                    │───────────────────────────────────────▶│            │
    │                    │ 8 200 original, never a duplicate      │            │
    │                    │◀───────────────────────────────────────│            │
    │                    │                                        │            │
```

"The pending row and the server's message are matched by `clientMessageId`, so it doesn't matter whether the stream event (step 4) or the REST response (step 6) arrives first; the second one finds the message already confirmed and does nothing. A retry reuses the same key, so a request that actually succeeded but whose response was lost can't produce a duplicate."

### Key interaction: a gap and a resync

```
Event stream                  Message store                           Chat API
      │                             │                                     │
      │ 1 id 45 (cursor is 43)      │                                     │
      │────────────────────────────▶│                                     │
      │                             │ 2 gap: ignore 45                    │
      │ 3 reopen with after=43      │                                     │
      │◀────────────────────────────│                                     │
      │ 4 replay 44, 45, then live  │                                     │
      │────────────────────────────▶│                                     │
      ·················· server answers resync instead ····················
      │ 5 resync {latestSeq: 900}   │                                     │
      │────────────────────────────▶│                                     │
      │                             │ 6 reload newest page, keep pending  │
      │                             │────────────────────────────────────▶│
      │ 7 reopen with after=900     │                                     │
      │◀────────────────────────────│                                     │
      │                             │                                     │
```

"The store never applies an event out of order. A jump means something was lost in transit, so it reopens the stream from its cursor and lets the server replay. If the gap can't be replayed (the laptop slept for two days), the server says `resync` and the store reloads the newest page while keeping unsent messages."

---

## 💾 D — Data Model (5 min)

"The message store is normalized per channel and keyed by the server's ordering, not by arrival order."

| Entity | Shape | Where | Notes |
|--------|-------|-------|-------|
| `Message` | id, channelId, seq, author, content, parentId, replyCount, reactions, editedAt, deletedAt, clientMessageId, status | Store, by id | `status` exists only on the client: pending or failed |
| `ChannelTimeline` | ordered seqs, cursor (last applied seq), oldest loaded seq, hasMore | Store, per channel | Up to 10 channels kept, least recently used evicted |
| `Reaction` | emoji, set of user ids | Inside `Message` | A set, so repeating an event can't double count |
| `Thread` | root id, reply ids | Store | Only the open thread |
| `OutboxEntry` | clientMessageId, channelId, content, parentId, attempts | IndexedDB | Removed when the server confirms |
| Lists | orgs, teams, channels, members | Query cache | Keys like `['channels', teamId]` |

Three modeling decisions:

- **Order by `seq`, never by timestamp.** Timestamps from different senders' clocks disagree; `seq` comes from the server in commit order. Pending messages have no `seq` yet, so they render after every confirmed one until the server places them.
- **Reactions are sets of users, not counters.** An optimistic toggle followed by its own stream event, or a replayed event, then changes nothing the second time.
- **Deletions are tombstones.** A deleted thread root still anchors its replies, rendered as "This message was deleted."

---

## 🔌 I — Interface (4 min)

### The API as the client sees it

```
GET    /api/v1/channels/{id}/messages?before=<seq>&limit=50  → {messages, latestSeq, hasMore}
POST   /api/v1/messages        {channelId, content, parentId?, clientMessageId} → 201 | 200 replayed | 422
GET    /api/v1/messages/{id}/thread                          → root + replies in seq order
PUT    /api/v1/messages/{id}/reactions/{emoji}               → idempotent; event only if changed
DELETE /api/v1/messages/{id}/reactions/{emoji}
GET    /events?cursors=ch1:41,ch2:17     SSE: events tagged {channel, seq}; resync when too old
POST   /api/v1/channels/{id}/read?seq=<n>
```

- `latestSeq` is the contract that matters most: the history page is everything up to it, the stream is everything after it.
- Every stream event carries its channel and `seq`, so the client can detect duplicates and gaps per channel.
- `404` means "doesn't exist or you can't see it". The UI shows the same "Channel not found" for both, which is also why a deep link to a private channel leaks nothing.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<ChannelPage channelId>` | Opens the channel on mount and closes it on unmount; nothing else talks to the stream |
| `<MessageList channelId>` | Virtualized; reads ordered ids from the store; owns scroll anchoring |
| `<MessageItem id>` | Subscribes to one message by id, so a reaction re-renders one row |
| `<Composer onSend>` | Owns the draft; hands text to `useSendMessage()` and clears |
| `useSendMessage()`, `useToggleReaction()` | Wrap the optimistic update, the outbox and the request, so components never touch cursors or keys |

---

## 🔧 O — Optimizations & Deep Dives (18 min)

### Deep dive 1: a live list that stays fast (7 min)

"A busy channel holds thousands of messages of very different heights, grows at the bottom, loads history at the top, and receives events while you type. Three techniques keep it smooth."

1. **Virtualization with measured heights.** `@tanstack/react-virtual` renders only the rows in view plus a small overscan, so the DOM stays around 40 rows whether the channel holds 50 messages or 5,000. Rows have different heights (code blocks, images, reactions), so each row is measured after it renders and the estimates are corrected.
2. **Scroll anchoring in both directions.** When older history is prepended, I adjust `scrollTop` by the height that was added above, before paint, so the message the reader is looking at doesn't move. When a new message arrives, I follow it only if the reader was already at the bottom; otherwise a "New messages" pill appears. A reaction landing on a message far up must never yank the view.
3. **Batching stream bursts.** A reconnect can replay 300 events at once. I apply events to the store in one batch per animation frame and render inside `startTransition`, so keystrokes in the composer stay interactive while the list catches up.

| Approach | Verdict |
|----------|---------|
| ✅ Virtualized list, measured heights, anchored prepends | Constant DOM size; reading position stable both ways |
| ❌ Render everything | Thousands of rows means seconds of layout and a frozen composer |
| ❌ Paginate with "page 2" buttons | Breaks the reading flow of a conversation |

"The cost is accessibility work: rows that aren't rendered don't exist for a screen reader. The list is a `role="log"` region; I announce only new messages from other people in the open channel, keep keyboard focus on a rendered row while arrow keys move it, and expose 'Load older messages' as a real button."

### Deep dive 2: consistency at the cursor (7 min)

"Four things can deliver the same message: the history page, the stream, the REST response to my own send, and a replay after reconnect. The store must show it exactly once, in the right place."

**The rules the store applies to every incoming event:**

1. `seq <= cursor`: already applied. Drop it.
2. `seq = cursor + 1`: apply it and advance the cursor.
3. `seq > cursor + 1`: something was missed. Drop it and reopen the stream from the cursor; the server replays the gap in order.
4. `resync`: the gap is too old to replay. Reload the newest page, keep pending sends, reopen from the new `latestSeq`.

**Matching my own sends.** A pending row carries the `clientMessageId` I generated; the server's copy carries the same key. Whichever arrives first (the REST response or the stream event) replaces the pending row in place; the other finds a confirmed message and is a no-op.

**Stale responses.** Every channel open increments a session counter, and any response that comes back for an older session is dropped, so quickly clicking through three channels can't paint the first one's history into the third. Team and channel lists use the same guard, and the URL, not the store, decides which team and channel are selected.

| Approach | Verdict |
|----------|---------|
| ✅ Server `seq` + client cursor + key matching | Exactly-once display across history, stream, replies and replays |
| ❌ Dedupe by message id only | Catches duplicates but not gaps; a lost event is invisible until reload |
| ❌ Refetch the whole channel on every reconnect | Correct but slow, and it throws away scroll position and pending state |

"What I give up: the store owns real logic (cursor, gap handling, key matching), and it has to be tested like a reducer. That's why the merge rules are pure functions with unit tests rather than code buried in components."

### Deep dive 3: offline, reconnects and many tabs (4 min)

- **Outbox.** Unsent messages are written to IndexedDB before the request. On reload or reconnect the outbox is replayed with the same `clientMessageId`s, so nothing is lost and nothing is duplicated. After three failures a row shows "Not sent · Retry".
- **Reconnect.** `EventSource` reconnects by itself; the store shows a "Reconnecting…" banner only after two seconds so brief blips don't flash. Visibility changes matter too: a tab hidden for an hour reconnects with its cursors when it becomes visible.
- **Many tabs.** Ten open tabs shouldn't mean ten streams. One tab, elected with the Web Locks API, holds the stream and forwards events to the others over `BroadcastChannel`; if it closes, another takes the lock and reconnects with the cursors.
- **Security.** Messages render as text; links are linkified only for `http:` and `https:`; attachments open through short-lived signed URLs on a separate domain; a strict Content-Security-Policy backs it up.

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| First load of a channel | Skeleton rows at real message height | The store is `loading` for the first page only |
| Loading older history | A small spinner row at the top; reading position kept | Anchored prepend |
| Stream disconnected | "Reconnecting…" banner after 2 s; history stays readable | Event stream status in the store |
| Send fails | Dimmed row turns into "Not sent · Retry" | Outbox entry with attempts; retry reuses the key |
| Gap too old (`resync`) | List refreshes in place; pending sends stay at the bottom | Reload the newest page |
| Channel not found or no access | "This channel doesn't exist or you don't have access" | Same copy for `404` either way |
| Empty channel | "No messages yet. Start the conversation!" with the composer focused | The empty state is the onboarding |
| History fetch fails | "Couldn't load messages" with Try again | Retry reopens the channel |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SPA with code splitting | SSR | Authenticated app; the cost is after load |
| Message state | Dedicated store with seq cursor | Generic query cache | Live, event-sourced data needs explicit merge rules |
| List state | TanStack Query for orgs, teams, channels | Hand-written fetching in a store | Caching and retries without bespoke code |
| Ordering | Server `seq` | Client timestamps | One order for everyone |
| Sends | Optimistic + `clientMessageId` + IndexedDB outbox | Wait for the server | Instant feedback without duplicates |
| Reactions | Sets of users, optimistic | Counters | Idempotent under replays |
| Long lists | Virtualized, anchored both ways | Render all | Constant DOM, stable reading position |
| Tabs | One stream, shared over BroadcastChannel | One stream per tab | Fewer connections, one cursor set |

"With more time I'd persist recent pages in IndexedDB so channels open instantly offline, add per-route Web Vitals reporting, and build the typing indicator as a throttled, short-lived event outside the sequenced stream."
