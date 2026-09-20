# Google Docs: frontend system design interview

A proposed 45-minute design for a collaborative rich-text editor. The repository's
smaller demo is discussed at the end; this answer describes the design I would propose
at a whiteboard, not a completed feature list.

## 🎯 Clarify the experience — 5 minutes

> “I would start with the promise users care about: typing feels immediate, collaborators converge on the same document, and the editor tells me whether my work is actually saved. I will cover basic rich text, small editing groups, comments, sharing, and version history.”

The first release supports paragraphs, headings, lists, and common formatting marks.
I would bound document size and active editors instead of promising arbitrary page
counts. Tables, embedded applications, precise print pagination, export, and full
tracked-change suggestions are later extensions.

Short disconnects should preserve local work. Unlimited offline collaboration is a
separate requirement because it affects the synchronization model and how much history
we retain. I would ask whether the interviewer wants that trade explored before
making every document an indefinitely disconnected replica.

I would distinguish four states: visible locally, waiting for acknowledgment,
committed to the service, and observed by another participant. A connected socket does
not imply saved content, and a browser storage write is only local recovery.

| User action | Expected behavior |
|-------------|-------------------|
| Type or format | Update locally without waiting for the server |
| Receive another edit | Preserve local intent, selection, and a coherent document |
| Lose the connection | Keep work and show the unresolved save state |
| Add a comment | Preserve the draft and attach it to the intended revision/range |
| Preview history | Keep the live editing session separate from the preview |
| Lose edit permission | Stop submission, preserve unresolved work, explain the new capability |

For planning, I would propose p95 local input-to-paint below 50 ms on a named modest
device, and peer visibility below 200 ms in the document's home region. I would measure
initial usable editor time separately from complete sidebar/history loading.

The semantic requirement is more important than those illustrative numbers: no response
may replace newer authored work merely because it arrived last. Document ID, account,
protocol schema, and request generation belong to the response context.

## 🏗️ Draw the editor and its state boundaries — 5 minutes

I would draw three views and their owners, then the shared transport boundary. The
editor model is specialized state, while comments and presence have different lifetimes.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER / ACCOUNT, DOCUMENT AND SCHEMA CONTEXT                                           │
│                                                                                          │
│  ┌────────────────────────┐    ┌────────────────────────┐    ┌────────────────────────┐  │
│  │ Editor + toolbar       │    │ Review panels          │    │ Presence view          │  │
│  │ Input / formatting     │    │ Comment draft/history  │    │ Names / mapped cursors │  │
│  │ Selection/composition  │    │ Share / restore UI     │    │ Independent frame work │  │
│  └────────────────────────┘    └────────────────────────┘    └────────────────────────┘  │
│               ▲                             ▲                             ▲              │
│               │                             │                             │              │
│ local input   │              review intent  │                visual state │              │
│               │                             │                             │              │
│               ▼                             ▼                             ▼              │
│  ┌────────────────────────┐    ┌────────────────────────┐    ┌────────────────────────┐  │
│  │ Editor + collab model  │    │ Review/query state     │    │ Presence state         │  │
│  │ Schema/steps/selection │◀──▶│ Pinned revision/anchor │    │ Connection + version   │  │
│  │ Pending work + history │    │ Drafts + current role  │    │ Expiring selections    │  │
│  └────────────────────────┘    └────────────────────────┘    └────────────────────────┘  │
│       ▲       ▲                             ▲                             ▲              │
│       │       │                             │                             │              │
│       │       └─────────────────────────────┼─────────────────────────────┘              │
│       │ save / restore                      ▲                                            │
│       ▼                                     ▼                                            │
│  ┌────────────────────────┐    ┌────────────────────────┐                                │
│  │ Local recovery journal │    │ Sync / API coordinator │                                │
│  │ Pending steps / IDs    │    │ Batches, ACKs, replay  │                                │
│  │ Account / doc / schema │    │ Scoped queries/errors  │                                │
│  └────────────────────────┘    └────────────────────────┘                                │
│                                             ▲                                            │
│                                             │                                            │
└─────────────────────────────────────────────┼────────────────────────────────────────────┘
                                              │
  content commands / reads / presence         │
                                              ▼
   ┌────────────────────────────────────────────────────────────────────────────────────┐
   │ Document service (server boundary)                                                 │
   │ Ordered accepted steps, durable attempt outcomes, current capability and history   │
   └────────────────────────────────────────────────────────────────────────────────────┘

The editor maps accepted steps and review anchors; presence never marks content saved.
```

Typing goes through the editor model into unconfirmed steps. The transport submits
identified batches and receives committed changes; the collaboration adapter reconciles
them before the editor renders. Review panels use pinned revisions and independent
drafts. Presence is version-relative, disposable state that never marks content saved.

I would trace a reload through the bounded account/document/schema journal:

1. Retain local pending steps and the immutable submitted attempt under an explicit storage policy. Local storage does not mark the document Saved.
2. Reauthorize, recover a coherent committed prefix, and resolve that original attempt before changing its base, payload, or identity.
3. Remove accepted work from the pending overlay. After a definitive no-effect rejection, rebase and submit a new attempt; unresolved history requires explicit recovery rather than guessing.
4. Restore review drafts against their pinned anchors. Presence reconnects with a fresh connection and is never replayed as durable content.

The shell owns navigation, account state, panel visibility, and notifications. The
editor owns document structure, selection, composition, and undo. A server-state cache
owns document metadata, paged comments, and version lists. Small Zustand slices are
reasonable for coordination, but no library should subscribe the whole page to every
keystroke or cursor movement.

I would use the editor's schema-aware transaction and mapping mechanisms. Rich text
is not a flat string with bold ranges painted over it: inserting a list item or
splitting a paragraph changes structure as well as text positions.

For this proposal I choose a centralized step-rebase protocol. The server accepts a
batch at the current base revision; a stale client catches up and rebases its pending
work. I would not mix that protocol with a Yjs-backed collaboration extension and
assume their version and undo models are interchangeable.

## 🔌 Agree on the small set of contracts — 4 minutes

> “Before discussing React components, I want enough protocol information to avoid guessing whether a write committed or which version a selection refers to.”

| Contract | What the browser needs |
|----------|------------------------|
| Bootstrap | Document/schema identity, verified snapshot revision, contiguous suffix, capability |
| Submit batch | Stable attempt ID, immutable payload, base version, bounded ordered steps |
| Acceptance | Attempt identity and accepted step range; durable outcome |
| Rejection | Explicit no-effect result, current head, bounded catch-up or resync requirement |
| Committed changes | Contiguous versions, origin/batch identities, editor steps |
| Attempt lookup | Resolve uncertainty without submitting different content |
| Comment | Comment ID, body/state version, anchored revision/range or detached status |
| Presence | Connection ID, referenced document version, cursor/selection, expiry |

A document version advances with accepted steps, not mouse movements or WebSocket
messages. A batch of three steps advances three positions in the version stream. The
client validates version ranges and does not skip a gap because a later packet arrived.

REST remains useful for document discovery, comment pages, and history. WebSocket
serves interactive batches and presence. The transport choice does not create a second
content authority: restore and other content commands still enter the same ordering path.

Bootstrap must describe one coherent document. A snapshot at revision 100 followed by
steps 101–110 is valid. An old snapshot labeled “current version 110” without those
steps is not. I would make that invariant visible in the API contract.

## 🔧 Deep dive 1: reconcile immediate typing with a durable shared document — 10 minutes

### Separate displayed state from confirmed state

The user types into the editor immediately. The collaboration plugin tracks confirmed
steps and unconfirmed local transactions, while the displayed document includes both.
The UI can show a subtle pending state without delaying the caret or input.

I would allow one unresolved submitted batch per client/document. Further local changes
remain editable and accumulate behind it. This gives one clear answer to “which request
might already have committed?” and bounds the transport state machine.

The submitted batch is immutable: attempt ID, base version, schema, and steps stay
fixed until its outcome is known. Retrying it after a lost response must not include
characters the user typed later. Those characters belong to the local buffer.

A short batching interval can combine nearby typing transactions, with a maximum delay
and byte/step limit. It must preserve transaction order and composition boundaries.
Batching is a network/storage optimization, not a reason to drop intermediate edits.

### Walk through two people editing

Suppose Alice and Bob have confirmed version 20. Alice adds a word, Bob formats a
nearby phrase, and both see their local changes immediately. The authority accepts
Alice's batch first and records its resulting version range.

Bob's attempt still names base 20. It receives a definite stale-base rejection with
no effect. Bob receives Alice's accepted steps, maps his unconfirmed formatting through
them, and submits a newly identified attempt based on the updated shared revision.

The important part is the editor-aware mapping. If Alice deleted the phrase Bob was
formatting, blindly keeping Bob's old offsets could format unrelated text. Mapping can
make the pending step empty or invalid; the interface preserves the original work for
recovery when intent cannot be represented safely.

Alice also receives her own accepted steps in the canonical stream. The adapter
confirms the matching local steps instead of inserting her word a second time.
Accepted steps from other users are integrated while local pending work is rebased.

I would use the collaboration library's transaction path, including selection and
history mappings. Calling a generic “replace document” command after every ACK loses
those relationships even if the text happens to look correct.

### Handle the uncertain outcome before rebasing

If Alice's socket drops after the server commits but before she sees acceptance, she
must not assume the batch failed. On reconnect, query the original attempt or recover
a committed range carrying its identity. Only the same frozen payload may be retried
while that outcome is unresolved.

If it committed, reconcile that accepted range and retire the matching local work.
If it was definitively rejected, rebase the remaining work and create a new attempt.
If its outcome is still unknown, retain the pending state and continue resolution.

This distinction prevents a subtle duplication bug: rebasing an already accepted
insert and submitting it under a fresh identity can add the same user intent twice.
A generic offline queue sorted by client timestamps does not resolve that ambiguity.

The server declares how long attempt outcomes and rebase history remain available.
When the browser is too old to recover safely, offer a recovery copy or a comparison
against the latest document. Do not silently clear pending edits on a fresh SYNC.

### Save status follows acknowledgments

I would expose “Saving,” “Saved,” “Offline changes,” and “Needs attention” as meaningful
states. Saved means every local content change through an identified revision has a
durable acceptance result. A one-second debounce or successful socket send is not proof.

If the user keeps typing after a batch leaves, its acceptance updates the acknowledged
revision but leaves the newer text pending. Connection status can be shown separately
so reconnecting does not turn an unresolved save green.

| Approach | Why choose or reject it here | Cost |
|----------|-----------------------------|------|
| ✅ Immediate local steps with ordered reconciliation | Responsive typing and explicit accepted history | Pending-state, mapping, and recovery complexity |
| ❌ Wait for every server response before typing | Simple shared-state reasoning | Network latency enters every interaction |
| ❌ Replace the document with the latest response | Simple rendering integration | Can destroy local edits, composition, selection, and undo |

> “I choose optimistic editing because input cannot wait for the network. I pay for that responsiveness with an explicit reconciliation protocol rather than pretending the browser and server are always at the same revision.”

## 🔧 Deep dive 2: keep rich-text interaction responsive — 8 minutes

### Give the editor control of its DOM

A mature editor owns selection, transaction application, and DOM updates. React should
render the surrounding toolbar and panels through small derived subscriptions. Copying
the entire document into a global React store on every edit creates serialization,
re-rendering, and feedback-loop work before the user gets another frame.

The toolbar observes only the active selection's formatting and available commands.
A cursor update does not rebuild the document model. An open comment panel does not
subscribe to every paragraph's text when it only needs a mapped anchor and draft.

I would lazy-load heavy history or review code after the usable editor appears. A
loading sidebar should not block typing in a ready document. Conversely, editing must
wait until bootstrap has established a valid schema and confirmed revision.

### Composition, undo, and large paste are correctness paths

Input-method composition can involve several transient browser events for one authored
sequence. I would let the editor integration handle composition rather than converting
every DOM mutation into a separate network operation. Replacing the editor state while
composition is active can lose text or move the caret unexpectedly.

Test keyboard input, mobile selection, bidirectional text, emoji, and combining marks.
Editor positions follow its model; they are not automatically bytes, Unicode code
points, or visible characters. Pasting nested content also needs schema normalization
and limits before it becomes a large synchronous task.

Undo should target the local user's logical transactions after mapping through remote
changes. Disabling all history because “collaboration handles undo” removes a product
feature; keeping an unrelated local snapshot history can undo another user's work.
Use history behavior compatible with the chosen collaboration model and test it.

For expensive optional work such as spellchecking, send bounded snapshots or ranges to
a worker and tag results with document/revision identity. Discard stale annotations.
Moving work off-thread does not make an old result correct.

### Large documents require a measured rendering plan

I would start with a stated document-size budget and incremental editor updates. Profile
large paste, scroll, text selection, and presence overlays before choosing virtualization.
The editor's DOM participates in selection and composition; unmounting arbitrary
paragraphs can break cross-paragraph selection, find, accessibility, and measurement.

Virtualize document cards, comment lists, and version lists first because those are
ordinary collections. For much larger editable documents, investigate supported block
rendering or section boundaries with the editor's model, including cross-boundary
selection and undo. That is not a generic list-virtualizer toggle.

Presence updates are coalesced to the latest meaningful state and rendered within a
frame budget. Expire old connections, cap visible labels, and avoid measuring all remote
selections on every mouse movement. A range may wrap over several lines; one rectangle
between its endpoints does not describe its visual geometry.

I would prefer editor decorations for mapped anchors and selections when supported.
A separate overlay can work, but its coordinates must account for scrolling, zoom,
line wrapping, font loading, and layout changes. Color alone cannot identify a person.

### Preserve focus as the layout changes

Formatting controls need labels, pressed states, keyboard access, and visible focus.
A toolbar action restores the intended editor selection without hijacking input in a
comment field. Global shortcuts must not intercept unrelated text-entry contexts.

Share dialogs need modal semantics, focus containment, Escape handling, and focus
restoration. Side panels can remain modeless. On small screens, closing a panel returns
the user to their prior document position instead of jumping to the top.

A restrained live region can announce save failure or permission loss. Announcing every
remote caret movement overwhelms assistive technology. Accessibility is a tested
interaction model, not a compliance claim inferred from using an editor library.

| Approach | Benefit here | Cost or failure mode |
|----------|--------------|----------------------|
| ✅ Editor-owned transactions with narrow UI subscriptions | Preserves input context and bounds surrounding renders | Requires deliberate adapter boundaries |
| ❌ Global document JSON on every event | Easy to inspect centrally | Serialization and broad updates compete with typing |
| ❌ Naive editable-paragraph virtualization | Reduces DOM count | Can break selection, composition, and assistive navigation |

> “I would optimize the work around the editor before changing how the editor renders its document. Fewer DOM nodes are useful only if the editing interaction remains correct.”

## 🔧 Deep dive 3: comments and history keep their original context — 7 minutes

### Anchor the discussion to a revision

A comment draft remembers the selected document, base revision, range, and boundary
affinity. If another person inserts text before the selection, accepted mappings move
the anchor with its intended text. The draft body remains independent of those changes.

If the selected text is deleted, keep the discussion as detached and show the original
quoted context where authorized. A collapsed range at the deletion point does not mean
the user intended to comment on the next sentence.

Before submitting an anchor that includes local unconfirmed edits, establish a committed
base or submit it through a defined combined command. Do not send raw displayed offsets
as though they belonged to the server's older document.

The server maps or rejects the anchor under the current document authority. The client
uses a stable comment attempt identity so a lost response does not create duplicate
threads. A failed submission retains the draft and tells the user what can be retried.

For reply and resolve actions, preserve the current desired state and reconcile the
canonical result. Restoring an entire cached comment list after an old failure can
remove newer replies that arrived meanwhile.

### Keep preview separate from live editing

A version preview is a read-only, pinned document instance. Opening it does not replace
the live editor's content or confirmed revision. Its loading/error state belongs to
that preview request, and later responses check the selected document/version identity.

Restore names a historical revision and the current head the user reviewed. It creates
a new document event through the same authority as edits. If the head changed before
admission, refresh the comparison and ask for a new restore intent rather than silently
replacing someone else's intervening work.

Before submitting restore, resolve the local pending batch or preserve a recovery copy.
Other participants may also have pending work when the reset arrives. The protocol
must let them stop and recover that work if automatic mapping is unsafe.

The history list should distinguish “named checkpoint” from “current document.” The
newest listed snapshot may be older than current edits, and a snapshot timestamp is
not evidence that the user's newest typing was saved.

### Permission changes affect active sessions

Viewers can read; commenters can discuss; editors can change content. Rendering the
right buttons helps explain capability, but the server enforces it for every command.
A commenter must not get an editable body just because they are not a viewer.

On revocation or deletion, stop sending, remove protected data from active views, and
cancel or ignore stale requests. Unresolved local work needs an explicit recovery
policy; do not quietly upload it after a later account switch.

The application cannot erase text a user already copied. Its enforceable promise is
that it stops returning new protected content and accepting unauthorized operations.
Long-lived sockets must follow that same rule as fresh HTTP requests.

| Approach | Why it fits | Cost |
|----------|-------------|------|
| ✅ Versioned anchors and isolated history preview | Preserves the user's intended context | Mapping, detached state, and guarded restore |
| ❌ Fixed offsets forever | Small initial model | Comments drift as earlier text changes |
| ❌ Replace live editor for preview/restore | Reuses one editor instance | Destroys pending work and mixes historical/live revisions |

> “I want a comment or restore to mean what the person reviewed when they acted. That requires carrying context through the operation, rather than relying on whatever document happens to be displayed when a response returns.”

## 🛡️ Recovery and verification — 4 minutes

I would test the whole state transition, not only individual buttons. Two browser
contexts type and format concurrently, disconnect one before its acknowledgment, and
reconnect it while the other continues. Assert that both end at the same committed
revision, each accepted intent appears once, and unsent work remains available.

| Scenario | What I would verify |
|----------|---------------------|
| Lost acceptance response | Original attempt resolves without duplicate insertion |
| Missing committed step | Client repairs the gap before applying later versions |
| Stale request after navigation | It cannot replace the new document or account state |
| Composition during remote edit | Authored text, caret, and undo remain coherent |
| Anchor text deleted | Thread becomes detached instead of moving to unrelated text |
| Failed comment or restore | Draft/context survives; no false success indication |
| Permission revoked mid-session | Future commands and replay stop under current access |

Performance measurements include input-to-paint, long tasks during paste, editor
bootstrap time, memory after repeated document navigation, and overlay work per frame.
Measure on representative devices and network conditions with realistic documents.

Log body-free operation identities and reasons for resync, not private document text.
Track unresolved-save age and recovery failures separately from socket uptime. A fast
render with an indefinitely pending queue is still a poor editing experience.

## ⚖️ Decisions and local implementation boundary — 2 minutes

I have chosen a schema-aware editor with explicit pending state, a centralized ordered
step protocol, and versioned review context. The costs are mapping and recovery logic,
an owner-dependent write path, and a bounded offline contract. A long-offline product
could justify a different collaboration model.

The local [Editor](./frontend/src/components/Editor.tsx) has no operation send in its
update callback, and [DocumentPage](./frontend/src/routes/DocumentPage.tsx) does not apply
incoming edits or SYNC content. The demo displays stored rich text and presence names,
with REST document/comment/history workflows; it does not implement the proposed sync,
offline recovery, remote caret layer, or anchored review behavior.

The [architecture](./architecture.md#implementation-notes) records the backend's
persistence, authorization, and version-history limits. I would finish the interview
by tracing one local edit through durable acceptance and peer reconciliation on the
diagram, then discussing whichever of those boundaries the interviewer wants to probe.
