# Google Docs: full-stack system design interview

A proposed 45-minute design connecting a rich-text browser editor to an authoritative
collaboration service. The final section distinguishes this design from the repository's
incomplete teaching implementation.

## 🎯 Agree on the user journeys — 4 minutes

> “I would focus on three journeys: two people edit without losing each other's work, a comment stays connected to the text it discusses, and a user can recover a saved version without silently replacing newer work. That gives us a useful way to connect frontend state to backend guarantees.”

The first release includes paragraphs, headings, lists, common formatting marks,
small collaborative groups, comments, owner-managed sharing, and named history.
I would set document-size and editor-count limits. Export, arbitrary embedded apps,
full tracked-change suggestions, and unlimited offline merging are separate extensions.

Local typing should be immediate. A saved indication means the service committed
an identified revision, not that a socket opened or a debounce timer expired. Presence
is best effort; accepted content is durable within a stated replica-failure boundary.

The service has one ordered committed history per document. Clients can temporarily
lead that history with local unconfirmed work. Their job is to reconcile with it while
preserving selection, composition, and authored intent.

| Journey | Browser responsibility | Server responsibility |
|---------|------------------------|-----------------------|
| Edit together | Immediate input and mapped pending steps | Ordered admission and recoverable results |
| Disconnect/reconnect | Preserve unresolved work and attempt identity | Receipt lookup and contiguous replay |
| Comment on text | Keep draft and selected revision/range | Map or reject the anchor under current access |
| Preview/restore | Isolate history preview and guard pending edits | New identified restore event at an expected head |
| Change permissions | Show current capability and stop invalid actions | Enforce current access on reads and commands |

I would propose p95 input-to-paint below 50 ms on a specified modest device and peer
visibility below 200 ms in a document's home region. Availability and latency targets
need measurement; I would not promise arbitrary document sizes on every device.

## 🏗️ Draw the complete path — 5 minutes

I would put the editor's local model above the network boundary and show the document
owner, durable store, delivery, and presence beneath it. This makes the save boundary
visible before discussing framework choices.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER / LOCAL INPUT, CONFIRMED HISTORY AND REVIEW CONTEXT                              │
│                                                                                          │
│  ┌────────────────────────┐    ┌────────────────────────┐    ┌────────────────────────┐  │
│  │ Editor + review UI     │    │ Models + local journal │    │ Sync / API coordinator │  │
│  │ Typing / focus / draft │◀──▶│ Pending editor steps   │◀──▶│ Saved attempt + digest │  │
│  │ Pinned history preview │    │ Anchors / presence     │    │ Account/doc generation │  │
│  └────────────────────────┘    └────────────────────────┘    └────────────────────────┘  │
│                                                                           ▲              │
│                                                                           │              │
└───────────────────────────────────────────────────────────────────────────┼──────────────┘
                                              ┌─────────────────────────────┘
                                              ▼
                                 ┌────────────────────────┐       ┌────────────────────────┐
                                 │ Authenticated gateway  │       │ Presence routing       │
                                 │ HTTP / WS owner route  │◀─────▶│ Connection-scoped      │
                                 │ Replay/current access  │       │ Version / expiry       │
                                 └────────────────────────┘       └────────────────────────┘
                                              ▲
                                              │ commands / outcomes
                                              │
                                              ▼
                                 ┌────────────────────────┐       ┌────────────────────────┐
                                 │ Fenced document owner  │       │ Document partition/SQL │
                                 │ Edit/review/restore    │◀─────▶│ Head/epoch/grants      │
                                 │ Committed working copy │       │ Steps/receipts/outbox  │
                                 └────────────────────────┘       │                        │
                                              ▲                   │                        │
                                              │ replay / publish  │                        │
                                              │                   │                        │
                                              ▼                   │                        │
┌────────────────────────┐       ┌────────────────────────┐       │ Committed range reads  │
│ Verified snapshots     │       │ Replay/snapshot work   │       │ Claimable outbox work  │
│ Revision/content hash  │◀─────▶│ Committed ranges       │◀─────▶│ Commit + work progress │
│ History / recovery     │       │ Verify before publish  │       │                        │
└────────────────────────┘       └────────────────────────┘       └────────────────────────┘

Local input is immediate; Saved follows durable admission. Preview never replaces the live editor.
```

Typing updates the editor model and produces unconfirmed steps. The client coordinator
submits an immutable attempt; the document owner validates and commits an accepted
range with its receipt. The accepted stream returns to clients for reconciliation.
Snapshot and delivery workers consume committed history; presence remains disposable.

I would explain reload recovery through those same owners:

1. A bounded account/document/schema journal retains pending steps and the submitted attempt under a defined storage policy.
2. After reauthorization, resolve that immutable attempt and recover a coherent committed prefix before rebasing anything uncertain.
3. Acceptance removes the corresponding pending work; only a definitive no-effect result permits a newly identified rebased submission.
4. Snapshot publication and progress follow verified bytes and a complete prefix. History preview and fresh presence stay separate from the recovered live editor.

REST serves document lists, review panels, and history reads. WebSocket carries batches
and presence. Content-changing REST commands, including restore, reach the same document
owner as edits. Otherwise the two transports can create contradictory histories.

I would use a schema-aware editor such as ProseMirror and a centralized step-rebase
protocol. The authority accepts batches based on its current revision. Stale clients
catch up and rebase unconfirmed steps using the editor's mapping model.

That is one coherent choice. A Yjs/CRDT design could be appropriate for longer offline
work, but its provider, identifiers, undo, and persistence form a different protocol.
I would not mix its extensions with a custom position-based server and call the result OT.

Initially, one process can contain the gateway, metadata API, and document owner.
At scale, those responsibilities separate while each document retains a fenced
admission authority and a colocated durable consistency boundary.

## 💾 State and contracts across the boundary — 4 minutes

| State | Owner | Identity that must survive a request |
|-------|-------|-------------------------------------|
| Displayed rich text and selection | Editor model | Account/document/schema and local transaction context |
| Confirmed and pending steps | Collaboration adapter | Confirmed revision, client ID, immutable submitted attempt |
| Comment draft | Review UI | Document, selected revision/range, draft/attempt ID |
| Metadata and history pages | Server-state cache | Account/document/query generation and pinned revision |
| Committed head and receipts | Document authority/store | Document epoch, step version, attempt digest/outcome |
| Presence | Connection-scoped awareness | Document revision, connection ID, expiry |

The editor owns content and undo; React owns shell controls and small derived views.
Zustand can coordinate panel visibility and pending status. A query cache manages
metadata and pages. The important decision is ownership, not whether every field lives
in the same store library.

A bootstrap response contains a verified snapshot and a contiguous suffix to a known
head. A batch request contains base version, schema, immutable attempt ID, and ordered
steps. Acceptance identifies the exact committed range; rejection explicitly says the
attempt had no effect.

Versioned numbers need a deliberate SQL/JSON representation. TypeScript interfaces
cannot prevent a driver from returning BIGINT as a string, or validate malicious
network messages. The runtime boundary checks shape, range, schema, and current access.

| Method/channel | Proposed operation | Useful response |
|----------------|--------------------|-----------------|
| GET | Document list / bootstrap | Authorized page or coherent starting revision |
| WS | Submit editor batch | Durable accepted range or terminal rejection |
| WS or GET | Replay after version | Contiguous steps and originating batch identities |
| GET | Resolve attempt | Known result or unresolved status |
| POST/PATCH | Comment or grant command | Canonical authorized state and version |
| GET/POST | History preview / restore | Pinned revision or new guarded reset result |

The transport preserves structured errors and operation identities. Flattening a
conflict or unknown write outcome into a generic string forces the UI to guess how
to recover and can turn a retry into duplicate content.

## 📊 Size the work that crosses those arrows — 3 minutes

Assume five million daily active editors spending twenty minutes each. Six billion
editor-seconds/day implies about 69,445 concurrent editors on average, with a fivefold
peak of roughly 350,000.

At 0.5 submitted batches per active editor per second, that is about 34,722 average
batches/second and 175,000 at peak. At 500 bytes per batch, the daily log is about
1.5 TB before replicas, indexes, receipts, and snapshots.

For five other viewers in a room, each accepted batch creates roughly five content
deliveries. Presence and reconnect traffic add work independently. Slow sockets can
consume more memory than healthy ones because their queues accumulate.

These are planning assumptions, not Google statistics. The frontend still opens one
bounded document and a page of comments. The backend partitions documents, while one
hot document's serialized processing and fan-out require their own budgets.

## 🔧 Deep dive 1: from typing to a known saved outcome — 9 minutes

### Keep immediate input independent of acceptance

The editor applies a local transaction immediately. The collaboration adapter retains
the confirmed revision and unconfirmed steps, so the displayed document can include
work that is still pending. React observes a compact save state rather than replacing
the entire document JSON after every response.

I would keep one unresolved wire batch per client/document and buffer later local
transactions behind it. This does not stop typing; it makes the in-flight uncertainty
manageable. Batching preserves ordered steps and has byte/step and time limits.

Freeze the submitted attempt's ID, base, schema, and payload. If the user types more
while it is in flight, those steps remain separate. A network retry sends the same
attempt; it cannot silently include newer text under the old ID.

### The server has an explicit commit point

The document owner validates current edit capability, document state, schema, and
resource bounds. It applies all proposed steps to a candidate document, rejecting the
whole batch if the result is invalid.

In a serialized database transaction, it checks its fencing epoch and the document
head, resolves the attempt receipt, and either records a terminal no-effect rejection
or appends the accepted steps with a receipt and outbox event. The head advances by
the number of accepted steps.

An identical accepted attempt returns its original range. A changed payload under the
same ID is a conflict. This guarantee comes from storage constraints and serialization,
not a cache lookup followed by unprotected processing.

Only after commit does the owner expose the candidate as accepted state and acknowledge
save durability. The browser can keep typing while that round trip takes place; local
responsiveness does not require an in-memory acknowledgment to masquerade as a save.

### Concurrent changes rebase through the editor model

Alice and Bob start from revision 20. Alice's two-step batch commits at 21–22. Bob's
attempt with base 20 receives an explicit no-effect rejection and the missing range.
He integrates Alice's steps, maps his pending work, and submits a new attempt.

The old attempt remains terminally rejected so a delayed retry cannot become a second
accepted version of Bob's intent. A rebase changes the wire payload and therefore
requires a fresh identity after the earlier outcome is known.

A rich-text operation can change structure: splitting a paragraph or deleting a list
item may invalidate another range. I would use a tested editor mapping model and
preserve work requiring manual recovery rather than pretending raw string offsets
are enough for every formatting and selection case.

Accepted batches carry origin identity. Alice confirms her own matching local steps
when they return in the canonical stream; she does not insert them again. Remote
accepted steps are applied through the collaboration transaction path, which maps
selection and compatible undo state along with pending edits.

### Reconnect resolves uncertainty before creating new intent

Suppose Alice's response is lost after commit. She still has an unresolved attempt,
not a failed edit. The client asks for its outcome or retries the original frozen
request through the authority. A missing receipt alone does not prove an in-flight
request cannot still commit.

If accepted, recover its range and retire the matching pending work. If definitely
rejected, rebase and issue a new attempt. If unresolved, keep the pending state and
continue outcome resolution. Never rebase an uncertain accepted insert and submit it
under a new identity just because the socket changed.

A short-lived local recovery copy can preserve the base and pending work across reload.
It is account/document scoped, has a retention policy, and is not advertised as server
durability. Unsupported schema or expired rebase history leads to explicit recovery,
such as saving a separate copy, rather than silently clearing the queue.

| Choice | Why it works here | What it costs |
|--------|-------------------|---------------|
| ✅ Immediate editor state + durable identified admission | Input is responsive while saved has a precise meaning | Reconciliation, receipts, and pending states |
| ❌ Wait for network before showing input | Easy single-state client | Latency directly delays typing |
| ❌ ACK in memory and persist only after inactivity | Fast apparent saves | A crash or discarded intermediate operation loses acknowledged work |

> “I separate when the user sees an edit from when the service accepts it. That lets the interface stay responsive without weakening the meaning of Saved.”

## 🔧 Deep dive 2: review actions keep the context the person saw — 8 minutes

### Map comments instead of treating offsets as permanent

The user selects a phrase and writes a comment. The draft remembers its document,
revision, range, and boundary affinity. It remains available even while remote edits
change the displayed document.

An insertion before the phrase should move the anchor, while a deletion of the phrase
may detach it. The server and client apply the agreed mapping rules to accepted changes.
A detached discussion retains its identity and authorized quoted context; it does not
quietly attach to whatever sentence now occupies the old position.

If the range includes unconfirmed local text, first establish a committed base or use
a deliberately combined content/comment command. The server cannot interpret offsets
from the speculative local document as if they referenced its earlier shared revision.

Submission has its own immutable attempt identity. On error, preserve the comment body
and selection context. Clearing the input after a promise resolves is insufficient:
the API wrapper may have returned a rejected result without throwing an exception.

Replies belong to a parent in the same document. Resolve/reopen carries a desired state
and expected version; a late response cannot overwrite a newer decision. Query pages
contain canonical entities, while the UI overlays only its current pending intent.

### Preview should not replace the live editor

History loads a pinned snapshot into a separate read-only editor. The live editor,
confirmed revision, pending batch, focus, and scroll anchor remain intact. A late
preview response is checked against the selected document and history revision.

The UI distinguishes a named checkpoint from the current head. The latest available
snapshot can be older than accepted edits. Calling the first history item “Current”
without comparing its revision gives users the wrong restore context.

Restore is an identified command that pins both a target snapshot and the current
head the person reviewed. It goes through the document authority, preserves the current
revision, and appends a new replacement/reset event. The version never moves backward.

If intervening edits advanced the head, reject the stale restore intent and refresh
the comparison. A new user decision creates a new attempt. Independent SQL overwrites
around the owner would leave connected editors, snapshots, and the head disagreeing.

Before local restore, resolve the pending batch or retain a recovery copy. Other
participants can also have pending edits when the reset arrives. If the editor model
cannot map those edits meaningfully, stop automatic submission and offer recovery.

### Access is part of the current document context

Owners share and delete. Editors alter content. Commenters discuss without modifying
the body, while viewers read. The UI exposes these capabilities, and every backend
command checks them independently of which controls happened to be visible.

A permission change participates in current admission and invalidates active
subscriptions. A long-lived socket cannot keep using the role it had at connection
time after the document is revoked or deleted.

Current access also protects bootstrap, replay, version previews, comments, and presence.
An old snapshot or query cache is not a lasting capability. Account/document generation
checks prevent a slow response from restoring a previous user's document after logout.

There is a practical limit: the application cannot revoke text already copied by a
reader. Its enforceable promise is to stop future protected delivery and mutations,
while handling unresolved local work according to an explicit recovery policy.

| Choice | Benefit | Cost or failure mode |
|--------|---------|----------------------|
| ✅ Versioned anchors, isolated preview, guarded restore | Review actions preserve their intended context | Mapping and recovery states across the stack |
| ❌ Fixed offsets and direct content replacement | Small initial implementation | Comments drift and restore races with active edits |
| ❌ Permission check only on join | Few steady-state checks | Revoked sessions retain effective access |

> “Comments, history, and sharing are not independent decorations around the editor. They refer to the same changing document, so their commands must carry the version and permission context the user acted on.”

## 🔧 Deep dive 3: recover and stay responsive under load — 7 minutes

### Open one coherent revision

The server supplies snapshot S plus committed steps through H, and the client starts
from exactly H. If a snapshot's body is old, the server must not label it with a newer
in-memory counter. That would corrupt the base for every later edit.

Live subscription and durable replay overlap safely by version. A message received
out of order does not advance the confirmed version past a missing step. Reconnect,
sequence checks, and periodic head reconciliation repair missed delivery, including
the final lost event when no later edit arrives to reveal the gap.

Accepted steps and their receipts are the durable facts. The outbox closes the gap
between committing those facts and publishing them. Delivery can repeat after a crash;
clients/gateways recognize already integrated ranges.

Snapshot workers reconstruct a committed revision, verify the content, and publish a
manifest after storage succeeds. They can run independently of live typing. Compaction
retains required replay and attempt-outcome evidence for the declared recovery window.

### Failure changes status, not the meaning of Saved

If durable storage is unavailable, keep the local editor usable within a bounded pending
budget but stop authoritative saved acknowledgments. If the owner crashes after commit,
a replacement resolves the receipt and recovers committed state under a new epoch.
Storage rejects an old owner's late writes.

If only live delivery fails, accepted content remains safe and clients catch up.
If presence fails, hide or expire remote cursors while editing continues. Those failure
modes deserve different status text and operational alerts.

A circuit breaker can stop repeated dependency calls; it cannot make accepted data
durable or cancel a SQL write that timed out. Outcome resolution and the durable log
are required even when the breaker is working as designed.

### Bound work on both sides

The browser lets the editor own its DOM, composition, selection, and undo. React
subscribes to small derived values for toolbar and save state. Replacing editor JSON
on every response or global store update risks both jank and lost input context.

Coalesce presence by connection and expire it. Use mapped editor decorations or a
carefully measured overlay rather than rebuilding the document for each cursor.
Long comment and history lists can be virtualized independently of editable text.

Arbitrarily unmounting paragraphs can break native selection, composition, and screen
reader navigation. I would profile within a stated document budget before choosing
editor-aware block rendering or section partitioning. Large paste and formatting
changes belong in the performance scenarios, not only scrolling.

The backend bounds submitted bytes/steps, document size, room membership, replay range,
and per-connection output queues. A slow reader is disconnected with a resumable
position before its buffer threatens the owner process. Content is replayable; cursor
updates can be coalesced or dropped.

Scale owners by document and gateways by connection/delivery work. One hot document
still has serialized admission. Section sharding changes cross-section edits, comments,
and undo, so it needs a separate product and model discussion.

| Choice | Why it fits | Cost |
|--------|-------------|------|
| ✅ Durable replay plus bounded live delivery | Recovers missing updates without unbounded socket buffers | Cursors, retained history, and gap detection |
| ❌ Rely on every broadcast arriving | Short happy path | Disconnects leave clients permanently behind |
| ❌ Virtualize arbitrary editable paragraphs | Fewer mounted nodes | Can break selection/composition and accessibility |

> “I would use the durable history to make network delivery recoverable, then budget browser and server work separately. A correct protocol still needs a responsive editor, and a fast editor still needs a recoverable save.”

## 🛡️ Verification and operations — 3 minutes

I would verify the complete journey in two browser contexts, not infer collaboration
from a green socket icon. Type, format, and comment concurrently; lose an acceptance
response; restart the owner; reconnect and compare the committed document and identities.

| Scenario | Expected result |
|----------|-----------------|
| Same attempt is submitted twice concurrently | One terminal outcome and one accepted range at most |
| Connection drops after commit | Retry resolves without inserting the text twice |
| Snapshot and replay disagree | Explicit recovery failure, not an invented current version |
| Comment's selected text is removed | Draft/thread survives with detached context |
| Restore races with new edits | Stale intent is rejected before replacing the head |
| Account or document changes during a request | Old result cannot replace the new scope |
| Permission is revoked on an open socket | Subsequent protected reads and commands stop |

Frontend checks cover input-to-paint, composition with remote updates, keyboard focus,
large paste, and navigation memory. Backend checks cover serialization, fencing,
receipt retention, contiguous replay, and snapshot publication failures.

Measure saved-ack latency and unresolved-work age separately from socket uptime and
in-memory handler duration. Use body-free batch IDs for diagnosis, with bounded metric
labels and no document content or credentials in logs.

## ⚖️ Decisions and implementation boundary — 2 minutes

The proposal connects immediate editor transactions to fenced durable admission,
version-aware review, and recoverable delivery. It trades unrestricted offline merging
for a clear online authority, and accepts explicit pending/recovery UI rather than
claiming every network response is a successful save.

The actual [Editor](./frontend/src/components/Editor.tsx) does not send operations,
and [DocumentPage](./frontend/src/routes/DocumentPage.tsx) does not apply received edits.
The backend has experimental transforms and presence, but its
[persistence timer](./backend/src/services/collaboration/persist.ts) saves only the last
operation of a burst and does not update content. Restore also has a BIGINT string
concatenation bug and bypasses live collaboration state.

The [architecture](./architecture.md#implementation-notes) records those limits and
source evidence. A useful final whiteboard walkthrough is one edit: local transaction,
immutable attempt, durable accepted range, canonical reconciliation, and the Saved
state that follows. Each arrow has a reason and a defined recovery path.
