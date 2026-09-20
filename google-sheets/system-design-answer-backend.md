# Google Sheets — backend system design interview

> “I would center this design on the workbook revision. An edit is saved when its raw changes
> and operation receipt commit together. Formula calculation and live delivery can follow
> asynchronously, but neither may invent a different order of accepted edits.”

This is a proposed 45-minute interview design, not a description of Google's internal system
or a claim that this repository implements the complete protocol.

## 🎯 Requirements and sizing — 5 minutes

I would clarify whether we need text-character collaboration inside a cell or collaborative
replacement of cell values. For this version, users edit a local draft and commit a cell value
or bounded paste. Two users replacing the same cell are resolved by server commit order, with
history to explain the outcome.

We support multiple sheets per workbook, same-workbook formula references, cell formatting,
presence, and conditional undo. I would defer structural row/column insertion, external
workbook references, macros, and full Excel compatibility. Inserting a row changes reference
identities and requires a separate transformation design.

| Requirement | Proposed boundary |
|-------------|-------------------|
| Workbook size | Initially 200,000 populated cells |
| Collaboration | Up to 100 active editors per workbook |
| Paste | At most 1,000 changed cells in one atomic operation |
| Durability | Acknowledged raw edits survive a process crash |
| Ordering | One monotonic committed revision per workbook |
| Recalculation | Complete results identify their input revision |
| Recovery | Retry receipts and replay, or explicit snapshot reset |
| Presence | Best effort; never part of document durability |

For sizing, assume one million daily editors making 100 committed edits each: 100 million
edits/day, around 1,157 edits/second average and 11,600 at a tenfold peak. At an illustrative
500 bytes per operation, that is 50 GB/day of history before replication and indexes.

Ten average recipients per edit imply roughly 116,000 peak deliveries/second. Presence traffic
is separate and should be throttled. These fleet estimates do not tell us whether one
workbook's ordering queue can handle a concentrated burst.

I would target p95 durable acknowledgement below 200 ms in the home region and p95 ordinary
recalculation below 500 ms. Expensive formulas get an explicit budget and visible lag. We
favor correctness over accepting writes without a reachable authority.

## 🏗️ High-level architecture — 7 minutes

I would draw the command path first, then add reads, calculation, and fanout below the durable
store. That keeps the source of truth visible throughout the conversation.

```
┌────────────────────────┐ HTTPS  ┌────────────────────────┐        ┌────────────────────────┐
│ Clients                │        │ API + socket gateway   │        │ Workbook owner         │
│ Edits / range reads    │◀──────▶│ Auth, ACL, limits      │◀──────▶│ Fenced ordering        │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
                                                                                           ▲
                                                                                           │
                                                    edit + revision + receipt              │
                                                                                           │
                                                                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ PostgreSQL partition (workbook ID): authoritative state                                    │
│ ACL, owner epoch, raw cells, ordered commits, receipts, outbox                             │
│ Immutable snapshot chunks + versioned formula-result batches                               │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                       ▲                                  ▲                                ▲
                       │                                  │                                │
 snapshot + replay     │           committed outbox       │          inputs / results      │
                       │                                  │                                │
                       ▼                                  ▼                                ▼
┌────────────────────────┐        ┌────────────────────────┐job/ACK ┌────────────────────────┐
│ Range reader           │        │ Outbox relay           │        │ Formula workers        │
│ Revision-pinned reads  │        │ Retry by event ID      │◀──────▶│ Pinned input / result  │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
                       ▲                                  ▲
                       │                                  │
 scoped ranges         │           edit + calc events     │
                       │                                  │
                       ▼                                  ▼  cursors
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ Authorized range API   │        │ Authorized fanout      │        │ Presence / pub-sub     │
│ Snapshot / revision    │        │ Ordered replay feed    │◀──────▶│ Ephemeral Valkey       │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
            ▲                                  ▲
            │                                  │
            ▼                                  ▼
┌──────────────────────────────────────────────────────────┐
│ Clients apply canonical state + pending overlay          │
│ Detect gaps; resume or request a new snapshot            │
└──────────────────────────────────────────────────────────┘
```

Commands enter through an authenticated gateway, which verifies workbook and sheet access and
routes them to the current workbook owner. The owner commits the changed raw cells, next
revision, receipt, and outbox in one PostgreSQL transaction.

The lower-left path serves revision-pinned ranges reconstructed from a checkpoint and retained
operations. It does not combine independently current rows and call that a coherent snapshot.

The middle path relays committed events. Gateways recover missing revisions from durable
history before relying on live delivery. Valkey may distribute notifications, but publication
success is not the durability boundary.

The right path calculates formulas from identified inputs and stores complete result batches.
Publishing a result pointer and its event is also durable. Presence shares gateway
infrastructure but has no place in the raw edit log.

I would trace a worker restart and a client reconnect separately:

1. Formula work recovers the same pinned input and engine version, verifies a complete result batch, and conditionally publishes its pointer and event.
2. Relay progress follows confirmed handoffs/effects; replaying work cannot regress the published calculation revision.
3. Clients resolve edit receipts and request a contiguous feed after their known revision. Authorization still applies to replay and range reads.
4. An expired token triggers a new coherent snapshot. Retention preserves the checkpoint and suffix needed by supported tokens; it never silently returns unknown cells as blanks.

I would partition by workbook ID because formulas can reference other sheets in that workbook.
A per-sheet owner would need coordination for cross-sheet snapshots. Keeping the workbook
together gives us a simpler initial consistency domain at the cost of a ceiling on one
workbook's throughput.

These are logical services. A first implementation can co-locate several components and split
them only when queue depth, connection count, or calculation cost justifies it.

## 💾 Data model and API contract — 4 minutes

| Record | Key fields | Access pattern / invariant |
|--------|------------|----------------------------|
| Workbook | ID, home region, owner epoch, raw revision | Lock/check authority before writes |
| Membership | Workbook, actor, role, permission version | Authorize commands, ranges, replay, export |
| Sheet | Workbook, sheet ID, dimensions | Fixed coordinate bounds in this version |
| Cell | Sheet, row, column, raw input, format, edit revision | Unique position; conditional undo |
| Operation receipt | Workbook, actor, operation ID, digest, revision | Identical retry returns original outcome |
| Ordered history | Workbook, revision, changed cells, actor | Replay and snapshot reconstruction |
| Outbox | Event ID, workbook/revision, delivery state | Retry publication after commit |
| Snapshot chunk | Workbook, checkpoint, range, immutable values | Read a consistent revision |
| Calculation batch | Workbook, input revision, engine version, results | Publish only a complete identified batch |

Current rows are efficient for writes; immutable checkpoints and history make revisioned reads
possible. Retention must preserve the data required by active snapshot tokens and the
supported replay window.

| Interface | Purpose |
|-----------|---------|
| GET workbook metadata | Sheets, permissions, raw and calculation revisions |
| GET workbook range | Snapshot token, rectangle, values at a defined revision |
| Submit edit command | Scoped operation ID, payload digest, bounded changes |
| Get operation outcome | Resolve a lost acknowledgement without a new edit |
| Subscribe/resume feed | Last revision, replay, then ordered live changes |
| Undo command | Original operation and expected current cell versions |
| Presence message | Sheet, selection, user, expiry; disposable |

HTTP bulk edits and WebSocket edits must invoke the same command path. A second route that
writes cells directly would bypass ordering, formula invalidation, and recovery guarantees.

## 🔧 Deep dive: ordering, ownership, and durable retries — 8 minutes

> “I would choose one logical writer per workbook, but I would enforce its authority in the
> database. A process believing it owns the workbook is not enough.”

### What happens inside the commit

The owner checks authorization and validates the operation's bounds and supported formula
syntax. It then enters a short transaction that checks the workbook's current owner epoch and
locks the authority row.

An actor-scoped operation ID identifies the logical request. If the receipt exists with the
same digest, return its original outcome. If the same ID carries different content, reject it.
Otherwise allocate the next revision, change the raw cells, and insert history, receipt, and
outbox together.

Only after commit do we acknowledge success. Formula evaluation that can be expensive must not
run while this transaction holds the workbook lock. Validation is bounded; calculation is a
separate stage.

The uniqueness of the receipt key protects against concurrent duplicate submissions. A failed
transaction does not leave a receipt saying an edit succeeded. A successful transaction
followed by a lost response can be retried without changing the workbook again.

A delayed retry illustrates why an UPSERT alone is insufficient: A sets B4 to 10, B later sets
it to 20, then A retries. Blindly setting 10 again would erase B's accepted edit. A durable
receipt returns A's historical success without replaying its effect.

### Fence an old owner

Suppose owner A pauses long enough that its lease expires. Owner B takes over. When A wakes
up, it may still have queued commands and an open database connection.

Ownership transfer increments the epoch under the same authority-row protocol used by writes.
A command with A's old epoch is rejected inside its transaction. If an A transaction already
holds the authority lock, transfer waits for that transaction to finish before installing B's
epoch.

A Redis lease without this database check leaves a stale-writer window. A lock protocol also
works only if every writer, including admin tools and REST routes, participates. I would make
the command boundary the sole write interface.

PostgreSQL's [explicit locking
documentation](https://www.postgresql.org/docs/16/explicit-locking.html) describes the
transaction lifetime of row locks. Fencing is an application protocol built around that
behavior, not an automatic property of a lease library.

### Resolve the conflicts we actually scoped

Ordinary cell replacement follows commit order. Atomic paste occupies one revision and applies
its bounded changes together. We do not transform characters inside a cell or claim that
ordering solves row insertion.

Undo is conditional. It can restore the previous value only if the relevant cells still have
the versions produced by the original operation. Otherwise the user sees a conflict and
chooses a new edit. Unconditional inverse operations would overwrite intervening work.

| Approach | Why it fits / fails here | Cost |
|----------|--------------------------|------|
| ✅ Workbook owner + fenced SQL commit | Coherent cross-sheet inputs, paste, receipts, and order | One workbook has a write-throughput ceiling |
| ❌ Independent cell registers alone | Simple replacement convergence, but no atomic workbook revision or calculation snapshot | Extra coordination is still needed |

I accept home-region write latency and reduced availability during authority loss. For a
spreadsheet used to make decisions, accepting mutually inconsistent edits during a partition
would be a more damaging default.

## 🔧 Deep dive: bounded, revisioned formula calculation — 8 minutes

> “A formula is an untrusted program in a deliberately limited language. I would give it a
> parser, explicit dependencies, and a resource budget; I would not evaluate it as
> host-language code.”

### Build a dependency model

A formula parser recognizes only supported operators, functions, and references. It produces
an expression tree and dependency information. A1 notation resolves to a sheet and coordinate
within the workbook; cross-workbook data is excluded from this version.

When an input changes, invalidate its reachable dependents and evaluate them in dependency
order. Detect a cycle and report an explicit formula error. Do not repeatedly recurse until
the process stack or time budget is exhausted.

Ranges need careful representation. A formula summing a million-row range should not
necessarily create a million individual graph objects. Range dependency nodes or aggregate
indexes can reduce that cost, while admission limits keep the first implementation bounded.

I would define numeric and error semantics consistently across the engine. Locale affects
parsing and display through an explicit workbook setting; random values, current time, and
external fetch functions would be excluded initially because replay should not silently change
their result.

### Calculate an identified input snapshot

A worker receives workbook revision R and an engine version. It reads a coherent view at R,
calculates the permitted dependency closure, and writes a result batch identified by those
inputs.

Results are staged until complete. Publishing the batch pointer and an outbox event happens
atomically, and the published calculation revision must never move backward. A delayed worker
for R minus 1 cannot overwrite a newer batch.

Raw edits may advance while calculation runs. The system can therefore have raw revision 81
and calculation revision 79. That is a valid, visible state: inputs are saved and results are
still catching up. It is not valid to describe the result as calculated from 81.

Queued work can be coalesced to a newer input revision, but indiscriminately canceling every
running job would starve results during continuous editing. I would keep bounded work
progressing, publish its identified results, and schedule the latest required successor.

### Bound expensive work

Limits cover formula length, nesting, dependency count, referenced range size, memory, and
elapsed execution. Worker isolation prevents a calculation failure from blocking socket
heartbeats and unrelated workbook edits.

A budget failure preserves the saved raw formula and returns a specific result error. The user
can simplify the expression. The system must not quietly keep an old value while marking it
current.

Calculation workers scale across workbooks and, where dependencies permit, independent
subgraphs. A single dense dependency chain remains sequential. Adding workers does not remove
that critical path.

| Approach | Why it fits / fails here | Cost |
|----------|--------------------------|------|
| ✅ Asynchronous revisioned batches | Expensive formulas do not hold the edit transaction | Separate raw/result freshness and worker scheduling |
| ❌ Full recalculation before every commit | Easy immediate consistency for tiny sheets; long formulas block the whole room | Unbounded commit latency and lock contention |

Synchronous calculation is reasonable for a tightly limited toy workbook. Our shared workload
needs a clear saved-input boundary even when calculation is slow, so I accept eventual derived
results and make their revision explicit.

## 🔧 Deep dive: snapshots, replay, and live fanout — 7 minutes

> “Live messages reduce latency. The durable history is what lets me recover when those
> messages are missed.”

### Establish a synchronization boundary

On open, return a token identifying an immutable checkpoint S and a target raw revision R. A
range reader applies the retained operations between S and R to reconstruct the requested
rectangle. The client buffers events after R while installing its first viewport.

This avoids a common race: joining the room, reading several changing tables, and then sending
a full state that overwrites a newer live edit. Snapshot and stream must meet at an explicit
revision, even when the browser fetches only a viewport.

Tokens have limits and expiry. Checkpoint chunks and required history remain available while
tokens are valid. If a client resumes outside the retained window, return a reset requirement
and a new snapshot, preserving its pending operation identities for separate resolution.

### Publish after commit without losing the event

The edit transaction writes an outbox record. A relay reads committed records and publishes
them, retrying by event ID. A process crash between commit and publication delays delivery but
does not erase the fact that publication is needed.

The relay can deliver duplicates or encounter out-of-order transport delivery. Gateways track
per-workbook revisions and request missing history before advancing the canonical feed. They
do not declare a revision complete because a pub-sub notification arrived.

Formula events identify both their input revision and result-batch identity. They are distinct
from raw edit revisions, so a repeated calculation event does not masquerade as another user
edit.

### Protect the system from slow peers

Per-connection buffers are bounded. Drop superseded cursor positions first. If a client cannot
keep up with durable events, close the live stream with a replay/reset instruction instead of
accumulating unlimited memory.

Reconnection uses backoff and jitter. Reading retained history is paced so a gateway restart
does not produce a database stampede. A hot workbook can have many gateway subscribers without
requiring all sockets to live on the owner process.

Access is rechecked for ranges, history, and resumed subscriptions. Revoking access must
remove the established socket from the room; authenticating only the initial handshake is
insufficient.

| Approach | Why it fits / fails here | Cost |
|----------|--------------------------|------|
| ✅ Durable history + live notification | Recover missed delivery with a defined snapshot boundary | Retention, replay admission, and token lifecycle |
| ❌ Pub-sub as the only history | Fast online delivery but no durable catch-up for disconnected clients | Missed edits require an uncontrolled full reload |

I give up the apparent simplicity of “broadcast after every write.” The additional protocol is
justified because brief disconnects and gateway restarts are normal, not exceptional
spreadsheet usage.

## 📈 Scaling, failures, and verification — 4 minutes

I would scale owners and PostgreSQL partitions by workbook ID. Gateways scale with sockets and
delivery bytes; workers scale with calculation cost. Presence gets its own budget so cursor
movement cannot starve durable edits.

The first concentrated bottleneck is often one workbook's queue or dependency graph. I would
cap paste size, rate-limit expensive edits, and move hot workbooks to dedicated capacity
before attempting to split one consistency domain.

| Failure test | Expected evidence |
|--------------|-------------------|
| Crash after commit, before ACK | Retry returns the original receipt and revision |
| Two owners after a pause | Stale epoch cannot write |
| Lost/repeated outbox delivery | One canonical effect; replay fills the gap |
| Slow old formula job | Published calculation revision never decreases |
| Snapshot token expiry | Explicit reset; no silently incomplete range |
| Undo after another user's edit | Conflict instead of overwriting that edit |

Metrics should expose commit latency, owner queue age, receipt hits, replay gaps, outbox age,
calculation lag, and formula budget rejections. Workbook IDs belong in sampled traces, not
unbounded metric labels.

For regional failure, I would state the database durability policy explicitly. Zero loss of
acknowledged edits requires suitable durable replication and fenced failover; merely keeping
an asynchronous replica does not prove that guarantee.

## 🧭 Close and implementation comparison — 2 minutes

> “The three guarantees I would defend are an atomic raw-edit commit, a formula result tied to
> known inputs, and a recoverable boundary between snapshots and live messages.”

The repository currently stores cells in PostgreSQL and broadcasts through local WebSocket
rooms. Its Redis receipts are optional, checked before and stored after SQL without an atomic
claim; the browser sends no request IDs. Redis publication has no wired subscriber path.

There is no workbook revision, owner fencing, durable operation log, transactional outbox, or
replay. Formula evaluation runs synchronously, handles literal examples, and falls back to
unrestricted JavaScript without reference resolution. REST bulk edits take a different write
path and do not publish to collaborators.

Those are useful teaching gaps, but they must not be described as an implemented distributed
spreadsheet. The verified mapping is in
[architecture.md](./architecture.md#implementation-notes), with setup in
[README.md](./README.md).
