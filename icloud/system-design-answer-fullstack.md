# Design iCloud Sync — fullstack interview

> “I’ll follow a file from a user's selection to a durable cloud revision and then
> onto another device. That gives us a shared way to reason about the UI, APIs,
> storage, and failures without drawing the entire infrastructure at once.”

This is a proposed 45-minute design for a file drive and private photo library.
It is independent of Apple's internals. The local implementation is compared at the end.

## 🎯 Requirements and product contract — 5 minutes

I would first establish the client scope. I’ll design a browser application with
explicit uploads and offline copies, plus a server protocol that native clients could
also use. A browser is not a background filesystem agent.

The main user journey is selecting a file, seeing its progress, opening it on another
device, and recovering when the network interrupts that sequence. Folder operations,
conflict resolution, and a photo gallery extend that same journey.

I would include:

- Files and folders with stable identities, rename, move, and delete.
- Large transfers that can resume after interruption.
- Concurrent edit preservation and deliberate resolution.
- A photo library with thumbnails, previews, favorites, and private albums.
- Clear distinctions between pending, cloud saved, and available offline.

I would defer shared editing, public links, and a general application-data platform.
Each would introduce another substantial permission or merge model.

Assume one million active accounts, three devices per account, ten mutations per
account per day, and 20 GiB of retained logical content per account. That is roughly
116 average mutations per second and 19 PiB of logical storage.

A 10× peak is about 1,160 mutations per second. If each mutation contributes 1 MiB
of new content, daily ingress is about 9.5 TiB. These are planning assumptions; we
have no basis for assuming a particular deduplication saving.

On the frontend, a heavy user might have 100,000 photos, a slow connection, and a
nearly full device. The design must avoid loading that entire library into the DOM
or downloading all originals.

Proposed targets are sub-200 ms p95 metadata reads in-region, visible local progress
without blocking interaction, and online change hints within a few seconds of commit.
Durability and recoverability matter more than making every action look instantaneous.

| Product statement | Evidence required |
|-------------------|-------------------|
| “Queued on this device” | Intent and needed bytes persisted locally |
| “Saved to cloud” | Durable server receipt identifies the accepted revision |
| “Available offline” | This device verified and retained the revision's bytes |
| “Needs resolution” | Server retained concurrent siblings requiring a decision |

The backend and frontend must agree on these meanings. A green checkmark based only
on bytes leaving the browser would promise more than the system knows.

## 🏗️ High-level architecture — 6 minutes

> “The client owns local intent and presentation. The metadata service owns accepted
> revisions. Object storage owns immutable bytes, and workers derive cheaper views
> of those bytes for the photo experience.”

```
BROWSER — visible state, durable intent, and bounded transfer work

┌────────────────────────────┐            ┌────────────────────────────┐            ┌────────────────────────────┐
│ Drive / Photo views        │1 UI/state  │ Client state + coordinator │2 transfer  │ Transfer / media worker    │
│ Pending / cloud saved      │◀──────────▶│ Command ID / base revision │◀──────────▶│ Hash and stream chunks     │
│ Preview / conflict choices │            │ Reconcile receipt / replay │            │ Thumbnails / previews      │
└────────────────────────────┘            └────────────────────────────┘            └────────────────────────────┘
                                                ▲              ▲                                   ▲
                                                │              │                                   │
                                                │ persist      │                                   │
               ┌────────────────────────────────┘              │                                   │
               ▲                                               │ 3 REST / hints                    │ 4 bytes / media
               │                                               │                                   │
               │ restore on reload                             │                                   │
               │                          CLOUD / AUTH         │                                   │
               ▼                                               ▼                                   ▼
┌────────────────────────────┐            ┌────────────────────────────┐            ┌────────────────────────────┐
│ Local journal + bytes      │            │ REST / WS gateway + API    │verify      │ Private transfer edge      │
│ Account-bound pending work │            │ Auth + revision admission  │◀──────────▶│ Verify staged bytes        │
│ Baseline / replay cursor   │            │ Receipts / changes / hints │◀─────┐     │ Authorize media reads      │
└────────────────────────────┘            └────────────────────────────┘      │     └────────────────────────────┘
                                                         ▲                    │                    ▲
                                                         │                    │                    │
                                                         │ 5 atomic commit    │                    │ put / get
                                                         │                    │                    │
                                                         ▼                    │                    ▼
Retry the same command ID                 ┌────────────────────────────┐      │     ┌────────────────────────────┐
after an ambiguous reply.                 │ PostgreSQL account shard   │      │     │ Private object storage     │
                                          │ Revision + receipt + feed  │      │     │ Protected staged uploads   │
                                          │ Outbox: one transaction    │      │     │ Immutable committed bytes  │
Hints trigger a pull;                     └────────────────────────────┘      │     └────────────────────────────┘
they do not commit state.                                │                    │                    ▲
                                                         │                    │                    │
                                                         │                    │hints / readiness   │
                                                         │                    │                    │
                                                         │ 6 committed events │                    │ 7 read / write
                                                         │                    │                    │
                                                         ▼                    │                    ▼
                                          ┌────────────────────────────┐      │     ┌────────────────────────────┐
                                          │ Outbox / event relay       │jobs  │     │ Photo workers              │
                                          │ Committed change hints     │◀─────┴────▶│ Versioned derivatives      │
                                          │ Durable derivative jobs    │            │ Commit readiness via API   │
                                          └────────────────────────────┘            └────────────────────────────┘
```

The client coordinator is the boundary between user actions and transport. It keeps
pending commands, schedules transfers, and reconciles receipts and remote changes.
Views read account-scoped state instead of issuing unrelated retries themselves.

The local journal belongs to the device; the API, metadata store, object store, and
workers belong to the cloud. The diagram keeps the major journeys visible:

- **Intent and bytes (1–4):** stage local work, run bounded transfers, and submit the
  same command identity until a durable result is known. Results reconcile into the UI.
- **Commit and notification (5–6):** commit the revision, receipt, feed, and outbox
  together. The relay sends hints through the gateway; clients then pull the feed.
- **Photo readiness (7):** workers read originals and write derivatives. Completion
  returns through admission, while queue acknowledgements complete the background job.

The return lane on the right carries hints and worker readiness. The client-facing
connection carries receipts and replay pages as well as commands, so recovery uses the
same components as the successful path.

The API authenticates and admits mutations. A PostgreSQL shard holds namespace state,
revision manifests, command receipts, a durable change feed, and an outbox. I would
partition by account so most consistency decisions stay within one shard.

The media path stages large uploads and serves authorized immutable content. It is
separate from metadata admission so a slow transfer does not hold a database lock.
Admission verifies that the proposed manifest references ready, protected objects.

The outbox drives derivative jobs and notification hints. Workers read originals,
write versioned derivatives, and publish readiness. A hint prompts the coordinator
to pull the durable feed; it does not replace that feed.

Let me walk the arrows for a photo upload. The browser freezes the destination and
stages a journal entry and bytes. The transfer edge accepts verified chunks. The API
then commits an original revision and its receipt.

The browser can now say “saved to cloud.” A worker generates derivatives, commits
their readiness, and emits a hint. Another browser pulls the change and renders the
thumbnail. That browser has not downloaded the original unless it chooses to do so.

I would start with a small number of deployable services. These boxes define ownership
and failure boundaries; they do not require every responsibility to be a microservice.
The online version can ship before the complete offline client, using the same commands.

## 💾 Shared model and interfaces — 5 minutes

A file has a stable ID and one or more current revision heads. Its path is a namespace
property. A revision is immutable and points to an ordered manifest of verified chunks.
A photo adds derivative status and user metadata around an original revision.

| Entity | Server responsibility | Client representation |
|--------|-----------------------|-----------------------|
| File | Ownership, parent/name, current heads | ID-keyed entity plus folder membership |
| Revision | Immutable manifest, size, digest, causal context | Confirmed revision and local availability |
| Command | Account-scoped identity, payload binding, outcome | Pending intent and retry lifecycle |
| Upload session | Verified chunks, expiry, reservation | Progress and resume record |
| Change page | Ordered committed changes and next cursor | Atomic application with saved cursor |
| Photo | Original and derivative readiness | Grid thumbnail and stable viewer ID |
| Conflict | Retained siblings and resolution condition | Comparison view and explicit choices |

The frontend separates confirmed entities from pending projections. A rename can
appear immediately without mutating the confirmed revision that a conflict dialog
or retry still needs to reference.

The journal is account-scoped. Transient state such as menus and focus stays in the
view; query pages are keyed by account, folder, filters, and ordering. A viewer uses
a stable photo ID, not the position in a mutable array.

I would agree on these proposed contracts before implementing either side:

| Method | Endpoint | Shared meaning |
|--------|----------|----------------|
| GET | `/folders/:id/items` | Bounded, query-consistent directory page |
| POST | `/upload-sessions` | Begin an authorized resumable transfer |
| PUT | `/upload-sessions/:id/chunks/:index` | Acknowledge verified bytes |
| POST | `/files/:id/commands` | Admit intent against a base revision |
| GET | `/commands/:id` | Resolve a lost or ambiguous response |
| GET | `/changes?cursor=...` | Recover committed changes or request a reset |
| POST | `/conflicts/:id/resolve` | Resolve the specific observed siblings |
| GET | `/photos` | Page photo metadata and derivative readiness |

A command result distinguishes accepted, conflict, terminal rejection, and retryable
failure. A transport timeout is a separate unknown outcome. The frontend cannot safely
collapse all of them into a generic rollback followed by a new request.

Types describe the intended contract, while runtime validation checks actual messages.
The server also validates ownership, bounds, and revision conditions regardless of
what the frontend has already checked.

## 🔧 Deep dive 1: The upload acknowledgement crosses two systems — 8 minutes

> “I’d design the upload as staging followed by publication. That is the point where
> a responsive frontend and a correct backend need exactly the same state machine.”

### Before the first request

The browser captures the file, destination folder, base revision for an overwrite,
and a stable command identity. Navigation afterward must not change the destination
of later files in that batch.

For durable offline acceptance, the browser stores the bytes or an explicitly supported
persistent handle as well as the metadata. Remembering the filename does not allow
recovery after a tab closes.

If storage is full or unavailable, the UI offers an online-only transfer with a clear
limitation. It must not show “saved on this device” before persistence succeeds.
The view can still show that it is preparing the upload.

Hashing and chunk preparation run outside the main interaction thread with bounded
memory. Each transfer has a unique job ID; identical filenames are separate jobs.
A fair scheduler prevents a large upload from starving every small file.

### Stage the bytes, then admit the revision

The server creates an account-bound upload session with expiry and quota reservation.
It verifies uploaded lengths and digests before acknowledging chunks. The client can
query session state after a lost chunk response.

Staged objects are protected from cleanup while the session is valid. Once all chunks
are verified, the client submits the immutable manifest and its command identity.
The server rechecks permission, current heads, and quota at publication.

A metadata transaction records the new revision or conflict sibling, updates heads,
writes the command receipt, appends a durable change, and creates an outbox entry.
The server returns success only after that transaction commits.

The object store and SQL do not become one distributed transaction. Instead, staging
ensures bytes exist first, and a lifecycle protocol protects them while the SQL
transaction decides whether they become referenced by a committed revision.

```
┌──────────────────────────┐
│ Local intent and bytes   │
└──────────────────────────┘
              │ resumable transfer
              ▼
┌──────────────────────────┐
│ Verified staged objects  │
└──────────────────────────┘
              │ atomic metadata admission
              ▼
┌──────────────────────────┐
│ Revision + receipt saved │
└──────────────────────────┘
              │ reconcile by command ID
              ▼
┌──────────────────────────┐
│ UI: saved to cloud       │
└──────────────────────────┘
```

### The lost-response case

Suppose the server commits and the connection drops before the browser receives the
response. The UI stays in “checking outcome”; it does not create another command.
The coordinator asks for the original receipt or retries the identical command.

The server scopes receipts by account and binds them to the payload. Reusing a command
ID with changed content is rejected. The receipt and mutation share a transaction,
so the server cannot acknowledge a mutation it forgot to record.

Receipt retention must cover the supported retry window. If a very old client returns
after that window, it reconciles explicitly rather than assuming an expired command
identity is safe to reuse.

Canceling an in-flight request cannot undo a commit. If cancellation races publication,
the client discovers the outcome first; deleting an already saved revision is a new,
visible user action with its own command identity.

### Decision and cost

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Staging plus durable command receipts | Clear progress and safe recovery from ambiguous responses | More lifecycle state and cleanup coordination |
| ❌ Update metadata while streaming bytes | Fewer apparent steps | Failed transfer can expose incomplete content |

I would accept the additional state because the upload is the product's core promise.
For small files, the transport can remain one request while preserving the same
publication boundary; resumability is most valuable for large unreliable transfers.

The UI reports preparation, acknowledged transfer, saving, and cloud commitment
separately. It does not equate 100% network progress with a durable revision.

## 🔧 Deep dive 2: Two devices, conflicting edits, and reconnect — 8 minutes

> “I would treat the client's optimistic state as an intent layered over confirmed
> revisions. That lets us explain conflicts without pretending a local preview was
> already the globally accepted truth.”

### Concurrent edits are a product event

A laptop and phone start from the same revision and edit while disconnected. Neither
edit observed the other. Comparing wall-clock timestamps cannot establish which is a
successor, and silently keeping the later timestamp would discard independent work.

The server compares causal context inside a locked or conditional admission boundary.
A valid successor can advance the head. Independent histories retain two immutable
manifests and produce a conflict outcome.

A vector join describes observed history; it does not combine document bytes. For
binary files, the UI shows both versions with device and revision context. For a
supported text format, a separate three-way merge can propose a new revision.

“Keep both” must preserve both byte histories. “Use this version” must name the siblings
the user reviewed. If another device adds a sibling while the dialog is open, the
server returns the changed conflict instead of erasing unseen work.

The client retains its pending content until it knows that the server preserved it
or the user explicitly discards it. A failed resolution request does not justify
removing the only local copy.

### Push and replay play different roles

A persistent channel sends small hints while the app is active. The client coordinator
coalesces bursts and pulls changes after its saved cursor. SSE with REST or WebSocket
can both implement this; the replay contract matters more than the transport choice.

The server feed records committed changes. A timestamp query over mutable files can
miss tied timestamps, collapsed updates, or a transaction that commits after a newer
watermark has already been returned.

For an initial design, I would serialize feed position allocation per account through
commit. A plain sequence number assigned before commit is insufficient if a later
number can become visible first.

The browser applies each change page and saves its next cursor in one local transaction.
A crash causes safe replay or resumes after the applied page. Revision IDs deduplicate
repeated delivery and protect against stale events arriving after a command response.

### Reset and account boundaries

A new device receives a consistent snapshot and matching feed boundary. If its cursor
expires, it refreshes confirmed state and then re-evaluates pending local commands.
It does not delete pending intents just because the server requires a reset.

Deletion is a versioned tombstone. The server retains deletion history until active
consumers acknowledge it, subject to an explicit offline lease. A device that exceeds
the lease reboots its baseline before submitting old mutations.

Actor retirement needs an epoch. Removing an old vector component while accepting old
device commands can make stale work look new. The UI should offer recovery of unsent
bytes as a deliberate new upload after rebootstrap.

Account switches create another boundary. The frontend stops workers and subscriptions,
invalidates request generations, and clears private view state. An old account's late
response cannot populate the next account's cache.

### Decision and cost

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Causal conflicts and durable replay | Preserves independent work and recovers missed delivery | Retained history, reset behavior, and conflict UX |
| ❌ Last-write-wins with socket updates | Simple apparent flow | Offline edits can disappear and missed events remain missing |

For a personal drive, conflict visibility is preferable to silent loss. The cost is
that some actions need user attention instead of always ending in a green checkmark.
I would explain that choice early rather than hide it as an exceptional backend detail.

For an online-only product with one editor, revision-conditioned writes may be enough.
The independent offline-device requirement is what makes richer causal history useful.

### A concrete failure walkthrough

1. The laptop edits revision R and persists command A locally.
2. The phone commits a different edit from R as revision P.
3. The laptop reconnects and uploads its bytes, but loses the admission response.
4. Receipt lookup reveals that A became a retained sibling, not the sole head.
5. The UI opens the conflict with both manifests available.
6. A resolution creates a new accepted outcome and reaches other devices through replay.

Every step has one owner and a discoverable outcome. That is more useful than saying
that the system is “eventually consistent” without explaining what eventually converges.

## 🔧 Deep dive 3: Photos connect background processing to rendering — 8 minutes

> “The photo library needs a cheap representation for browsing and a durable original
> for preservation. I would make derivative readiness a first-class state shared by
> the worker pipeline and the UI.”

### Publish originals independently of derivatives

The original follows the same verified publication flow as other content. A committed
outbox job names the original revision and transformation version. A worker decodes it
within resource limits and creates a thumbnail and preview.

The worker writes immutable outputs before publishing readiness. Duplicate jobs target
the same logical derivative version; a crash can be retried without creating a new
user-visible photo every time.

A decode failure produces an explicit processing state. The original can remain saved
while the preview is unavailable. This avoids forcing the upload request to wait for
a CPU-heavy image operation or treating a worker timeout as lost original content.

Captured metadata, user edits such as favorites, and album membership are separate
from the original bytes. A favorite command should set the desired value rather than
toggle it, so an identical retry does not undo the user's choice.

### Deliver private media correctly

The server checks access to the photo and the requested revision. If a CDN or media
edge caches derivatives, it must enforce that access on hits too. A successful origin
authorization does not make a publicly reusable response private forever.

I would choose account-safe cache keys and short-lived authorization, or private
responses where shared caching is not needed. Logout, sharing changes, and deletion
have explicit cache and revocation semantics.

The browser uses thumbnails in the grid, previews in the viewer, and originals only
for an explicit download or offline request. A server record saying “download started”
does not prove the browser retained the original.

### Bound the grid and the image working set

Rows are a useful virtualization unit for a regular photo grid. The number of columns
follows container width. Resizing preserves an anchor photo and recomputes row geometry,
rather than keeping a row index whose meaning changed.

Pagination is bound to the active filter and ordering. Old responses are discarded
when the query generation changes. If the first page is shorter than the viewport,
the client can fetch again without waiting for an impossible scroll event.

An ID-keyed entity cache deduplicates records while page membership preserves order.
A newly uploaded nonfavorite does not belong in Favorites just because the upload
completed while that view was open.

Virtualization bounds rendered elements, not decoded image memory. I would limit
prefetching to a small neighborhood, cancel obsolete requests, and release retained
buffers when the viewer or account changes.

The viewer is keyed by photo ID. Remote inserts before that photo must not switch the
viewer to a different image. A delete deliberately chooses a surviving neighbor or
closes the viewer and restores focus.

### Accessibility and failure states

Photos need accessible names, keyboard selection and opening, and announced selection
state. Double-click cannot be the only way to open an item. A virtualized focused item
needs an intentional focus policy as rows mount and unmount.

The viewer supports Escape, manages focus, and restores it to the originating item.
Loading, filtered-empty, offline, and failed states are distinguishable. A retry or
load-more control should remain available when automatic pagination fails.

### Decision and cost

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Asynchronous derivatives and bounded rendering | Fast browsing without loading all originals | Processing states, worker retries, and focus coordination |
| ❌ Synchronous original-only gallery | Fewer moving parts | Upload latency and bandwidth grow with image size |

For small demo libraries, synchronous image generation is an understandable shortcut.
For the assumed large library and mobile clients, separating original durability from
browsing representations is worth the extra state.

I would validate scroll smoothness, decoded memory, keyboard behavior, and time to a
useful thumbnail together. A single desktop frame-rate measurement would not establish
that the full photo experience works.

## 📈 Scaling and verification — 4 minutes

The first implementation risks are full-file buffering, synchronous image decoding,
uncancelled page requests, and a reload for every notification. I would address those
before adding global deployment complexity.

Backend transfers use streaming and backpressure. Derivative workers have concurrency
and memory budgets. Metadata partitions follow account ownership, and gateways share
event delivery while clients recover through the durable feed.

Blob cleanup participates in the same lifecycle protocol as publication. It must account
for active uploads, current revisions, historical versions, and conflict siblings.
A zero count observed earlier is not proof that an object is still safe to delete.

A busy account may outgrow serialized feed admission. At that point, splitting the
ordering domain requires an explicit namespace and cursor design, not just more API
instances. Stale-tolerant list reads can scale separately from admission.

I would test the boundaries with deliberate failures:

- Crash the tab after journaling and before upload; recover the same intent.
- Lose a successful commit response; discover one durable receipt and revision.
- Race two updates from the same base; preserve both accepted contents.
- Run cleanup while publication attaches a staged object; retain readable bytes.
- Reconnect after cursor expiry; reset confirmed state without discarding pending work.
- Change account or filter during a request; ignore the obsolete response.
- Fail derivative processing; keep the original saved and show a recoverable photo state.

Observability follows the same journey: local queue age, transfer progress, admission
latency, feed lag, derivative readiness, and successful materialization. Correlation
IDs connect those stages without logging private filenames or content.

## ⚖️ Trade-offs and implementation boundary — 1 minute

| Decision | Chosen | Cost accepted |
|----------|--------|---------------|
| Save semantics | Staging, atomic admission, durable receipt | More explicit states across client and server |
| Concurrent changes | Retained revisions with causal resolution | Conflict UI and historical storage |
| Recovery | Durable feed and local journal | Retention and reset lifecycle |
| Photo browsing | Derivatives and bounded working set | Worker and rendering coordination |

The repository currently offers an online React/Zustand application, whole-file uploads,
server-side chunking, synchronous photo derivatives, and in-process WebSocket events.
It has a virtualized photo grid but no durable offline journal or resumable upload API.

Its metadata updates, chunk references, and receipts do not share the proposed admission
transaction. History lacks immutable manifests, changes use timestamps, and reconnect
has no reliable replay. The production guarantees above remain design work.

> “I would build the smallest complete journey with truthful acknowledgements first.
> Once a file has a recoverable path from local intent to cloud revision to another
> device, performance optimizations can improve that journey without changing its meaning.”

[Implementation details](./architecture.md) · [Run the demo](./README.md)
