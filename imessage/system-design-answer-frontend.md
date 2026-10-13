# 💬 iMessage — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "The messaging client is half of a delivery protocol. Messages reach it three ways — a live push, a catch-up batch after reconnecting, and a history page — in any order and sometimes twice, yet the thread must always show the server's order. Sends have to survive tunnels, reloads and double taps without ever appearing twice. And a status like 'Read' must never slide back to 'Delivered'. Get those rules right in one place and the UI on top is ordinary React."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 4 min | Features, performance, offline and accessibility targets |
| A — Architecture | 8 min | Components, who owns which state, the data layer, three key interactions |
| D — Data model | 5 min | Client entities, the store shape and the merge rules |
| I — Interface | 4 min | The protocol as the client sees it; component contracts |
| O — Optimizations & deep dives | 20 min | Safe optimistic sends, idempotent apply, a fast long thread, security |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (4 min)

"I'll design the web client, but the same rules apply to the native apps — they all speak the same protocol."

### Functional requirements

1. **Conversation list** with last-message previews, unread badges and search; new activity moves a conversation to the top.
2. **Thread** with long history (thousands of messages), replies, reactions and typing indicators.
3. **Composer** with instant feedback: the bubble appears immediately and moves through Sending → Sent → Delivered → Read.
4. **Multi-device consistency**: what I send from my phone appears here; reading on my phone clears the badge here.
5. **Offline**: read recent conversations offline; compose offline and have it send on reconnect.
6. **Attachments** encrypted on the device before upload (I'll touch on it only briefly).

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Send feedback | Bubble on screen < 50 ms after Enter | Chat must feel instant even when the network isn't |
| Delivery to screen | p99 < 500 ms when both sides are online | Matches the backend's latency budget |
| INP | < 200 ms while typing in a 10,000-message thread | Long threads must not make the composer laggy |
| LCP | < 2.0 s for the conversation list on mid-range mobile | Most opens are "check new messages" |
| JavaScript | < 200 KB gzipped initial; emoji picker and media viewer lazy | Crypto libraries are heavy; load them off the critical path |
| Memory | Constant DOM size regardless of thread length | Virtualize the thread |
| Accessibility | WCAG 2.2 AA; new messages announced; full keyboard use | A thread is a live region |
| Security | Keys never leave the device unencrypted; message text can't execute | Message content is attacker-controlled |

---

## 🏗️ A — Architecture (8 min)

"It's an authenticated, highly interactive app with no SEO, so a client-rendered SPA with route-level code splitting. The interesting part is the data layer: a WebSocket client with an outbox, and one store that every incoming message flows through."

```
 ┌────────────────────────────────────────────────────────────────────────────────────┐
 │ App shell · TanStack Router · "/" renders AuthForm or the chat layout              │
 └─────────────┬───────────────────────────────────────┬──────────────────────────────┘
               ▼                                       ▼
 ┌───────────────────────────┐          ┌─────────────────────────────────────────────┐
 │ ConversationList          │          │ ChatView                                    │
 │ unread badges, search     │          │ thread (role=log), composer, banner         │
 └─────────────┬─────────────┘          └───────┬─────────────────────▲───────────────┘
               │ select, load                   │ (1) send  (3) older │ renders
               ▼                                ▼                     │
 ┌────────────────────────────────────────────────────────────────────┴───────────────┐
 │ Chat store (Zustand) · conversations · messages by seq · receipts                  │
 │ sole owner of server data; Auth store: user, token, install ID                     │
 └────────┬─────────────────────────────┬───────────────────▲───────────────────┬─────┘
          │ ?before_seq                 │ send · ack · read │ frames            │ persist
          ▼                             ▼                   │                   ▼
 ┌────────────────────┐       ┌─────────────────────────────┴──────┐    ┌──────────────────────┐
 │ API client · REST  │       │ WebSocket client                   │    │ IndexedDB (prod.)    │
 │ lists, history     │       │ outbox, backoff + jitter           │    │ messages, outbox     │
 └────────┬───────────┘       └────────────────────────────────────┘    └──────────────────────┘
          │ HTTPS                               ▲ (2) WSS frames, both ways
          ▼                                     ▼
 ┌────────────────────────────────────────────────────────────────────────────────────┐
 │ Backend API · WebSocket gateway + Message Service                                  │
 └────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Send (1).** ChatView calls `sendMessage`; the store adds an optimistic bubble with a client message ID and hands the frame to the WebSocket client, which sends it or keeps it in its outbox until the socket is back.
2. **Receive (2).** Frames from the server — live messages, catch-up batches, receipts — go into the store through one merge path that dedupes and orders by sequence number, then the views re-render.
3. **Load older (3).** Scrolling to the top asks the store for the page before the oldest loaded message (`?before_seq=`), fetched over REST and merged with the same rules.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Conversations, messages, receipts, typing | Chat store (Zustand) | One place applies every incoming frame with the same merge rules |
| User, session token, device install ID | Auth store + `localStorage` | Needed by the socket and every request; the install ID must survive logout |
| Open conversation | URL (`/c/$id`) | Deep links and the back button work |
| Draft text, scroll anchor, typing timer | Component state | Never shared |
| Unsent messages, recent history, keys | IndexedDB (production) | Survive reloads and work offline |

"Why not TanStack Query for messages? It's a great fit for request/response data — and I'd use it for the conversation list and history pages — but messages mostly arrive as pushes. A push isn't a refetch of a query; it's a merge into a list that several sources write. I want one function that every source calls, so the rules about ordering, duplicates and statuses live in exactly one place."

### Key interaction: sending a message

```
User     Composer                  Chat store             WS client                   Server
  │          │                          │                     │                          │
  │ 1 Enter  │                          │                     │                          │
  │─────────▶│                          │                     │                          │
  │          │ 2 sendMessage(text)      │                     │                          │
  │          │─────────────────────────▶│                     │                          │
  │          │                          │ 3 bubble K, "sending"                          │
  │          │                          │ 4 send {K}          │                          │
  │          │                          │────────────────────▶│                          │
  │          │                          │                     │ 5 offline: outbox        │
  ··································· socket reopens ·····································
  │          │                          │                     │ 6 send {K}               │
  │          │                          │                     │─────────────────────────▶│
  │          │                          │                     │ 7 message_sent {K, seq}  │
  │          │                          │                     │◀─────────────────────────│
  │          │                          │ 8 swap bubble by K  │                          │
  │          │                          │◀────────────────────│                          │
  │          │ 9 "Sent", placed by seq  │                     │                          │
  │          │◀─────────────────────────│                     │                          │
  │          │                          │                     │                          │
```

"The client ID K is generated once, when the user presses Enter. Every retry — the outbox flush after reconnecting, the Retry button after an error, a reload that finds the message in IndexedDB — sends the same K, and the server answers with the original message instead of creating a second one. Step 8 swaps the optimistic bubble for the server's copy by K, so the bubble keeps its React key and doesn't flash."

### Key interaction: receiving a message

```
Server                  WS client           Chat store               Thread view
   │                        │                    │                        │
   │ 1 new_message seq 813  │                    │                        │
   │───────────────────────▶│                    │                        │
   │                        │ 2 receiveMessages  │                        │
   │                        │───────────────────▶│                        │
   │                        │                    │ 3 dedupe, sort by seq  │
   │                        │ 4 ack [813]        │                        │
   │                        │◀───────────────────│                        │
   │                        │                    │ 5 render + announce    │
   │                        │                    │───────────────────────▶│
   │                        │                    │ 6 visible: markAsRead  │
   │                        │                    │◀───────────────────────│
   │                        │ 7 read 813         │                        │
   │                        │◀───────────────────│                        │
   │ 8 read (watermark)     │                    │                        │
   │◀───────────────────────│                    │                        │
   │                        │                    │                        │
```

"Every message I apply gets acknowledged (step 4) — that's what removes it from this device's server-side mailbox. Read receipts are sent only for what's actually visible, and they're a watermark ('read up to 813'), so sending one twice or out of order is harmless."

### Key interaction: reconnecting

```
 Browser                  WS client           Chat store               Server
    │                         │                    │                      │
    │ 1 online / tab visible  │                    │                      │
    │────────────────────────▶│                    │                      │
    │                         │ 2 connect (backoff + jitter)              │
    │                         │──────────────────────────────────────────▶│
    │                         │ 3 sync_batch, has_more                    │
    │                         │◀──────────────────────────────────────────│
    │                         │ 4 receiveMessages  │                      │
    │                         │───────────────────▶│                      │
    │                         │                    │ 5 ack [ids]          │
    │                         │                    │─────────────────────▶│
    │                         │                    │ 6 sync (next batch)  │
    │                         │                    │─────────────────────▶│
    │                         │ 7 sync_batch, done                        │
    │                         │◀──────────────────────────────────────────│
    │                         │ 8 flush outbox (same K)                   │
    │                         │──────────────────────────────────────────▶│
    │                         │                    │                      │
```

"On reconnect the server pushes everything this device missed, in batches. I apply each batch, ack it, and ask for the next while `has_more` is set. Then the outbox flushes — the same client IDs, so a message that actually made it before the drop isn't duplicated."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Keyed by | Notes |
|--------|-------|----------|-------|
| `Conversation` | `id`, `type`, `participants`, `lastMessage` (with `seq`), `unreadCount` | `id`, sorted by last activity | `lastMessage.seq` tells me what the unread count already covers |
| `Message` | `id`, `conversationId`, `seq?`, `senderId`, `content`, `createdAt`, `status`, `clientMessageId?`, `reactions` | Per conversation, ordered by `seq` | Optimistic messages have no `seq` yet and sort last |
| `Status` | `sending` → `sent` → `delivered` → `read`; `failed` | On my own messages only | Only ever moves forward |
| `ReadWatermark` | `conversationId`, `userId`, `seq` | Per participant | "Read" is a seq, not a flag per message |
| `OutboxEntry` | `clientMessageId`, frame, attempts | IndexedDB `outbox` (production) | Replayed on reconnect and on reload |
| `Session` | `user`, `token`, `deviceId`, `installId` | Auth store | `installId` makes this browser one stable device |

**The merge rules** are the heart of the data model, and they live in one pure module:

1. **Dedupe** by server ID, or by client ID for my own sends — so the server's ack replaces the optimistic bubble instead of adding a second one.
2. **Order** by `seq`; never by arrival time, and never by `createdAt`, which comes from different clocks.
3. **Never regress a status**: a late "Delivered" can't overwrite "Read".
4. **Tombstones remove**: a message that arrives deleted disappears.

In production, IndexedDB mirrors the store: `messages` keyed `[conversationId, seq]` so a thread reads as one range, `outbox`, `keys` (non-extractable `CryptoKey` objects) and `meta` for each conversation's highest known seq.

---

## 🔌 I — Interface (4 min)

### The protocol as the client sees it

```
WSS  /ws?token=…                       one socket per tab; frames below
  → send_message {conversationId, content, clientMessageId}
  → ack {messageIds}                     after applying anything that came from the server
  → sync                                 next catch-up batch
  → read {conversationId, messageId}     advance my read watermark
  → typing {conversationId, isTyping}    dropped, not queued, while offline
  ← sync_batch {messages, hasMore}       sent on connect and on sync
  ← new_message · message_sent · delivery_receipt · read_receipt · typing · error
GET  /api/conversations                 list with lastMessage.seq and unreadCount
GET  /api/messages/conversation/{id}    ?before_seq=&after_seq=&limit= → oldest-first page with statuses
POST /api/messages/conversation/{id}    REST send; Idempotency-Key header for clients without a socket
```

- `error` frames carry the `clientMessageId` and a code — `rate_limited`, `forbidden`, `invalid` — so the store can mark exactly that bubble as failed.
- History pages carry `status` for my own messages, derived from receipts on the server, so "Delivered" and "Read" survive a reload.

### Component contracts

| Component / module | Contract |
|--------------------|----------|
| `<ConversationList>` | Reads conversations from the store; `onSelect(id)` |
| `<ChatView conversation>` | Renders the thread for one conversation; owns draft and scroll anchor |
| `<MessageBubble message isOwn onRetry?>` | Pure; shows status, and "Not delivered · Retry" for failed sends |
| `<ConnectionBanner>` | Shows "Reconnecting…" from the socket's status |
| `lib/messageList` | `upsertMessage`, `mergeMessages`, `markDelivered`, `markReadUpTo`, `hasGap` — pure, unit-tested |
| WebSocket client | `send(frame)` queues while closed; `subscribe`; `subscribeStatus`; reconnects forever |

---

## 🔧 O — Optimizations & Deep Dives (20 min)

### Deep dive 1: optimistic sends that never duplicate (7 min)

"The failure I'm designing for: I type on a train, the request times out, and I can't tell whether it went. If the app retries and the server creates a second message, my friend sees it twice — permanently, on every device."

**The approach.** On Enter I create the bubble immediately with status `sending` and a client ID from `crypto.randomUUID()` (with a `getRandomValues` fallback, because `randomUUID` only exists in secure contexts). The frame goes to the WebSocket client, which sends it or keeps it in an outbox. In production the outbox is in IndexedDB, so a reload or a crash doesn't lose what I typed. Every retry reuses the ID; the server enforces uniqueness on it inside the insert and answers a retry with the original message and its seq.

**Statuses.** `sending` until the server's ack, which carries the seq; then the bubble moves into its final position. `delivered` when a `delivery_receipt` names it; `read` when a read watermark from someone else passes its seq. Errors carry the client ID, so only that bubble turns into "Not delivered · Retry", and Retry resends with the same ID.

| Approach | Verdict |
|----------|---------|
| ✅ Optimistic bubble + client ID + persistent outbox | Instant feedback; retries are safe by construction |
| ❌ Wait for the server before showing anything | 200 ms of nothing on every send, and nothing at all offline |
| ❌ Optimistic without a client ID | Every retry is a new message; duplicates after every tunnel |
| ❌ Disable the button while pending | Stops double taps, not retries after timeouts or reloads |

"What I give up: an optimistic bubble can sit in 'Sending' for a long time when offline, so the banner has to say messages are queued; and a message the user deletes from the outbox before it sends needs a cancel path."

### Deep dive 2: applying at-least-once input exactly once (7 min)

"The backend delivers at least once — that's the price of never losing anything. The client turns that into exactly-once *display*."

1. **One merge path.** Live pushes, catch-up batches and history pages all go through the same `receiveMessages`, which dedupes by ID and places by seq. A message that arrives three ways renders once, in the right spot.
2. **Ack everything applied, including duplicates.** The ack is what clears the message from this device's server-side mailbox; skipping duplicates would leave rows behind to be resent forever.
3. **Detect gaps.** If a live push arrives with seq 812 when the highest seq I know for that conversation is 810, something was dropped — a lost pub/sub frame, a race during reconnect. I don't guess; I ask the server for a sync, and its mailbox still has 811.
4. **Unread counts without double counting.** The conversation list from the server already counts unread messages up to its `lastMessage.seq`. When a catch-up batch arrives, I only count messages above that seq; otherwise every reconnect would inflate badges.
5. **Read sync across my devices.** A read receipt from *me* on another device clears the badge here if its seq covers the latest message; one from someone else marks my messages up to that seq as Read.
6. **Reconnect forever, with jitter.** Exponential backoff from 1 s to a 30 s cap, randomized to half-to-full of the ceiling so a server restart doesn't bring every client back in the same second. The `online` event and the tab becoming visible skip the wait.

| Approach | Verdict |
|----------|---------|
| ✅ Merge by ID, order by seq, gap → sync | Correct for any arrival order and any duplicate |
| ❌ Append in arrival order | Two pushes racing through different servers render swapped |
| ❌ Sort by `createdAt` | Different clocks; ties |
| ❌ Refetch the whole thread on every push | Correct, but heavy, and throws away scroll position |

"What I give up: the store must remember the highest seq per conversation, and the gap rule assumes seqs are dense — a deleted message leaves a hole that can trigger a harmless extra sync."

**Multiple tabs.** Two tabs in one browser are one device with two sockets; each receives pushes and each acks, and the server's ack is idempotent. In production I'd elect one tab as the socket owner with a `BroadcastChannel` (or use a `SharedWorker`) so the device holds one connection and one IndexedDB writer.

### Deep dive 3: a long thread that stays fast (4 min)

- **Virtualize.** `@tanstack/react-virtual` with measured heights renders only what's on screen plus overscan, so a 10,000-message thread has the DOM of a 30-message one.
- **Stick to the bottom, but only when the user is there.** New messages scroll into view only if the user was already at the bottom; otherwise a "New messages ↓" pill appears. Scrolling is keyed on the last message's ID, not on any list change — loading an older page must not yank the user to the bottom.
- **Prepend without a jump.** "Load earlier" fetches `before_seq` = the oldest loaded seq. Before inserting I record the first visible message and its offset, then restore it after render.
- **Reserve space.** Images and link previews carry their dimensions in the message, so placeholders have the right size and CLS stays near zero.
- **Accessibility.** The thread is `role="log"` with `aria-live="polite"`, so new messages are announced without stealing focus. When older history loads, I don't want fifty messages read aloud, so history pages are inserted outside the announced region or with `aria-busy` set during the load.

### Deep dive 4: security in the browser (2 min)

- **Keys.** Device keys are generated with Web Crypto as non-extractable `CryptoKey` objects and stored in IndexedDB as such, so script can use them but cannot read them out. Decryption runs in a Web Worker to keep the main thread free.
- **Message text is attacker-controlled.** It's rendered as text, never HTML. Links are re-checked for `http:`/`https:` before becoming `href`s and open with `rel="noopener noreferrer"`. Link previews are generated by the *sender's* device, because a server that can't read messages can't fetch previews. A strict CSP backs this up.
- **Tokens.** The session token travels in the WebSocket query string today; I'd move it to a short-lived ticket fetched over HTTPS right before connecting, so long-lived tokens don't land in proxy logs.

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| First load | Skeleton list rows, then cached conversations from IndexedDB | Network refresh merges in behind |
| Socket down | "Reconnecting… messages you send will go out when the connection is back" | Banner from the socket's status; sends go to the outbox |
| Send rejected | "Not delivered · Retry" under that bubble | `error` frame carries the client ID; Retry reuses it |
| Rate limited | Same, plus "Try again in 30 s" | The error carries `retryAfter` |
| Session expired or device revoked | Back to sign-in; unsent messages kept | Close codes 4001/4003 stop reconnecting |
| Long history | "Load earlier messages" at the top, spinner while loading | Keyset page `before_seq` |
| No conversations | Empty state with "New message" focused | The empty state is the onboarding |
| Someone stops typing without an event | Dots disappear after ~6 s | Typing indicators expire on the client |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SPA with code splitting | SSR | Authenticated, real-time, no SEO |
| Message state | One store, one merge path | Query cache per source | Pushes are merges, not refetches |
| Ordering | Server `seq` | Arrival order or `createdAt` | Same order on every device |
| Sending | Optimistic + client ID + outbox | Pessimistic; optimistic without ID | Instant and duplicate-free |
| Delivery | Ack everything applied; gap → sync | Trust the push stream | Pushes can be lost; the mailbox can't |
| Long threads | Virtualization + keyset pages | Render everything | Constant DOM, stable INP |
| Reconnect | Unlimited backoff with jitter | Give up after N tries | A messaging app must always come back |

"With more time I'd move the outbox and recent history into IndexedDB so the app opens instantly and offline, add single-socket tab leadership with a `BroadcastChannel`, and wire the decrypt path into a Web Worker so long threads stay smooth."
