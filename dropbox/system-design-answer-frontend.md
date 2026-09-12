# Dropbox — frontend system design interview

This is a proposed production design for a cloud file browser, paced for 45 minutes. It is not a
description of Dropbox Inc.'s implementation. The final section explains how it differs from this
repository's demo.

## 🎯 Scope and user expectations — 4 minutes

> “I would start with the moment the user drops a large file into a folder. They need to know where it will land, whether it is safely saved, and what to do if their connection disappears. A moving progress bar answers only one of those questions.”

I would confirm that we are building a browser application. A desktop client that watches arbitrary
filesystem changes adds a different synchronization problem. For this interview, I would support
navigation, upload and download, rename and move, version recovery, and sharing.

I would include interrupted uploads and concurrent edits because they shape the client architecture.
I would leave collaborative text editing, automatic binary merges, and an offline copy of the entire
drive outside the initial scope.

The product promises are concrete:

- A committed file can be downloaded as one consistent version.
- An interrupted upload can resume from verified progress when its bytes remain available.
- A stale edit cannot silently replace someone else's newer version.
- A revoked user cannot obtain a new authorized view or download grant.
- A disconnected screen visibly distinguishes cached information from current server state.

For sizing, assume one million daily active users and an average uploaded version of 20 MiB. A
supported maximum of 10 GiB changes our memory strategy even if most files are small. Large folders
may contain thousands of entries, so fetching and mounting every item is not acceptable.

I would target a p95 server response below 300 ms for a bounded metadata page and changes visible on
another connected device within two seconds. Those are design targets, not measurements. Upload
duration depends on bandwidth; I would measure responsiveness separately from byte-transfer time.

The interface should remain usable while hashing or transferring a large file. Keyboard users need
the same file operations as pointer users. I would spend the rest of the interview on how those
promises affect ownership of state.

## 🏗️ Client architecture and contracts — 5 minutes

I would draw two paths: metadata through the API and bytes through an upload manager. The file
browser should not own transfer lifetimes, because navigating to another folder must not cancel
unrelated work.

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Folder route     │────▶│ Metadata cache   │────▶│ Metadata API     │
└──────────────────┘     └──────────────────┘     └──────────────────┘
        │                         ▲                         │
        ▼                         │                         ▼
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Upload manager   │     │ Change listener  │◀────│ Revision feed    │
│ Worker + queue   │     └──────────────────┘     └──────────────────┘
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ Private objects  │
│ Scoped transfers │
└──────────────────┘
```

React renders the browser and dialogs. TanStack Router owns the namespace and folder location. A
server-state cache owns folder pages and file versions; Zustand is suitable for the transfer queue,
selection, and other shared client state. The precise library matters less than avoiding several
competing copies of the same file list.

| State | Owner | Lifetime |
|-------|-------|----------|
| Namespace, folder, sort | URL | Back/forward navigation and reload |
| Folder pages and permissions | Cache keyed by account, namespace, folder, query | Revalidate against server revisions |
| Selection and focused row | File-browser interaction state | Current collection, with explicit navigation reset |
| Upload session and verified slots | Upload manager plus server ledger | Longer than a route component |
| Rename text and dialog errors | Dialog | One target and one operation |
| Session identity | Auth boundary | Clear dependent state on logout/account change |

The backend must return stable file IDs, entry type, size, current version, and effective
capabilities. File identity cannot depend on the path: renaming a folder should not require
replacing the identity of every descendant.

I would agree on a small proposed contract before implementing UI details:

| Operation | Information the client needs |
|-----------|------------------------------|
| List folder | Bounded page, stable continuation, namespace revision, effective actions |
| Start/resume upload | Session ID, expected manifest, verified slot receipts, expiry |
| Commit upload | Operation ID, base version, committed result or explicit conflict |
| Read changes | Cursor, ordered changes, or instruction to reload a snapshot |
| Admit download | Authorized immutable version and bounded transfer capability |

These are proposed contracts. The local demo's endpoints are documented separately in
[architecture.md](./architecture.md#api-design).

## 🔧 Deep Dive 1: progress that survives failure — 10 minutes

> “I would choose a bounded, resumable chunk queue. The key benefit is that the unit of recovery is a small verified transfer, while the unit of visibility is still the complete file.”

A whole-file multipart request is attractive for a small demo. But a failure near the end of a 10
GiB upload can require sending all the bytes again. It also tempts us to tie success to a single
request and to keep excessive data in application memory.

Start with fixed 4 MiB chunks. A worker hashes a bounded number of slices so the main thread remains
available for navigation and input. Fixed boundaries are easy to explain and resume; inserting bytes
near the beginning can shift later chunks and reduce reuse. I would measure that cost before adding
content-defined chunking.

The browser creates a stable upload task before sending requests. Its destination is a namespace and
folder ID captured at drop time. A later route change changes the visible browser, not that task's
destination.

The transfer sequence is:

1. Read the file's size and prepare its ordered digest/length manifest in a worker.
2. Ask the server to create a session and reserve quota for the prospective version.
3. Receive verified reusable slots or scoped upload instructions for missing slots.
4. Upload a small bounded number of chunks concurrently, initially perhaps three.
5. Record server receipts for verified slots; retry failed slots using the same identity.
6. Finalize with the original operation ID and base version.
7. Show completion only after retrieving the committed file/version result.

Three simultaneous chunks is a starting configuration, not a universal optimum. At 4 MiB each, raw
in-flight slices are roughly 12 MiB, plus hashing buffers, transport copies, and metadata. I would
tune against browser memory and network behavior rather than allow every dropped file to launch
unlimited requests.

For 10 GiB, there are 2,560 fixed-size chunks. Persisting their digests and receipts is reasonable;
keeping the entire file in a second in-memory buffer is not. A scheduler can rotate across files to
keep small uploads from waiting behind a single large one.

Progress has distinct phases:

| Phase | User message | What has actually happened |
|-------|--------------|----------------------------|
| Preparing | Preparing file | Local slices are being inspected and hashed |
| Transferring | Bytes sent / verified | Network progress is provisional; receipts confirm accepted slots |
| Finalizing | Saving file | Bytes are staged, metadata outcome may still be pending |
| Complete | Saved as version N | Server returned a durable committed result |
| Uncertain | Checking whether it saved | A response was lost; client is querying the original operation |
| Conflict | A newer version exists | Staged bytes remain available for an explicit decision |

I would avoid jumping from “100% sent” to “Done.” The server may still be verifying the final slot
or publishing metadata. A distinct Saving phase makes that wait honest without making the progress
bar appear broken.

If finalization times out, the client must not create a new upload intent automatically. It asks for
the outcome of the same operation. If committed, it displays that result; if pending, it waits; if
absent and retryable, it resends the same request identity. Backend idempotency is part of the
frontend experience.

Pause stops scheduling new chunks and may abort outstanding requests. An aborted request might
already have succeeded at the server, so resume fetches receipts rather than trusting only local
flags. Cancel asks the server to release the session and its reservation; if publication already won
the race, the UI reports the saved file and offers a separate delete action.

For reload recovery, persist the task metadata and receipts in IndexedDB. Browser file access does
not necessarily survive reload, and a background process is not guaranteed to run indefinitely. If
the original bytes are unavailable, ask the user to reselect the file and verify its manifest before
continuing.

I would also make expiry explicit. An expired reservation may require creating a new session,
rechecking permissions, and reusing only chunks the server authorizes. A local receipt is evidence
to reconcile, not permission to publish forever.

Deduplication must not expose a global content-presence oracle. The server can authorize reuse
inside a namespace; sending a hash does not prove that the user owns its bytes. This gives up some
potential cross-user savings but keeps the client contract safe to implement.

| Approach | Why it fits | Cost or failure mode |
|----------|-------------|----------------------|
| ✅ Bounded chunks with server receipts | Limits retransmission and memory; resumes verified work | Worker scheduling, persistence, expiry, and finalization states |
| ❌ Whole-file request for every file | Minimal client implementation | Late failures restart large transfers; request success becomes ambiguous |
| ❌ Persist only a percentage | Easy display state | Cannot identify which bytes the server actually accepted |

## 🔧 Deep Dive 2: navigation and edits under concurrency — 8 minutes

> “I would key remote state by the collection it describes, and attach mutations to stable file IDs and base versions. That prevents a late response from changing the meaning of the screen.”

Consider opening folder A, then B. If A's slower response arrives last and writes into one global
`files` array, the URL says B while the page displays A. That is more than flicker: the user can
initiate an operation on an unexpected file.

A keyed cache can retain A's result under A's key without replacing B. Abort obsolete requests to
save work, and use a request generation or identity check before committing results. Cancellation
alone is insufficient because a request can finish just before it is cancelled.

The same identity rule applies to dialogs. If a version-history dialog switches from one file to
another, an old response must not populate the new file's history. Keep target ID, request
generation, and operation result together. Clear sensitive cached state at an account boundary.

Uploads outlive the folder view. When a task finishes in A while the user is in B, invalidate A's
cache and show a toast with a link to the saved file. Do not call a global “load folder A” action
that replaces the user's current screen.

For mutations, I would distinguish reversible presentation from authoritative success. A pending
rename can appear immediately on the affected row, with the operation identity attached. The server
still decides uniqueness, permission, and version preconditions. On failure, remove only that
operation's overlay.

Blindly restoring a captured entire folder array is unsafe. Another request or device may have made
legitimate changes while the rename was in flight. Rollback should reveal the latest server state
for that entity rather than replace unrelated updates.

Now suppose two devices open file version 7. Device A saves version 8. Device B uploads its edited
bytes with base version 7. The server returns a conflict instead of quietly overwriting version 8.

The UI should preserve B's staged work and offer understandable choices:

- Keep both by creating a separately named file.
- Download or inspect the current and proposed versions where a preview is supported.
- Replace the current version deliberately, after refreshing and submitting a new guarded intent.

“Replace anyway” should not become an unconditional write that can silently defeat a third edit. It
is a new operation against the revision the user just reviewed. If that revision changes again,
another conflict is appropriate.

Restore follows the same rule. The user selects a retained version, but restoration publishes a new
current version. It should not erase the intervening history or hide concurrent changes that arrived
while the dialog was open.

I would show the storage impact before confirming restore when quota counts retained logical
versions. An old version already sharing physical chunks does not mean a new logical version is free
under that product policy.

Move has a separate structural concern. The picker can exclude the current folder and known
descendants to help the user, but the server must validate the destination and prevent cycles under
concurrent moves. A visually disabled option is not an integrity constraint.

| Approach | Benefit | Trade-off |
|----------|---------|-----------|
| ✅ Keyed state and guarded entity mutations | Late responses stay associated with their real targets | More explicit identities and pending-operation state |
| ❌ One global folder result with last response wins | Simple initial store | Navigation races and unrelated rollback overwrite |
| ✅ Explicit version conflicts | Preserves user intent and staged work | Conflict decisions interrupt an otherwise automatic save |
| ❌ Silent overwrite plus hidden history | Fewer immediate prompts | User may never notice that an edit was superseded |

## 🔧 Deep Dive 3: live sync and permission changes — 8 minutes

> “I would treat a socket message as a reason to reconcile durable state. A green connection indicator is not proof that this browser has seen every file change.”

WebSockets offer low-latency hints while the tab is active. Polling every second across 100,000
connected clients would create roughly 100,000 requests per second even when nothing changes. Long
polling or adaptive polling remains useful as a fallback, but rapid fixed polling is an expensive
default for idle folders.

The socket does not solve recovery. A browser can sleep, change networks, or lose a message while
the server commits successfully. It needs a durable namespace cursor and an endpoint that returns
subsequent changes.

On initial load, fetch a snapshot tied to a revision, then request changes after that revision.
Pages must belong to a consistent snapshot or restart when invalidated. Socket notices can arrive
during this work; retain the highest observed revision and reconcile up to it.

On reconnect, resume from the last applied cursor. Apply changes in order or invalidate affected
collections and refetch with a revision fence. Duplicate notices are harmless. If the server no
longer retains the cursor, show a brief refreshing state and obtain a new snapshot.

The ordering scope matters. I would use a namespace sequence rather than pretend there is one cheap
global order across every account. A user's personal files and a shared workspace may have separate
cursors and permission boundaries.

A socket queue should be bounded. For a slow client, coalesce several changes to “namespace revision
advanced.” If it falls too far behind, request resynchronization. The client should not mount
thousands of toasts or perform one full folder fetch per event burst.

Permission changes are part of this protocol. If a folder is revoked, remove it from navigation,
stop its subscriptions, and clear cached metadata according to the account's cache policy. Every
refresh and download admission still checks authorization; receiving a past event is not a permanent
grant.

I would keep UI capabilities descriptive: Can rename, Can upload, Can share. The server validates
them at mutation time because an open dialog may contain stale permissions. A denied operation
should explain the change and preserve any local unsaved bytes where possible.

Public links need a separate public route, with clear password and expiry handling. A successful
clipboard operation should be awaited before announcing Copied. The link should open a usable page
with a file identity and download action, rather than expose an internal API response.

For protected links, submit the password without putting it into a query string that can enter logs
or history. The byte capability should be short-lived and tied to a permitted version. The UI can
explain that revoking a link prevents new access but cannot recall bytes already downloaded.

“View only” needs careful product wording. If a browser receives a PDF or image, users may still
copy its contents. Hiding a download button does not provide a different storage authorization
boundary.

| Approach | Why choose it | Cost |
|----------|---------------|------|
| ✅ Socket hints plus durable cursor recovery | Fast active updates and correctness after gaps | Reconnect, cursor expiry, and snapshot coordination |
| ❌ Socket messages as the only state history | Simple happy path | Sleeping or disconnected clients permanently miss changes |
| ✅ Server capabilities rechecked per action | UI remains helpful while authority stays current | Operations can be denied after a dialog opens |
| ❌ Cached permission as final authority | Fewer server checks | Revocation and membership changes become ineffective |

## ⚡ Rendering, downloads, and accessibility — 5 minutes

Large folders require both server pagination and list virtualization. Pagination limits transferred
metadata; virtualization limits mounted rows. Either one without the other leaves a different
bottleneck intact. Use a stable cursor that includes the sort key and file ID, with a revision
policy for changes during traversal.

For a list, I would start with predictable row heights and a small overscan window. A responsive
grid needs row grouping when the column count changes. Stable file IDs preserve selection and focus
across refreshes; indices do not.

A keyboard model should be explicit: arrow keys move focus, selection is announced, Enter opens
folders, and file actions are reachable without hover. Virtualization must keep the focused item
mounted or deliberately move focus before recycling it.

Dialogs need a label, focus containment, Escape behavior, and focus restoration to the initiating
control. Destructive operations should name the affected target. Status announcements should report
meaningful phase changes rather than speak every progress percentage.

For downloads, prefer an authorized browser download or streaming delivery path over fetching an
entire large file into a JavaScript Blob. Pin a version so a resumed range does not combine bytes
from two different edits. Folder ZIP downloads would require a separate bounded archive workflow and
are outside this first design.

Thumbnails can be deferred and cached by immutable version identity. They should not expose revoked
resources indefinitely. I would reserve image dimensions to avoid layout shifts and avoid loading
all previews simply because the folder page contains their metadata.

## 🧪 Failure walkthrough and local comparison — 5 minutes

I would validate the user promises with a few adversarial scenarios rather than only checking that a
page renders:

| Scenario | Expected result |
|----------|-----------------|
| Drop a large file, then navigate | Transfer continues to its captured destination; current folder stays put |
| Lose the finalization response | Same operation resolves to one version and one quota charge |
| Reload halfway through transfer | Receipts reconcile; reselect and verify bytes if needed |
| Two devices replace one version | Second edit remains recoverable and receives a conflict |
| Revoke a folder while its dialog is open | New operation is denied; stale view is removed |
| Resume after cursor retention expires | Snapshot reload closes the gap and establishes a new cursor |
| Keyboard-scroll a large folder | Focus and selection remain understandable across recycled rows |

I would measure long tasks during hashing, memory with several uploads, metadata page latency, time
spent in Saving, unresolved outcomes, and cursor lag. Those signals distinguish a responsive
animation from reliable file storage.

This repository provides React routes, Zustand state, drag/drop, grid/list views, metadata
operations, sharing controls, and version-history UI. Its browser sends one whole-file multipart
request, with an 8 MiB default server limit. It has no worker hashing, persisted resume queue,
virtualization, or browser WebSocket connection.

The current store can accept late folder responses and refresh an upload's old destination after
navigation. Settings actions are placeholders. Shared-with-me is blocked by route shadowing, and
backend owner checks do not honor folder grants. Public links open API JSON.

The most important local failure is completion uncertainty: PostgreSQL commits the file, then a
metric rejects the string-valued size. The UI can report failure for a saved file. Retrying can
create another version and charge again. Seeded files contain metadata without bytes and download as
empty buffers.

These limitations make the demo useful for tracing the boundaries we discussed, but they are not the
guarantees of the proposed client. The next implementation milestone would be one small file that
survives a lost response and a reload, with its bytes, version, quota, and visible outcome all
agreeing. The source mapping is in [Implementation Notes](./architecture.md#implementation-notes).
