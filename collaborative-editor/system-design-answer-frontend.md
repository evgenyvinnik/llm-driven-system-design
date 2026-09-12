# 📝 Design a collaborative editor: frontend interview

> “I would make typing feel immediate while keeping a clear distinction between the
> text on my screen and the edits the service has durably accepted. The difficult
> part is preserving that relationship when another person types or the connection
> drops.”

This is a proposed production design for a 45-minute interview, scoped to shared
plain text. The repository's textarea demo illustrates the intended components but
has editing and convergence defects. [Implementation
Notes](./architecture.md#implementation-notes) document that boundary.

| Time | Discussion |
|------|------------|
| 4 minutes | Scope and user-visible guarantees |
| 5 minutes | Browser architecture and contracts |
| 9 minutes | Deep dive: responsive input and concurrent operations |
| 9 minutes | Deep dive: lost acknowledgements and reconnect |
| 8 minutes | Deep dive: selection, composition, and presence |
| 6 minutes | Performance, accessibility, and permissions |
| 4 minutes | Verification and local implementation boundary |

## 🎯 Scope and user-visible guarantees — 4 minutes

I would begin with document discovery, creation, plain-text editing, participant
presence, and clear save status. Writers need edit permission; viewers can follow
changes without submitting them. A title is document metadata rather than a
character inside the shared text.

I would keep rich text, tables, inline comments, and extended offline collaboration
outside the initial scope. They introduce document-tree semantics, anchored ranges,
and longer-lived branches. I would still preserve interrupted work as a recoverable
draft rather than discard it when synchronization fails.

The primary experience is two people editing a typical 100 KB document in the same
region. Local typing should fit within a 16 ms frame budget. A reasonable design
target is p99 peer visibility below 300 ms under normal load, with a clear stale
state when the network cannot meet that target.

I would support up to 50 active writers per document initially, but most documents
will have only a few. These are assumptions for design and testing, not measured
properties of the demo.

There are two different guarantees. Local application gives immediate feedback; a
server acknowledgement says that a specific operation has entered durable history.
Neither says that every peer has already displayed the change. That distinction
determines the header's status text.

| UI state | Meaning |
|----------|---------|
| Saved | Every local edit has a resolved durable acknowledgement |
| Saving | Local changes exist that are not yet acknowledged |
| Reconnecting | Transport or sequence continuity is interrupted |
| Draft needs recovery | Local work cannot yet be safely reconciled |
| Read only | Current permission permits reading but not editing |

“Saved” must not be inferred merely from a live socket. A connection can remain open
while an operation is rejected, delayed, or lost in an application queue.

## 🏗️ Browser architecture and contracts — 5 minutes

I would draw four browser responsibilities and two service interfaces:

```
┌──────────────────┐       ┌──────────────────┐
│ Document list    │──────▶│ Metadata API     │
└──────────────────┘       └──────────────────┘
┌──────────────────┐       ┌──────────────────┐
│ Editor adapter   │◀─────▶│ Sync controller  │
│ Text / selection │       │ Base + pending   │
└──────────────────┘       └────────┬─────────┘
                                    │ WebSocket
                           ┌────────▼─────────┐
                           │ Document service │
                           └──────────────────┘
```

The editor adapter translates browser input into document operations and maps model
positions to rendered selection. The synchronization controller owns operation
context, acknowledgements, and reconnect behavior. Document metadata and the
participant roster are separate stores, so a cursor movement does not rebuild the
text surface.

React renders the surrounding product interface. The text adapter has a deliberate
ownership boundary: a browser input event produces an operation against the old
model, then that operation changes the model once. It must not replace the model
with the new DOM text and subsequently apply the same change again.

I would use one protocol implementation for operation semantics, with compatibility
tests between deployed client and server versions. Sharing types helps development
but does not validate untrusted messages or prove convergence. Each inbound message
still needs a runtime shape and sequence check.

| Contract | Information the browser needs |
|----------|-------------------------------|
| Document metadata | ID, title, current permission, metadata revision |
| Initial baseline | Document ID, content, committed version, protocol version |
| Edit submission | Stable operation ID, original base version, validated operation |
| Acknowledgement | Matching operation ID and committed version |
| Remote edit | Document identity, ordered version, canonical operation |
| Recovery response | Receipt outcome and missing history or a coordinated baseline |
| Presence | Participant identity, cursor position, position version, freshness |

A newly opened document needs a baseline at version V followed by every committed
edit after V. The service should establish that boundary while subscribing. Loading
a snapshot first and independently attaching a stream can lose the edit between
those actions.

Each connection also gets a local generation token. A callback from the old document
or an old socket must not change the current document's store. This matters when the
user switches quickly between documents or identities.

## 🔧 Deep dive: responsive input and concurrent operations — 9 minutes

I would choose immediate local application with one operation awaiting
acknowledgement. Further local edits accumulate behind it. This makes input
independent of a round trip while keeping the number of submitted operation contexts
manageable.

Consider both users opening “cat.” Alice inserts X after c, while Bob inserts Y
after a. Bob's original position refers to the three-character document. Once
Alice's edit is accepted, Bob's insertion needs to move one position to preserve its
location after a. Both views should eventually show “cXaYt.”

The operation describes retained text, inserted text, and deleted text. I would
explain that vocabulary with the example rather than draw every pair in the
transform matrix. The important property is that a remote edit and the local pending
edit are transformed together into compatible contexts.

The browser has three useful working states:

| State | Next local edit | Matching acknowledgement |
|-------|-----------------|--------------------------|
| Synchronized | Apply locally and submit | No outstanding request to retire |
| Awaiting acknowledgement | Apply locally and buffer | Retire the in-flight edit |
| Awaiting with buffered edits | Apply locally and extend buffer | Compose and submit the next batch |

A remote edit can arrive in any of those states. When there is local pending work, I
transform the remote operation through the in-flight operation and then the unsent
buffer. The paired transformations also update the pending operations so they remain
valid when submitted later.

The server and browser need the same tie policy. Suppose two writers insert at the
same position in an empty document. If the server prioritizes the newly arriving
operation while the client prioritizes the already committed operation, they can
produce BA and AB. Merely importing the same transform class does not resolve that
protocol disagreement.

For this design, already committed insertions precede newly admitted concurrent
insertions at the same position. The exact policy is less important than applying it
consistently across server admission and client reconciliation. A tested algorithm
and protocol are preferable to inventing case handling during the interview.

Acknowledgement retires the matching in-flight operation; it does not insert its
text again. The text already exists in the optimistic view. The controller then
submits the next composed batch using the correct committed base and a new operation
identity.

I would keep the original submitted request immutable for retry purposes, separately
from its transformed local representation. Otherwise receiving a remote operation
can accidentally change what is later retried under the same ID.

| Approach | Benefits | Costs |
|----------|----------|-------|
| ✅ Local application + one submitted edit | Immediate typing, bounded submitted context | Transform and reconciliation state machine |
| ❌ Wait for acknowledgement before rendering | Simpler authoritative view | Every keystroke feels the network delay |
| ❌ Replace the entire document on each save | Simple request payload | Concurrent saves can overwrite unrelated edits |

The chosen approach gives up implementation simplicity. A long acknowledgement delay
can accumulate many local edits, so I bound the buffer by bytes and age, coalesce
where safe, and surface interrupted synchronization before memory grows
indefinitely.

OT is a fit for the connected, centrally ordered scope. If sustained offline editing
becomes the core product requirement, I would evaluate a mature CRDT integration and
its editor binding. That is a different synchronization model, not just a longer
retry timer.

> “The unit of correctness is the old document plus an operation and its context.
> Treating an edit as an arbitrary replacement string makes concurrency look simpler
> until another writer's work disappears.”

## 🔧 Deep dive: lost acknowledgements and reconnect — 9 minutes

The hardest disconnect happens after the service commits an edit but before its
acknowledgement reaches the browser. The browser cannot tell whether the operation
was rejected, lost before admission, or committed successfully. Reconnecting does
not answer that question by itself.

I would assign each submitted edit a stable ID and preserve its original base and
payload. On reconnect, the controller asks the server for that operation's durable
receipt. A committed receipt retires the request without applying it twice; an
unseen result allows the identical request to be resubmitted under the same
identity.

The server must bind the ID to the authenticated actor and document and reject
different content under a reused identity. A one-hour cache alone is inadequate if a
laptop reconnects after the cache expires. The retry guarantee needs a stated
retention horizon backed by durable storage.

Recovery also needs the missing committed sequence. The client can buffer later
events briefly, but it cannot apply version 12 directly to a base at version 10 just
because the strings happen to have the same length. It requests version 11 before
advancing.

I would reconnect with bounded exponential backoff and jitter, but only after
establishing that the old socket is no longer authoritative for this controller. The
old close handler must not clear the new socket. Subscriptions, retry timers, and
pending work all belong to one document/account generation.

There are two recovery paths. For a short interruption within retained history,
resolve the in-flight receipt, replay the suffix, transform pending changes, and
resume. For an unsupported old base or invalid local state, preserve the draft and
show current server content separately, with an explicit user recovery action.

I would not silently merge arbitrary strings in the second path. A line-based
comparison might help someone recover a paragraph, but it is a user-assisted
document repair rather than proof that the original operation stream converged.

| Recovery strategy | Benefits | Costs |
|-------------------|----------|-------|
| ✅ Receipt + ordered replay + preserved draft | Resolves ambiguous edits and retains local intent | More state, persistence, and product UX |
| ❌ Replace with latest snapshot immediately | Quickly obtains current server text | Can erase unsent work or hide an unresolved commit |
| ❌ Resend every local edit under new IDs | Easy transport retry | Can duplicate edits already accepted before disconnect |

For the initial product, I would stop new collaborative admission during an
unresolved recovery and preserve the draft locally. If continued offline composition
is later supported, it needs explicit limits, device storage lifecycle, and a tested
rebase policy. A browser cache does not by itself make a protocol offline-capable.

Account switching must clear the old account's rendered content and subscriptions
while keeping any recovery draft scoped to its owner. Permission revocation stops
submission and future content delivery. It should not silently upload a revoked
user's draft into a document they can no longer access.

The status banner should say what is unresolved: waiting for connection, checking a
previous save, or needing draft recovery. A permanent “Connecting...” indicator with
no retry mechanism gives the user no useful path forward.

> “I would rather retain a recoverable draft with an honest status than label a new
> snapshot as a successful recovery while deleting the work the user was waiting to
> save.”

## 🔧 Deep dive: selection, composition, and presence — 8 minutes

Text convergence is necessary, but a cursor that jumps on every remote edit still
makes collaboration unusable. A cursor is a position in a particular document
version, not a permanent numeric offset.

If another writer inserts five characters before my caret, the caret usually needs
to move five positions to remain next to the same text. If they delete the range
containing it, the caret moves to the deletion boundary. The adapter needs a defined
affinity when an insertion happens exactly at the caret.

I would transform both ends of a selection through accepted edits. The document
protocol uses one agreed position unit, while the editor adapter preserves
user-visible character boundaries. In this JavaScript design the wire offsets can
use UTF-16 units, but user-facing navigation must avoid splitting an emoji or
combining sequence.

During IME composition, the browser is assembling input that is not yet a final
edit. Replacing the DOM value during that interval can interrupt composition. I
would let the adapter own the composition range, defer conflicting presentation
updates as needed, and reconcile the resulting committed input against the correct
base.

That means text rendering cannot be a generic effect that writes a new string into
the textarea after every store update. The adapter needs an explicit transaction
boundary that updates content, maps selection, and preserves scroll position
together.

A native textarea is useful for the initial plain-text surface, but it has limited
support for drawing other people's carets. I would first show a participant roster,
then add an overlay only if the product needs accurate remote positions and we can
reliably measure wrapping, scrolling, and font layout.

Presence can be approximate. I would coalesce updates to the latest cursor per user,
publish at a modest rate, and expire stale sessions using heartbeats. A missed
cursor update is repaired by the next one; it does not deserve the same durable log
as document edits.

| Presence strategy | Benefits | Costs |
|-------------------|----------|-------|
| ✅ Ephemeral, coalesced cursor state | Low overhead; stale state naturally expires | Positions can lag or briefly disappear |
| ❌ Persist every pointer movement | Complete event trail | High write volume with little document-recovery value |
| ❌ Reuse unversioned offsets unchanged | Simple sidebar implementation | Cursors drift when text before them changes |

I would isolate presence rendering from the editor model. Fifty collaborators moving
their cursors should not trigger fifty full text replacements or remeasure the
entire document. Layout work is scheduled together, and only visible overlays need
geometry updates.

For a future rich-text product, I would use an editor engine with transaction and
selection mapping support. I would not extend a plain-string diff by adding
arbitrary formatting attributes and claim that nested lists, undo, and concurrent
formatting now work.

Undo also needs collaboration semantics. Restoring yesterday's entire string to undo
one word would erase peers' later edits. A future undo manager should track local
intentions and transform their inverses through remote edits, with tests for
overlapping deletions.

## ⚡ Performance, accessibility, and permissions — 6 minutes

The first performance risk is work proportional to document size on every keystroke:
full-string diffing, copying, React rerenders, and layout measurement. I would
profile long documents and paste events before introducing workers or custom storage
structures.

For moderate text sizes, a simple representation is easier to verify. As documents
grow, the adapter can emit operation deltas directly and the model can use a
structure that avoids copying the entire text for small edits. Those optimizations
must preserve the same operation and selection semantics.

I would virtualize a long document list independently of the editing surface.
Virtualizing editable text has extra constraints around selections, accessibility,
and composition; it is not interchangeable with virtualizing a feed of read-only
cards.

Slow peers need bounded delivery queues and a resumable version. Dropping arbitrary
document operations to keep a UI fast corrupts its base. Coalescing presence is safe
under its latest-state semantics; coalescing text must preserve a valid composed
operation.

For accessibility, provide keyboard access to document selection and editor
controls, a proper text-field label, visible focus, and a status announcement when
save/reconnect state changes. Do not announce every remote keystroke or rely only on
collaborator colors.

The layout should preserve the writing area on smaller screens, moving the
participant list into an accessible disclosure. A remote-edit notification should
not steal focus. Error messages should distinguish inability to load a document from
an empty account.

Permission checks on the server remain authoritative. The browser disables edit
controls when its grant changes, but a read-only prop alone is not enforcement.
Metadata updates should include a revision check so two people renaming the document
receive an understandable conflict instead of silently overwriting each other.

I would measure local input latency, remote-application latency, pending-buffer
size, time awaiting acknowledgement, reconnect outcomes, and draft-recovery
frequency. Those measurements explain user experience more directly than counting
open sockets alone.

## 🧪 Verification and local implementation boundary — 4 minutes

I would start with deterministic transform and composition examples, including
same-position insertion, overlapping deletion, emoji offsets, and unequal retain
lengths. Then simulate two clients with delayed delivery and verify equal committed
text after both acknowledge all work.

Recovery tests should disconnect before submission, after commit but before
acknowledgement, and while buffered edits exist. Document-switch tests should
deliver an old socket callback after a new connection opens. Browser tests should
cover typing, paste, selection replacement, IME composition, and a remote edit
before the caret.

The repository has React, Zustand, a textarea adapter, one in-flight operation, and
a participant sidebar. It does not implement stable edit IDs in browser messages,
reconnect, local draft persistence, a history UI, remote caret overlays, or a shared
OT package.

The source review reproduced a basic input failure: the component writes new text
into the store before applying an operation based on the old text. It also
reproduced transform/compose failures and inconsistent same-position insertion
priority. These prevent treating the demo's Saved indicator or page-load smoke test
as evidence of reliable collaboration.

| Decision | Interview choice | Main cost |
|----------|------------------|-----------|
| Input and concurrency | Immediate local operations with one in flight | A rigorously tested reconciliation state machine |
| Recovery | Durable receipts, ordered replay, preserved drafts | More protocol and recovery UI |
| Selection and presence | Versioned positions and ephemeral awareness | Editor integration and geometry work |

The first implementation milestone would be trustworthy single-document typing and
two-client convergence. Recovery and accessibility follow before expanding into rich
text or more server instances.
