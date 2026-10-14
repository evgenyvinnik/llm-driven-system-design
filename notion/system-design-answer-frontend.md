# 📝 Notion — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "The open page in Notion isn't a view of server data — it's a local replica that the user edits at typing speed while other people's changes stream in. Two things make that hard: a keystroke must never wait for the network and must never be lost, and a remote edit must land without moving my caret or re-rendering 500 blocks. So the core of my design is an editor store with a save queue per block and an ordered stream of operations, and everything else — sidebar, databases — is ordinary cached server state."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, typing and loading budgets, accessibility, offline |
| A — Architecture | 8 min | Component tree, who owns which state, the data layer |
| D — Data model | 5 min | Blocks, operations, save queues, cache keys |
| I — Interface | 5 min | The API and socket protocol as the client sees them; component contracts |
| O — Optimizations & deep dives | 18 min | Safe saving, remote edits and the caret, big pages, offline, security |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm the editing model first, because it decides the whole state design."

### Functional requirements

1. **Block editing**: type into paragraphs, headings, lists, toggles, quotes, callouts and code; `/` opens a type menu; Enter creates a block below; Backspace on an empty block deletes it; arrow keys move between blocks; toggles collapse.
2. **Collaboration**: other people's edits appear within a second; presence shows who's on the page and which block they're in.
3. **Navigation**: a sidebar page tree, breadcrumbs, and deep links to a page and a database view.
4. **Databases**: table, board and list views of the same rows, each with its own filter, sort and grouping.
5. **Sharing**: a share dialog for people with full access; people with view access get a read-only page.
6. **Bad networks**: keep editing offline; changes save when the connection returns.

Out of scope: comments, history UI, templates, uploads, AI, mobile apps.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Keystroke to screen | Same frame (< 16 ms), never waits on the network | Typing lag is the first thing users notice |
| INP | < 200 ms, even while remote edits stream in | A busy page must stay responsive |
| Page open | LCP < 2 s; 500-block page interactive < 1 s after data | The most frequent action |
| JavaScript | < 200 KB gzipped initial; database views and code highlighting lazy | Most sessions are plain pages |
| Convergence | Every client ends with the server's page; no lost keystrokes | Divergent copies destroy trust |
| Accessibility | WCAG 2.2 AA; full keyboard editing; save state announced | An editor is all keyboard |
| Security | No script execution from pasted or shared content | Pages are shared across organizations |

---

## 🏗️ A — Architecture (8 min)

"This is an authenticated app with heavy interaction and no SEO for the editor itself, so a client-rendered SPA with route-level code splitting. A public 'published page' feature would be server-rendered separately."

```
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Routes (TanStack Router) · /page/$pageId?view=… · loader fetches the page snapshot           │
 └─────────┬─────────────────────────┬────────────────────────────────────┬─────────────────────┘
           ▼                         ▼                                    ▼
 ┌──────────────────────┐  ┌─────────────────────┐   ┌──────────────────────────────────────────┐
 │ Sidebar              │  │ Database views      │   │ Page editor                              │
 │ page tree · share    │  │ table·board·list    │   │ BlockEditor · a BlockComponent per block │
 └─────────┬────────────┘  └─────────┬───────────┘   └────────┬─────────────────────────┬───────┘
           │ useQuery                │ useQuery               │ (1) edit     (2) render │
           ▼                         ▼                        ▼                         ▲
 ┌───────────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
 │ Server cache (TanStack Query)                 │   │ Editor store (Zustand)                   │
 │ ['pages', ws] · ['database', id, view]        │   │ blocks · lastSeq · per-block save queue  │
 └──────────────────────┬────────────────────────┘   └──────┬───────────────┬─────────────┬─────┘
                        │ GET               (1) PATCH, POST │               │ ops         │ save
                        ▼                                   ▼               ▲             ▼
 ┌────────────────────────────────────────────────────────────────┐  ┌────────────┐  ┌───────────┐
 │ API client · fetch + AbortSignal                               │  │ WebSocket  │  │ IndexedDB │
 │ expected_version · typed errors (409, 403)                     │  │ sinceSeq   │  │ outbox    │
 └───────────────────────────────┬────────────────────────────────┘  └─────┬──────┘  └───────────┘
                                 │ HTTPS /api/* (session cookie)   WSS /ws │
                                 ▼                                         ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Backend · Page API (REST) · Sync gateway (WebSocket) · see the backend answer                │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Edit (1).** A `BlockComponent` reports a change; the editor store updates the block immediately (the screen never waits) and puts the change in that block's save queue, which saves over REST with the version the edit was based on, and mirrors unsaved changes to IndexedDB.
2. **Remote change (2).** The WebSocket delivers committed operations with a per-page sequence number. The store applies them in order and only the affected `BlockComponent`s re-render.
3. **Everything else** — the sidebar tree, database rows and views — is ordinary server state in TanStack Query, fetched, cached and invalidated by key.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Open page: blocks, `lastSeq`, permission | Editor store (Zustand) | It's a replica reconciled with an operation stream, with optimistic local edits on top; a request cache's refetch model would fight it |
| Unsaved edits per block | Save queues in the store, mirrored to IndexedDB | Must survive a refresh or a closed tab |
| Page tree, database rows, views | TanStack Query | Plain cached reads with dedupe, refetch on focus, invalidation |
| Current page, database view, block anchor | URL (`/page/$pageId?view=…#block`) | Shareable, bookmarkable, back button works |
| Focus, open menus, selection | Component state | Local and ephemeral |
| Presence (who's here, their block) | Editor store, from the socket | Changes often; never persisted |

"The rule: server data that is only *read* lives in the query cache; the document being *edited* lives in a store built for reconciliation. Copying the page tree into Zustand by hand would make me write invalidation; putting the document in the query cache would make me fight refetches overwriting what the user just typed."

### Key interaction: typing

```
User        BlockComponent                 Editor store                  Page API
  │                │                             │                           │
  │ 1 types "hel"  │                             │                           │
  │───────────────▶│                             │                           │
  │                │ 2 updateBlock(b7, content)  │                           │
  │                │────────────────────────────▶│                           │
  │               3 render now, debounce 300 ms  │                           │
  │                │                             │ 4 PATCH b7 {"hel", v4}    │
  │                │                             │──────────────────────────▶│
  │ 5 types "lo"   │                             │                           │
  │───────────────▶│                             │                           │
  │                │ 6 updateBlock(b7, content)  │                           │
  │                │────────────────────────────▶│                           │
  │                │                             │ 7 b7 in flight: coalesce  │
  │                │                             │ 8 200 {b7, v5}            │
  │                │                             │◀──────────────────────────│
  │                │                             │ 9 PATCH b7 {"hello", v5}  │
  │                │                             │──────────────────────────▶│
  │                │                             │ 10 200 {b7, v6}           │
  │                │                             │◀──────────────────────────│
  │                │                             │                           │
```

"One request per block in flight, everything typed meanwhile coalesced into the next one. A fast typist sends two or three saves a second instead of eight, and a slow request can never land after a newer one and erase text."

### Key interaction: remote edits, gaps and reconnects

```
 WebSocket                  Editor store                 Page editor
     │                            │                           │
     │ 1 op seq 41 (lastSeq 40)   │                           │
     │───────────────────────────▶│                           │
     │                            │ 2 apply b3 v9, re-render  │
     │                            │──────────────────────────▶│
     │ 3 op seq 43                │                           │
     │───────────────────────────▶│                           │
     │ 4 gap: sync {sinceSeq 41}  │                           │
     │◀───────────────────────────│                           │
     │ 5 sync {ops 42, 43}        │                           │
     │───────────────────────────▶│                           │
     │                            │ 6 apply both, lastSeq 43  │
     │                            │──────────────────────────▶│
     ··········· network drops, socket reconnects ·············
     │ 7 subscribe {p1, sinceSeq 43}                          │
     │ 8 sync {ops 44..47}        │                           │
     │───────────────────────────▶│                           │
     │                            │                           │
```

"The server numbers every operation on a page without gaps, so the client can do arithmetic: `lastSeq + 1` applies, anything lower is a duplicate, anything higher means I missed something and ask for a replay. A reconnect is just a resubscribe from `lastSeq`."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Where | Notes |
|--------|-------|-------|-------|
| `Block` | `id`, `page_id`, `parent_block_id`, `type`, `content` (rich-text runs), `properties`, `position`, `version` | Editor store: `byId` map + ordered child lists | `position` is a fractional key; children sorted by `(position, id)` |
| `Operation` | `seq`, `op_id`, `type` (insert, update, delete, move), `block_id`, `block` (after the change) | Applied, not stored | Full block in the op makes applying idempotent |
| `SaveQueue` | `pending` fields, `sending` fields, `baseVersion`, `attempts`, `created` | Store, mirrored to IndexedDB | One per block with unsaved edits |
| `Presence` | `user_id`, `user_name`, `block_id` | Store | Expires when the socket says "leave" |
| `PageNode` | `id`, `parent_id`, `title`, `icon`, `position`, `permission` | `['pages', workspaceId]` | The sidebar builds the tree client-side |
| `DatabaseView` | rows, views, `activeViewId` | `['database', id, viewId]` | Board columns grouped client-side |

Three modeling decisions:

- **Normalize blocks by id with ordered child lists.** Rendering subscribes per block (`useBlock(id)`), so an update to one block re-renders one component, not the page. Child order is derived by sorting siblings by `(position, id)` — the tie-breaker matters, or two clients could order equal keys differently.
- **Server data plus unconfirmed fields.** What the user sees is the server's block with the queue's unsaved fields layered on top. That single rule handles echoes of my own saves, remote edits to a block I'm typing in, and snapshot reloads.
- **Never go backwards.** A block is replaced only by a version at least as new as the one shown; operations at or below `lastSeq` are ignored. Duplicates and late messages become harmless.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
GET    /api/pages/{id}                   → {page, blocks, children, seq, permission}
GET    /api/pages?workspace_id=…         → {pages: [{…, permission}]}
POST   /api/blocks                       {id, page_id, after_block_id, type, content} → 201 | 200
PATCH  /api/blocks/{id}                  {fields, expected_version} → 200 {block} | 409 {block}
POST   /api/blocks/{id}/move             {after_block_id | parent_block_id} → 200 {block}
DELETE /api/blocks/{id}                  → 200 | 404 (already gone)
PUT    /api/pages/{id}/permissions       {email, permission} → 200
WS     → subscribe {pageId, sinceSeq} · sync {pageId, sinceSeq} · presence {block_id}
WS     ← subscribed {headSeq, presence} · op {seq, block} · sync {ops} · resync_required · heartbeat
```

- **The client chooses block ids**, so it can render and edit a new block before the server answers, and a retried create returns the same block.
- **`409` carries the current block**, so rebasing needs no extra fetch.
- **The socket never carries edits.** Every write has a status code, which is how the UI knows to say "Saved", "Offline" or "You only have view access".

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<BlockEditor pageId readOnly>` | Renders root blocks; owns keyboard navigation between blocks |
| `<BlockComponent id>` | Subscribes to one block; delegates to a renderer by `type`; reports edits as fields, never as server calls |
| `useEditorStore` actions | `updateBlock(id, fields)`, `addBlock(after, type)`, `deleteBlock(id)`, `receiveOperation(op)`, `receiveSync(ops)` — components never touch the API or the socket directly |
| `wsService.subscribePage(id, () => lastSeq)` | Resubscribes with the current `lastSeq` after every reconnect |
| `<SharePanel pageId>` | Visible only with `full_access`; lists direct and inherited grants |

---

## 🔧 O — Optimizations & Deep Dives (18 min)

### Deep dive 1: typing that never waits and never loses text (6 min)

"The failure I'm designing against: someone types on a train, requests time out, a colleague changes the same block, and the user hits Enter before the first save returns."

**The approach.**

1. **Optimistic, always.** The store applies the edit immediately. The screen never waits for the server.
2. **One save in flight per block.** Each block has a queue with `pending` and `sending` fields. A save starts after a 300 ms pause; edits during a save go to `pending` and are sent together next. Because a block never has two requests racing, a slow one can never land last and erase newer text.
3. **Every save carries `expected_version`.** If a colleague saved first, the server answers `409` with the current block; the store keeps the colleague's other fields, re-applies only this user's fields, and retries.
4. **Errors are classified.** `409` rebases; `404` means someone deleted the block (remove it); `403` means my access changed (drop the edit, reload read-only); network errors and `5xx` keep the edit and retry with exponential backoff while the header says "Offline — changes will be saved".
5. **New blocks are local first.** The store generates the UUID and an optimistic position with the same fractional-key function the server uses, focuses the new block immediately, and queues edits to it behind its create. A create that times out is retried with the same id.

| Approach | Verdict |
|----------|---------|
| ✅ Per-block queue, coalescing, `expected_version`, client ids | No races, no duplicates, conflicts detected |
| ❌ Save on every keystroke | 8 requests/s per typist that race each other |
| ❌ Save on blur only | A crash or closed tab loses a paragraph |
| ❌ Pessimistic saves ("Saving…" blocks input) | Typing waits on the network — the one thing we can't do |

"What I give up: two people typing in the *same* field of the same block resolve as last-writer-wins after the rebase. If that mattered, text inside blocks would move to a CRDT and the queue would carry CRDT updates instead of whole fields."

### Deep dive 2: remote edits without breaking the caret (5 min)

"When Ben edits block b3 while I'm typing in b7, nothing about b7 — my caret, my selection, my IME composition — may change."

- **Granular subscriptions.** Each `BlockComponent` selects only its own block from the store, and components are memoized. An operation on b3 re-renders b3's component and nothing else, which keeps INP low even with 500 blocks and several active collaborators.
- **Uncontrolled `contentEditable`.** The DOM of the block being typed in is the source of truth while focused; React does not rewrite its text on every keystroke. Server confirmations of my own edits change only the version, not the DOM.
- **A remote edit to my focused block** is the rare hard case. The store layers my unsaved fields over the server's block, so my text wins locally until the rebase resolves it; if the remote change replaces text I'm not editing (a type change, say), the caret offset is kept by restoring the selection after the render. Presence warns about this before it happens: a colored marker shows which block each collaborator is in.
- **Ordering.** Operations apply strictly by sequence number; gaps trigger a replay request and duplicate or late messages are ignored.
- **Composition events.** During IME composition (`compositionstart` to `compositionend`), both saves and remote re-renders of the focused block are deferred; interrupting a composition mangles CJK input.

| Approach | Verdict |
|----------|---------|
| ✅ Per-block selectors + uncontrolled focused block | One component re-renders per operation; caret untouched |
| ❌ Re-render the page from a new block array | 500 blocks reconcile on every remote keystroke; caret jumps |
| ❌ Controlled `contentEditable` | React resets the selection on each render |

### Deep dive 3: big pages (3 min)

- **Code splitting.** Database views, the code highlighter and the share dialog are lazy chunks; a plain page loads only the editor.
- **Virtualization, carefully.** Below ~300 blocks I render everything — browser find-in-page, accessibility tree and selection across blocks all just work. Above that I virtualize with `@tanstack/react-virtual`, measuring dynamic heights, always keeping the focused block and the selection's endpoints mounted, and providing an in-app search because browser find can't see unmounted blocks.
- **Snapshot then stream.** The route loader fetches the snapshot (with its `seq`) in parallel with the code chunk; the socket subscribes from that `seq`, so nothing is missed between the fetch and the subscription.

### Deep dive 4: offline (2 min)

The save queues are mirrored to IndexedDB on every change, and a service worker caches the app shell and recently opened pages. Offline, edits keep going into the queues; on reconnect the socket resubscribes from `lastSeq`, the store applies what others did, and the queues flush with their base versions — conflicts come back as `409`s and are rebased like any other. The UI is honest about it: "Offline — 12 changes will be saved" in an `aria-live` region.

### Deep dive 5: accessibility and security (2 min)

- **Keyboard model.** Arrow keys move between blocks, Enter and Backspace create and remove, `/` opens a menu built as an ARIA `listbox` with roving focus, `Escape` closes it. Each block has an accessible role (`heading` with the right level, `listitem`, `region` for toggles with `aria-expanded`).
- **Status announcements.** "Saving", "Saved", "Offline" and "Only view access" are announced through a polite `aria-live` region — never on every keystroke.
- **Rich text is data, not HTML.** Content is an array of text runs with annotations, rendered as text nodes, never through `innerHTML`. Paste is sanitized to plain runs. Links allow only `http:`, `https:` and `mailto:`, so a shared page can't carry a `javascript:` URL into someone else's session. A strict Content-Security-Policy backs this up.

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| Opening a page | Title and skeleton blocks at real heights | Route loader; skeleton sized from the snapshot's block count when cached |
| Socket reconnecting | Small "Reconnecting…" indicator; editing continues | Saves go over REST; resubscribe replays what was missed |
| Offline | "Offline — changes will be saved" with a count | Queues persist in IndexedDB and retry with backoff |
| Save conflict | Nothing visible in the common case | `409` → rebase automatically |
| Access removed mid-edit | Page turns read-only with a notice | `403` → drop queued edits for that page, reload |
| Too far behind (`resync_required`) | A quick refresh of the page content; my unsaved text stays | Reload snapshot, layer unsaved fields on top |
| Empty page | "Type '/' for commands" placeholder in the first block | Clicking it creates a block |
| View-only page | "View only" badge, no handles or menus, text still selectable | `permission` from the snapshot |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Open page state | Replica store + ordered op stream | TanStack Query for the document | Reconciliation, not refetching |
| Other server state | TanStack Query | Hand-written Zustand caches | Dedupe and invalidation for free |
| Saving | Per-block queue + `expected_version` | Save per keystroke or on blur | No races, no lost text |
| New blocks | Client ids + optimistic positions | Wait for the server | Instant Enter, retry-safe |
| Remote edits | Per-block selectors, uncontrolled focused block | Page-level re-render | Caret stays put, INP stays low |
| Rendering | Full DOM below ~300 blocks, virtualized above | Always virtualize | Find, selection and accessibility work for normal pages |
| Writes | REST with status codes | Socket messages | Honest save states |

"With more time I'd add a CRDT for text inside blocks so two people can type in one paragraph, drag-and-drop with keyboard alternatives, and per-route Web Vitals from real users."
