# Design iCloud Sync — frontend interview

> “I’ll design the browser experience for a private file drive and photo library.
> The central promise is that users can tell whether their work is only on this
> device, committed to the cloud, or waiting for a conflict decision.”

This is a proposed 45-minute design. The repository implements an online subset;
its boundaries appear at the end. The design is independent of Apple's internals.

## 🎯 Requirements and scope — 5 minutes

I would first clarify what “sync” means for this client. Are we building a native
filesystem agent, a browser file manager, or both? I’ll focus on the browser and
assume native clients use the same server protocol.

A browser can accept user-selected files and maintain an explicit offline library.
I would not promise that it watches arbitrary folders or keeps working indefinitely
after the user closes the tab.

The primary journeys are:

- Browse folders, upload files, and download a selected revision.
- Rename, move, or delete an item while showing the pending outcome.
- Resume an interrupted upload without losing the selected bytes.
- See another device's changes and resolve genuinely concurrent edits.
- Browse a large photo library using thumbnails, then open a larger preview.

I would defer shared albums, collaborative document editing, and system-wide photo
backup. Those change permissions, conflict semantics, and platform capabilities.

For sizing, assume a heavy account can have 100,000 photos and thousands of files
in a folder. A phone may have a slow network, little free storage, and a short-lived
browser session. Those constraints drive pagination, virtualization, and persistence.

My proposed experience targets are an immediate pending indicator after an action,
p95 metadata reads below 200 ms in-region, and online change visibility within a few
seconds of cloud commit. These are targets to validate, not measured results.

I would establish three distinct states before drawing any components:

| User-visible state | What the system has established |
|--------------------|---------------------------------|
| Saved on this device | Intent and required bytes are persisted locally |
| Saved to cloud | Server returned a durable revision or matching receipt |
| Available offline here | This device has verified, retained bytes for that revision |

An upload reaching 100% on the network establishes none of the last two by itself.
The server can still reject publication, and another device may not have downloaded
anything yet.

## 🏗️ High-level architecture — 6 minutes

> “I’ll separate views, authoritative client state, and synchronization. Components
> express what the user wants; one coordinator owns retries and reconciliation.”

```
BROWSER — one account/session generation; confirmed data and pending intent stay distinct

┌────────────────────────────┐            ┌────────────────────────────┐            ┌────────────────────────────┐
│ Drive / Photos / Viewer    │1 UI/state  │ Account-scoped state       │2 intents   │ Sync coordinator           │
│ Folder list, grid, preview │◀──────────▶│ Entities + query pages     │◀──────────▶│ Command ID / replay cursor │
│ Selection and focus        │            │ Pending UI projection      │            │ Reconcile, retry, resolve  │
└────────────────────────────┘            └────────────────────────────┘            └────────────────────────────┘
               ▲                                         ▲                                         ▲
               │                                         │                                         │
               │ preview / result                        │ 3 save / hydrate                        │ send / event
               │                                         │                                         │
               ▼                                         ▼                                         ▼
┌────────────────────────────┐            ┌────────────────────────────┐            ┌────────────────────────────┐
│ Media loader + cache       │            │ IndexedDB + staged bytes   │4 bytes     │ Transfer + network adapter │
│ Thumbnails / preview       │            │ Confirmed data + cursor    │◀──────────▶│ Hash worker / bounded I/O  │
│ Bounded decoded images     │            │ Durable pending commands   │            │ HTTP replies + push hints  │
└────────────────────────────┘            └────────────────────────────┘            └────────────────────────────┘
               ▲                                                                                   ▲
               │                                                                                   │
               │ 5 private fetch                                                                   │ 6 REST / WS
               │                NETWORK / AUTHORIZATION BOUNDARY                                   │
───────────────┼───────────────────────────────────────────────────────────────────────────────────┼──────────────
               │                                                                                   │
               ▼                                                                                   ▼
┌────────────────────────────┐                                                      ┌────────────────────────────┐
│ Private media interface    │                                                      │ Sync / upload interface    │
│ Authorized derivatives     │                                                      │ Sessions + saved receipts  │
│ Versioned originals        │        REMOTE CONTRACTS                              │ Change feed / reset        │
└────────────────────────────┘                                                      └────────────────────────────┘
```

The upper region is one browser account/session. IndexedDB survives a reload; the
views and in-memory state do not. The lower region exposes two remote contracts:
authorized media reads and sync/upload commands. Every network path crosses account
authorization, including a cached photo read.

The numbered arrows make ownership and the return paths explicit:

1. Views submit actions and render state snapshots; selection and focus stay in the view.
2. The coordinator accepts intent and reconciles receipts or changes into confirmed state.
3. Persistence saves pending work and hydrates the confirmed baseline and cursor on reload.
4. Transfer workers read staged bytes and record verified progress under a stable job ID.
5. The media loader fetches only the derivatives or originals the current view needs.
6. The adapter exchanges commands, receipts, change pages, and push hints with the cloud.

The state layer owns normalized file and photo entities, query membership, pending
commands, and a session generation. Views own transient details such as an open menu,
selection focus, and the current preview. The journal owns durable unsent work.

Walk through an upload with me. The user selects a file in Drive. The coordinator
freezes the destination folder, stores the intent and bytes when offline persistence
is available, and projects a pending item into the visible list.

The transport negotiates an upload session and sends chunks. Publication returns a
revision and receipt. The coordinator reconciles that result into confirmed state
and retires the journal entry. The view changes its status from pending to cloud saved.

A push hint takes the reverse logical path: transport tells the coordinator that
something changed; the coordinator pulls changes and updates state; subscribed views
render those entities. A hint does not directly become an authoritative file row.

After a reconnect, that same loop starts from the journal's cursor. After an ambiguous
upload response, it queries the existing command receipt before creating any new work.

For Photos, the entity contains derivative readiness and private media URLs. The grid
loads thumbnails for visible rows, while the viewer requests a preview for a stable
photo ID. The original is a separate explicit transfer.

I would start with React and a small external state store. The correctness boundary
is the command and reconciliation model, not the choice between Zustand and Redux.
A query cache can manage remote pages, but it does not replace the durable journal.

## 💾 Data ownership and interfaces — 5 minutes

I would avoid storing several mutable copies of the same photo in the grid, favorites
view, and viewer. Each view refers to the same entity ID and has its own ordered list
of matching IDs.

| State | Owner | Lifetime |
|-------|-------|----------|
| Current account and session generation | Authentication boundary | Until logout or account switch |
| Confirmed entities and revisions | Entity cache | Account-scoped, refreshable |
| Folder/filter pages and continuation | Query cache | Keyed by account and query |
| Pending command and base revision | Coordinator and journal | Until a terminal server outcome |
| Staged file bytes and upload session | Transfer journal | Until committed, canceled, or explicitly discarded |
| Selection and keyboard focus | Current view | Retained only while meaningful |
| Previewed photo ID | Viewer | Independent of array position |
| Durable feed cursor | Journal | Advances with applied change pages |

The folder path or stable folder ID belongs in the URL so refresh and back navigation
work. Search and filter parameters also need a reproducible query identity. Selection
is not part of a server response and should survive a safe entity refresh by ID.

These are proposed server contracts, not the repository's current route inventory:

| Method | Endpoint | Frontend needs from it |
|--------|----------|------------------------|
| GET | `/folders/:id/items` | Stable IDs, revisions, opaque continuation |
| POST | `/upload-sessions` | Account-bound session and missing-chunk plan |
| PUT | `/upload-sessions/:id/chunks/:index` | Verified acknowledgement for one chunk |
| POST | `/files/:id/commands` | Durable receipt or explicit conflict/rejection |
| GET | `/commands/:id` | Resolve an ambiguous response |
| GET | `/changes?cursor=...` | Ordered changes, next cursor, or reset required |
| GET | `/photos` | Query-bound page and derivative status |
| POST | `/conflicts/:id/resolve` | Outcome conditioned on the observed siblings |

Commands carry a stable identity, desired operation, and base revision. Responses
carry enough revision information to reconcile duplicates and events arriving out of
order. Errors distinguish expired authentication, quota failure, conflict, and retryable
transport failure; the UI should not turn all four into “Try again.”

The client also validates response shape at its boundary. TypeScript types alone
cannot validate JSON received over the network.

## 🔧 Deep dive 1: Offline intent and reconciliation — 8 minutes

> “I’d persist an intent before claiming it is safely queued. An optimistic row is
> a projection of that intent, not evidence that the cloud has accepted it.”

### The local write boundary

For a rename, the journal records the account, file ID, observed revision, desired
name, and command ID. For an upload, it also needs the actual bytes or a durable,
permissioned handle whose availability has been checked.

A filename, size, or hash is not enough to resume after reload. If local storage cannot
retain the bytes, I would explain that the upload requires the tab to stay open or
that the user will need to select the file again.

Persisting can fail because the device is full, permission changes, or storage is
unavailable. In that case, the UI must not display a durable offline acknowledgement.
It can offer an online-only upload and keep that distinction visible.

I would model the lifecycle with a small state diagram:

```
┌──────────────────────────┐
│ Intent + bytes persisted │
└──────────────────────────┘
              │ transfer and publish
              ▼
┌──────────────────────────┐
│ Await durable outcome    │
└──────────────────────────┘
              │ receipt / conflict / rejection
              ▼
┌──────────────────────────┐
│ Reconcile or ask user    │
└──────────────────────────┘
```

The journal remains the recovery source when the tab crashes in the middle state.
A timeout is an unknown outcome, not proof of rejection. On restart, the coordinator
looks up the existing command before creating a replacement.

### Applying remote changes safely

I would apply a change page and its next cursor in the same local transaction. If the
browser crashes afterward, it can replay safely; if it crashes beforehand, it re-fetches
the page. Deduplication uses revision or event identity, not arrival order.

A reconnect, tab focus, or push hint triggers catch-up. If the cursor is too old, the
server requests a snapshot reset. The client replaces its confirmed baseline while
preserving pending intents and then rebases or surfaces them against that baseline.

For example, a user renames a file offline while another device deletes it. Replaying
the rename should not silently recreate the file. The coordinator presents the missing
base and offers an explicit recovery path if the user still has the content.

For two independent content edits, I would show both versions with device, revision,
and available preview information. “Keep both” is a server command preserving two
manifests, not a client-side copy of the filename.

A resolution names the siblings the user actually reviewed. If another version arrives
before submission, the server returns a refreshed conflict rather than discarding that
new work under an old decision.

### Decision and cost

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Durable journal with optimistic projection | Responsive actions survive reload and can be reconciled | Storage pressure, schema migration, and recovery logic |
| ❌ In-memory optimistic mutations alone | Easy to build and fast online | Reload loses intent; timeout can create duplicate actions |

For this product, losing an unsent file after showing “saved” breaks the primary
promise. The persistence cost is justified. It still cannot guarantee browser storage
will survive every eviction or user data-clear action; durable local status is scoped
to the browser's storage capabilities and the explicit retention policy.

I would also isolate the journal by account, stop workers on logout, invalidate request
generations, and avoid showing prior-account entities during a new login. An old response
must not repopulate a cleared store.

## 🔧 Deep dive 2: Resumable transfers and honest progress — 8 minutes

> “I’d make transfer progress about verified work, and keep cloud publication as a
> separate final step. Sending the last byte is not the same as saving the file.”

### Keep expensive work off the interaction path

Hashing and chunk preparation belong in a worker with bounded concurrency. I would
process slices rather than copy an entire multi-gigabyte file into the main thread.
Cancellation stops scheduling new chunks and releases resources when active work ends.

The transfer record captures the original destination and selected content identity.
Navigating to another folder must not redirect later files in the same batch. Each
file has its own job ID; filenames can collide and are poor progress-map keys.

The server returns which chunks are already verified for this upload session. The
client uploads only missing chunks and records acknowledgements. The server verifies
bytes itself; it does not trust a client-provided digest as proof of possession.

If connectivity drops after a chunk upload but before its response, the client asks
for session state. Retrying the same chunk identity is safe. If a session expires,
the client reconciles what can be reused under a new authorized session.

Once all chunks are verified, the client submits a manifest and base revision. That
commit can still fail because of a conflict, quota change, or revoked permission.
The bytes remain staged until the recovery policy resolves the outcome.

### Progress and cancellation semantics

| Display | Meaning |
|---------|---------|
| Preparing | Reading, hashing, or persisting selected content |
| Uploading | Some required chunks have not been acknowledged |
| Verifying / saving | Transfer is complete; publication is not yet confirmed |
| Saved to cloud | Matching durable receipt received |
| Needs attention | Conflict, missing local bytes, or a terminal rejection |

I would report acknowledged bytes for resumable progress and expose transient network
progress separately if useful. Progress may need to be recalculated when an expired
session loses staged chunks; pretending it is still 100% would mislead the user.

Canceling a transfer stops future work but cannot retract a server commit that already
happened. If the final outcome is unknown, the UI says it is checking. Removing an
already committed file is a distinct delete command.

A batch should continue independent files after one failure and report per-file status.
Large files should not monopolize all upload slots; I would use a small fair scheduler
and reduce background work on constrained devices.

### Why not always upload whole files?

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Resumable chunks for large files | Bounded retries and explicit recovery | Session lifecycle, manifests, and more requests |
| ❌ Whole-file retries for every upload | Simple endpoint and client | A late failure repeats all bytes and may exceed memory |

Whole-file upload remains a reasonable fast path for small files. The hard requirement
is recoverability for large transfers over unreliable networks, not chunking everything
for its own sake.

Fixed chunk boundaries are easy to explain and implement. An insertion can change all
later chunk hashes, so I would not promise ideal delta savings. Content-defined chunking
is a later optimization if measured workloads justify the extra CPU and complexity.

### Push is a scheduling hint

I would use a persistent notification channel while the app is active. WebSocket is
reasonable if the protocol also needs client messages; SSE plus REST is sufficient for
one-way hints. Either way, reconnect uses jitter, an authenticated session generation,
and a pull from the saved cursor.

A burst of fifty hints should schedule one catch-up loop, not fifty full folder reloads.
The loop drains pages, reconciles state, and checks again if a hint arrived while it was
running. Connection state and synchronization freshness remain separate indicators.

## 🔧 Deep dive 3: A large, accessible photo library — 8 minutes

> “I would bound three different resources: rendered elements, downloaded images,
> and decoded image memory. Virtualization only directly solves the first.”

### Rendering and pagination

The grid virtualizes rows because all cells in a row share a vertical position. Column
count follows container width, with a predictable thumbnail aspect ratio. A resize
preserves the anchor photo rather than interpreting the old row index literally.

I would request a small first page, render a useful viewport, and fetch more as the
user approaches the end. If the first page does not fill the viewport, fetching must
continue without waiting for a scroll event that cannot occur.

Cursor pages are bound to the account, filter, ordering, and snapshot policy. When the
user switches to Favorites, old All Photos responses are discarded by request generation.
A per-query in-flight guard prevents duplicate page requests.

The entity cache deduplicates IDs before extending ordered membership. A new upload
may belong at the start of All Photos but not in the current album or Favorites view.
A push update changes query membership deliberately rather than blindly prepending it.

### Image and viewer budgets

Thumbnails serve the grid. A preview serves the viewer. Originals are downloaded for
explicit high-resolution or offline use. Fetching every original would waste bandwidth
and decoded memory even if the DOM contained only a few visible cells.

I would keep a small prefetch window around the viewport and cancel stale requests.
The viewer may prefetch the next preview, but not an entire album. Object URLs and
other retained buffers need cleanup when the account or active photo changes.

The viewer tracks a photo ID. If an earlier page changes order, an array index could
suddenly show a different person's photo. Deleting the current item deliberately selects
an adjacent surviving ID or closes the viewer and restores focus.

For an offline photo, the UI records the exact retained revision and verifies the local
bytes before claiming availability. Eviction removes that claim as well as the bytes.
A server-side “download started” row cannot establish browser-side persistence.

### Keyboard and assistive technology

Each photo needs a meaningful accessible name and a keyboard selection/open action.
Double-click and a decorative image alone are insufficient. I would expose selection
state, predictable arrow-key navigation, and the logical position in the collection.

When the focused item leaves the rendered window, the virtualizer must preserve or
intentionally move focus. Opening the viewer traps focus appropriately, supports Escape,
and returns focus to the originating item, scrolling it into view if necessary.

Loading and error states need announcements without narrating every chunk. Empty,
filtered-empty, offline, and failed states should be distinct. A “Load more” fallback
helps keyboard users and makes pagination recoverable after an automatic fetch fails.

### Decision and cost

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Row virtualization plus derivative budgets | Bounded render and image work for large libraries | Focus, resize, and scroll-anchor coordination |
| ❌ Render all photos with lazy images | Straightforward layout | DOM and accessibility tree grow with every page |

I would keep ordinary rendering for small result sets where its simplicity is useful.
For the assumed 100,000-photo account, the accumulated DOM becomes the problem even
when native image lazy loading defers some downloads.

The cost of virtualization is interaction complexity, so I would test it with real
keyboard navigation, screen readers, narrow layouts, and changing data. A frame-rate
number without those conditions is not a meaningful success claim.

## 📈 Scaling, failure tests, and observability — 4 minutes

The first frontend bottlenecks are main-thread hashing, whole-file buffers, excessive
list reloads, and decoded images. I would measure long tasks, memory growth, interaction
latency, and time from cloud commit to reconciled display on representative devices.

The most revealing tests are sequences, not isolated happy-path clicks:

1. Close the tab after local persistence, reopen it, and recover the same command.
2. Lose the commit response and verify that retry does not create another file.
3. Rename offline while another device deletes or edits the same revision.
4. Switch filters or accounts while old page requests are still in flight.
5. Reconnect after the change-feed retention window and preserve pending local work.
6. Open a photo, reorder its page remotely, and preserve viewer identity and focus.

Logs can include command IDs and lifecycle transitions without recording filenames,
photo URLs, or content. Client telemetry should distinguish “no connection” from
“connected but behind” and “bytes uploaded but publication unknown.”

For rollout, I would first ship correct online commands and account-scoped state,
then resumable transfers, then persistent offline intents. Offline support multiplies
the recovery cases, so it should build on an already explicit command contract.

## ⚖️ Trade-offs and implementation boundary — 1 minute

| Decision | Chosen | Cost accepted |
|----------|--------|---------------|
| Offline actions | Durable journal and projected state | Persistence and reconciliation complexity |
| Large transfers | Verified resumable chunks | Upload sessions and manifest lifecycle |
| Large libraries | Virtual rows and derivative budgets | Focus and scroll-anchor management |
| Notifications | Hints followed by durable pull | A second delivery mechanism |

The local repository has React/Zustand views, whole-file uploads, a four-column
virtualized photo grid, lazy thumbnails, previews, and process-local WebSocket hints.
It has no persistent journal, transfer sessions, conflict dialog, or replay-on-reconnect.

Its current stores also lack request-generation guards and account-wide reset; photo
pagination uses offsets and the viewer uses an array index. Those are implementation
gaps, not properties I would rely on in the proposed design.

> “The important contract is that every visible acknowledgement corresponds to a
> real durability boundary. Once that is clear, retries, offline work, and rendering
> optimizations can improve the experience without hiding what has actually saved.”

[Implementation details](./architecture.md) · [Run the demo](./README.md)
