# 📚 Kindle Community Highlights — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "The web reader is one of several devices a reader owns, and it is often offline. So the hard part isn't the highlight card. It's making a local database the UI's source of truth, so a highlight paints the instant you tap, survives closing the tab mid-sync, and merges with an edit made on the Kindle without flicker or a lost note. The second hard part is rendering: highlights are character ranges in a book's text, they overlap, and they share the page with community passages that may only appear once enough readers back them."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, performance, offline and accessibility targets |
| A — Architecture | 8 min | Layers, who owns which state, the key interactions |
| D — Data model | 5 min | Client entities, IndexedDB stores, cache keys |
| I — Interface | 5 min | The API as the client sees it; component contracts |
| O — Optimizations & deep dives | 20 min | Offline edits, drawing highlights, live updates and privacy UI |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll start with who uses this and where, because 'offline' and 'mid-range phone' set most of the budget."

### Functional requirements

1. **Read with highlights**: the book text with my highlights painted in their colors, plus a subtle underline on popular passages ("1,247 readers").
2. **Highlight**: select text, pick a color, optionally add a note. Edit or delete later, from the page or the library.
3. **Library**: all my books and highlights, searchable, for heavy readers with 20,000 highlights.
4. **Book tabs**: My highlights, Popular, and Friends (people I follow).
5. **Trending** across books, **export** (Markdown, CSV, JSON), and **privacy settings** (default visibility, opt out of community counts).
6. **Offline**: reading, highlighting and editing work with no network; everything syncs when it returns.

Out of scope: the e-book renderer's pagination engine, purchases, book clubs.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Highlight paint | Same frame as the tap (< 16 ms of work) | Highlighting is a reading gesture; a spinner breaks flow |
| INP | < 200 ms, including text selection and library search | Selection handles and typing must stay responsive |
| LCP | < 2.0 s on a mid-range Android over 4G; < 1 s on repeat visits from cache | Readers open the app many times a day |
| Cross-device sync | < 2 s from a Kindle edit to this screen | "It's already on my phone" is the product |
| Offline | Full read, highlight and edit; nothing lost if the tab closes | Commutes, flights, cabins |
| JavaScript | < 200 KB gzipped for the library; reader view and export lazy-loaded | Most sessions open one book |
| Accessibility | WCAG 2.2 AA: keyboard selection, announced results, no color-only meaning | Highlight colors carry user meaning |

---

## 🏗️ A — Architecture (8 min)

"This is an authenticated, offline-capable app with no SEO, so I'd build a client-rendered SPA with a service worker caching the app shell, and code-split per route. Server rendering would speed up first paint for pages nobody crawls, and it does nothing for the case I care about, which is opening the app on a train with no signal."

```
  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │ Routes · /library?q=  /read/$bookId  /books/$bookId?tab=popular  /trending          │
  └─────────┬───────────────────────────┬──────────────────────────────┬────────────────┘
            ▼                           ▼                              ▼
  ┌──────────────────────┐  ┌──────────────────────────┐  ┌────────────────────────────┐
  │ Library · search     │  │ Reader view              │  │ Book tabs · Popular,       │
  │ virtualized list     │  │ text + highlight overlay │  │ Friends · Trending page    │
  └─────────┬────────────┘  └─────┬──────────────┬─────┘  └─────────────┬──────────────┘
            │ live query           │ (1) create,  │ live query          │ (3) popular,
            │                      │ edit, delete │                     │ friends
            ▼                      ▼              ▼                     ▼
  ┌───────────────────────────────────────────────────────┐  ┌────────────────────────────┐
  │ IndexedDB · my highlights, outbox, feed cursor        │  │ TanStack Query cache       │
  │ the only source the UI reads its own highlights from  │  │ popular, friends, trending │
  └──────────────┬─────────────────────────▲──────────────┘  └─────────────┬──────────────┘
                 │ queued ops              │ (2) rows + cursor             │
                 ▼                         │                               │
  ┌───────────────────────────────────────────────────────┐                │
  │ Sync engine in a SharedWorker · push · pull · socket  │                │
  └──────────────┬─────────────────────────▲──────────────┘                │
                 │ POST push, GET changes  │ WSS "changed N"               │ GET, cached
                 ▼                         │                               ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │ Backend API · /api/sync/push · /api/sync/changes · /api/sync/ws · /api/books/{id}/… │
  └─────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Write (1).** The Reader view writes a new or edited highlight *and* its outbox entry into IndexedDB in one transaction. Live queries repaint it immediately. The sync engine pushes the outbox when it can.
2. **Sync (2).** When the socket says "changed N", or on reconnect, the sync engine pulls `changes since <cursor>` and writes the rows and the new cursor into IndexedDB in one transaction. Every view showing those highlights re-renders through its live query.
3. **Community (3).** Popular passages, friends' highlights and trending are other people's data. They are fetched through TanStack Query, cached per book, and never written to the reader's own store.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| My highlights, outbox, feed cursor | IndexedDB, read through live queries | Survives reloads and offline; one source for every view and tab |
| Popular, friends, trending | TanStack Query cache | Server-owned, read-only, needs caching and refetching, not syncing |
| Tab, search query, trending period | URL search params | Shareable, back-button friendly, survives reload |
| Session, sync status, pending count | Zustand | Tiny, global, needed by the header and route guards |
| Selection menu, open editor | Component state | Ephemeral |

"The rule: my own highlights never live in the query cache, and other people's data never lives in my sync store. Mixing them is how you end up 'syncing' a friend's highlight or caching your own edit until a refetch erases it."

### Key interaction: highlighting a sentence

```
Reader                   Reader view          IndexedDB         Outbox              Sync API
   │                          │                   │                │                    │
   │ 1 select, tap Highlight  │                   │                │                    │
   │─────────────────────────▶│                   │                │                    │
   │                          │ 2 range -> 1041-1121               │                    │
   │                          │ 3 put, id = uuid  │                │                    │
   │                          │──────────────────▶│                │                    │
   │ 4 painted now            │                   │                │                    │
   │◀─────────────────────────│                   │                │                    │
   │                          │ 5 enqueue create                   │                    │
   │                          │───────────────────────────────────▶│                    │
   │                          │                   │                │ 6 POST /sync/push  │
   │                          │                   │                │───────────────────▶│
   │                          │                   │                │ 7 created, seq 58  │
   │                          │                   │                │◀───────────────────│
   │                          │                   │ 8 mark synced  │                    │
   │                          │                   │◀───────────────│                    │
   │                          │                   │                │                    │
```

"The id is minted on the device in step 3, which is the whole idempotency story: if the push in step 6 times out and retries, the server finds the same id and answers `replayed` instead of creating a second highlight. The reader sees the highlight in step 4, before the network is involved at all."

### Key interaction: an edit arrives from the Kindle

```
Sync gateway     Sync engine                Sync API    IndexedDB             Book view
      │               │                         │           │                     │
      │ 1 changed 57  │                         │           │                     │
      │──────────────▶│                         │           │                     │
      │               │ 2 GET changes?since=55  │           │                     │
      │               │────────────────────────▶│           │                     │
      │               │ 3 2 rows, cursor 57     │           │                     │
      │               │◀────────────────────────│           │                     │
      │               │ 4 put rows + cursor, 1 tx           │                     │
      │               │────────────────────────────────────▶│                     │
      │               │                         │           │ 5 live query fires  │
      │               │                         │           │────────────────────▶│
      │               │                         │            6 re-render 2 cards  │
      │               │                         │           │                     │
```

"The socket carries a hint, not the data. If it drops, the next reconnect does the same pull from the same cursor, so a missed poke costs latency, never correctness. Writing the rows and the cursor in one IndexedDB transaction means a crash can't leave a cursor that claims rows we never stored."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Where / key | Notes |
|--------|-------|-------------|-------|
| `Highlight` | `id`, `bookId`, `start`, `end`, `text`, `note`, `color`, `visibility`, `syncSeq`, `fieldClock`, `deletedAt`, `pending` | IndexedDB `highlights`, key `id`; indexes `[bookId, start]` and `updatedAt` | `pending` marks local changes not yet acknowledged |
| `OutboxOp` | `opId`, `kind` (create/update/delete), `id`, `changes`, `clientUpdatedAt` | IndexedDB `outbox`, auto-increment key | Insertion order is push order |
| `SyncState` | `cursor`, `lastPullAt`, `deviceId` | IndexedDB `meta` | Written in the same transaction as the rows it covers |
| `PopularPassage` | `passageId`, `text`, `readerCount`, `start`, `end` | Query key `['popular', bookId]`, stale after 5 min | Server never returns fewer than k readers |
| `FriendHighlight` | `id`, `username`, `text`, `note`, `color`, `visibility` | `['friends', bookId]` | Read-only, attributed |
| `TrendingPassage` | `bookId`, `bookTitle`, `passageId`, `text`, `readerCount` | `['trending', days]` | Key includes the book: passage ids repeat across books |

Two modeling decisions:

- **Normalized by id, queried by book.** A highlight is stored once. The reader view asks for `bookId`'s highlights ordered by `start`, and the library asks by `updatedAt`. Neither copies rows into component state, so an edit can't be fresh in one view and stale in another.
- **Tombstones stay until the server confirms them.** A delete marks the row `deletedAt` and queues an op. Views filter tombstones out, so the highlight disappears immediately, but the row stays until the push succeeds, which keeps a pull that raced the push from resurrecting it.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
POST /api/sync/push            {ops[]} + X-Device-Id → one result per op, in order
GET  /api/sync/changes?since=N → {changes, cursor, hasMore, resync}
WSS  /api/sync/ws              send hello {token, deviceId}; receive welcome, changed {seq}
GET  /api/books/{id}/popular   → passages with ≥ k readers (cacheable)
GET  /api/books/{id}/friends-highlights → people I follow: public, or friends if mutual
GET  /api/trending?days=7      → passages that gained readers recently
PATCH /api/settings/privacy    {highlightVisibility?, includeInAggregation?}
```

- **Push results drive the UI, and every result is final.** `applied`/`created`: clear `pending`. `replayed`/`unchanged`: same, since it was a retry. `superseded`: a newer edit from another device won, so show the server's version and say so. `gone`: deleted elsewhere, so remove it and say so. `rejected`: drop the op and show why. The client never retries a rejected op, so one malformed edit can't wedge the outbox.
- **`clientUpdatedAt`** is the device clock at the moment of the edit. The server merges field by field on it, so it's captured when the reader acts, not when the push happens.
- **`resync: true`** means my cursor is older than the server keeps tombstones (90 days), so I clear my synced highlights (keeping pending ones) and pull from zero with a progress bar.

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `useBookHighlights(bookId)` | Live query over IndexedDB; re-renders on any local or synced change |
| `<ReaderView bookId>` | Renders text and paints highlights for visible pages only |
| `<SelectionMenu onHighlight(range, color)>` | Appears at the selection; keyboard reachable; announces the result |
| `<HighlightCard highlight pending onEdit onDelete>` | Shows a "waiting to sync" marker while `pending` |
| `useSyncStatus()` | `{status: live / connecting / offline, pendingOps}` for the header |

---

## 🔧 O — Optimizations & Deep Dives (20 min)

### Deep dive 1: offline edits that are never lost or duplicated (8 min)

"The failure I'm designing for: a reader edits three notes on a flight, closes the laptop, and later edits one of them again on the Kindle. All three edits must survive, and the conflict must resolve the same way on every device."

```
Reader                Book page              Outbox            Sync client   Sync API
   │                      │                     │                   │            │
   │ 1 edit note offline  │                     │                   │            │
   │─────────────────────▶│                     │                   │            │
   │                      │ 2 enqueue op + ts   │                   │            │
   │                      │────────────────────▶│                   │            │
   │ 3 shown, "waiting"   │                     │                   │            │
   │◀─────────────────────│                     │                   │            │
   ····························· network comes back ······························
   │                      │                     │ 4 welcome: flush  │            │
   │                      │                     │◀──────────────────│            │
   │                      │                     │ 5 POST /sync/push              │
   │                      │                     │───────────────────────────────▶│
   │                      │                     │ 6 superseded                   │
   │                      │                     │◀───────────────────────────────│
   │                      │ 7 drop op, refetch  │                   │            │
   │                      │◀────────────────────│                   │            │
   │ 8 "newer edit kept"  │                     │                   │            │
   │◀─────────────────────│                     │                   │            │
   │                      │                     │                   │            │
```

**Local first.** Every user action is one IndexedDB transaction that updates the highlight and appends an outbox op. The UI renders only from IndexedDB, so "optimistic" isn't a special mode with a rollback path. It's just the normal render of local state, and the server's answer is reconciled into the same store.

**Pushing.** The sync engine pushes the outbox in order, up to 100 ops per batch, single-flight (one push in flight, later edits wait for the next). It deletes exactly the ops it sent once their results arrive. A network failure keeps them, a 5xx keeps them, and an expired session keeps them until the reader logs back in. Every op is idempotent on the server (create by client id, edits by field stamps, delete by tombstone), so pushing a batch twice after a lost response is harmless. A delete squashes queued edits of the same highlight, since they'd be pointless.

**Reconciling.** A pull can land while ops are still queued. The engine writes the server rows, then re-applies pending ops on top: the "server snapshot plus my pending edits" rule. That's what stops an edit from flickering back to its old value for a second.

**One engine for all tabs.** Three open tabs mustn't mean three sockets and three racing pushes of the same outbox. The sync engine runs in a SharedWorker; where that's unavailable, tabs elect a leader with the Web Locks API and the others listen on a BroadcastChannel. IndexedDB is shared, so live queries in every tab update together.

| Approach | Verdict |
|----------|---------|
| ✅ Local-first IndexedDB + outbox | Instant paint; survives reload, crash and offline; one code path |
| ❌ In-memory optimistic update with rollback | Lost on tab close; rollback logic per mutation; no offline at all |
| ❌ Wait for the server | Highlighting in a tunnel just fails |
| ❌ localStorage outbox | Synchronous, ~5 MB, strings only, blocks the main thread on every write; fine for a demo, wrong for 20K highlights |

"What I give up is simplicity. There's a sync engine, a schema migration story for IndexedDB, and a storage budget. I'd call `navigator.storage.persist()` so the browser doesn't evict the store under pressure, and treat quota errors as a visible state. Conflicts resolve last-writer-wins per field, so a truly concurrent edit to the same note keeps the newer one, and the UI says 'A newer edit from another device was kept' rather than pretending."

### Deep dive 2: drawing highlights on the page (7 min)

"Highlights are character ranges, `[1041, 1121)`, over text the renderer split into paragraphs. Three problems: map ranges to the DOM, handle overlaps, and do it without janking page turns."

1. **Ranges to DOM.** Each paragraph element knows its starting offset. For a highlight, I find the start and end paragraphs by binary search, walk text nodes to the exact characters, and build a DOM `Range`.
2. **Painting without touching the DOM.** I register those ranges with the **CSS Custom Highlight API** (`CSS.highlights` plus a `::highlight(yellow)` rule per color). The browser paints them like a selection: no wrapper spans, no reflow, no fighting the text renderer, and overlapping highlights just layer. Where the API is missing, I fall back to splitting overlaps into non-overlapping segments with a sweep over the start and end points, and wrapping each segment in a `<mark>`.
3. **Only visible pages.** Highlights are registered for the visible pages plus one on each side, recomputed on page turn. A chapter with 300 highlights costs nothing until you scroll to it.
4. **Selection to range.** On `selectionchange` (debounced to one per frame) I snap the selection to word boundaries, compute offsets, and show the menu next to it. Keyboard users select with Shift+arrows and open the menu with a shortcut. The result is announced through an `aria-live` region ("Highlighted in yellow"), and colors also carry a text label, so meaning isn't color-only.
5. **Popular passages** are fetched once per book open, cached for 5 minutes, and drawn as a dotted underline with "1,247 readers" on hover or focus. The client never filters by count; the server guarantees nothing below k is ever returned.

The library is the other heavy view: 20,000 highlights render through `@tanstack/react-virtual` (constant DOM size), search runs against an IndexedDB index in a Web Worker, and typing stays in a `startTransition` so INP holds.

| Approach | Verdict |
|----------|---------|
| ✅ CSS Custom Highlight API + segment fallback | No DOM mutation; overlaps are free; selection keeps working |
| ❌ Wrapping spans everywhere | Splits text nodes, breaks the renderer's measurements and the user's selection, and costs a reflow per change |
| ❌ Canvas overlay | Breaks find-in-page, screen readers and native selection |

### Deep dive 3: live updates, privacy UI and security (5 min)

- **Live updates.** One socket per browser (in the SharedWorker), reconnecting with exponential backoff plus jitter (1 s doubling to 30 s), so a server restart isn't hit by every client in the same second. The token goes in the first message, not the URL. On `welcome`, the engine flushes the outbox and pulls if the server's latest sequence is ahead of my cursor.
- **Privacy that people can understand.** The visibility picker defaults to the reader's setting and says what each option means: "Friends — people you follow who follow you back", "Public — can count toward Popular Highlights once 10 readers highlight the passage". The opt-out toggle says "takes a few minutes to leave existing counts". A Popular tab that's empty for a small book explains the threshold instead of looking broken.
- **Security.** Notes and highlighted text are rendered as text, never HTML; a strict Content-Security-Policy backs that up. The session is an `HttpOnly` cookie rather than a token in `localStorage`, where any XSS could read it. Mutations require a custom header, and logout wipes IndexedDB, because the store holds someone's private reading life.

---

## 🧯 Loading, Error and Empty States (2 min)

"Most of an offline-first app's experience is its imperfect states, so I design those up front."

| Situation | What the reader sees | How |
|-----------|----------------------|-----|
| Opening the library | My highlights instantly, from IndexedDB | The network only refreshes in the background |
| Offline | "Offline — 3 changes waiting" in the header; everything still works | Status and pending count from the sync engine, in a polite live region |
| Edit lost to a newer one | "A newer edit from another device was kept" | `superseded` result from the push |
| Highlight deleted elsewhere | The card fades out with "Deleted on another device" | `gone` result, or a tombstone in the pull |
| Cursor too old | "Refreshing your highlights…" with progress | `resync: true`: clear synced rows, keep pending ones, pull from zero |
| Session expired | Log-in dialog; queued changes kept and pushed after login | Outbox survives auth errors |
| Storage quota exceeded | "Free up space to keep highlights offline" | Catch `QuotaExceededError`; keep pushing online |
| Popular tab empty | "Popular passages appear once enough readers highlight them" | Explains the privacy threshold instead of an empty box |
| No highlights in a book | Short hint showing how to select text | The empty state is the onboarding |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SPA + service worker shell | SSR | Authenticated, offline, no SEO |
| My highlights | IndexedDB as source of truth + outbox | Query cache with optimistic updates | Survives offline and tab close; no rollback paths |
| Community data | TanStack Query cache | Synced into IndexedDB | Read-only server data needs caching, not syncing |
| Idempotency | Client-minted ids | Disable the button and hope | Retries after a timeout can't duplicate |
| Live updates | Socket poke, then cursor pull | Push payloads over the socket | A missed poke costs latency, never data |
| Multi-tab | One engine in a SharedWorker | One per tab | One socket, no racing pushes |
| Painting | CSS Custom Highlight API | Wrapping spans | No DOM mutation; overlaps for free |

"With more time I'd add highlight creation from the Kindle-style 'popular passage' underline (one tap to make it mine), a Web Worker export that streams a large Markdown file, and real-user INP tracking split between the reader view and the library."
