# Google Sheets - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for a collaborative spreadsheet: many people editing one grid at once, with live cursors, formulas that recalculate, and undo that works even though someone else is typing.

The framing I want to establish early, because it determines the whole design: **a spreadsheet is not a document, it's a dependency graph with a UI.** Two consequences follow immediately. First, a cell edit is not a leaf write — it can trigger a cascade through thousands of dependent cells, so the write amplification is unbounded in a way a chat message never is. Second, the *structure* of the grid is itself mutable: inserting a row rewrites the meaning of every reference below it. That second point is where most designs quietly break, and it's where I'll spend my first deep dive.

## 🎯 Requirements Clarification

- **How many people edit one sheet at once?** Up to ~50 editors, but potentially thousands of *viewers* on a popular shared sheet. Those are very different fan-out problems.
- **Do formulas evaluate on the client or the server?** Server-authoritative. I'll defend that — it's the difference between everyone agreeing on a number and everyone having their own.
- **Do we support inserting/deleting rows and columns?** Yes. This is the question I most want answered up front, because the answer changes the concurrency model entirely.
- **How exact is undo?** Per-user undo that doesn't clobber a collaborator's work. That's a much stronger requirement than a global undo stack.

### Functional Requirements

- Real-time collaborative cell editing with live cursors and presence
- Formulas with dependency tracking, cascading recalculation, and cycle detection
- Structural operations: insert/delete rows and columns, resize
- Per-user undo/redo
- Sparse grids — 10,000+ rows and columns
- Cell formatting

### Non-Functional Requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Local edit feedback | < 100ms (optimistic) | Typing that lags is unusable |
| Edit persist + broadcast p99 | < 200ms | Collaborators must feel present |
| Concurrent editors per sheet | 50 | Fan-out is 49× per edit |
| Availability | 99.99% for the collab service | People are mid-sentence |
| Convergence | All clients reach the same state | Non-negotiable — divergence is silent corruption |
| Durability | No lost edits | An edit you saw applied must survive |

### Scale Estimates

The numbers that force the architecture:

- **100M spreadsheets, 10M DAU, ~2M concurrent editors** at peak.
- **~500K cell edits/second** at peak (2M editors × ~15 edits/min).
- Each edit naively costs **one cell UPSERT + one history row = 1M writes/second.** That is the number that kills the obvious design, and I'll come back to it.
- **~50B stored cells** at ~200 bytes each ≈ **10 TB** — and that's *with* sparse storage. Dense storage of a 10,000 × 100 grid would be 1M rows per sheet where ~1,000 are non-empty: a **1000× waste**, and 10 PB instead of 10 TB.
- Fan-out: 50 collaborators means each edit is broadcast 49 times. 500K edits/sec × 49 ≈ **24M messages/second** across the fleet.

## 🏗️ High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                 Clients (browser, one WS each)               │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│         WebSocket Gateways (stateless, ~50K conns each)      │
│         terminate connections; no sheet logic lives here     │
└───────────────────────────┬──────────────────────────────────┘
                            ▼  route by sheet_id
┌──────────────────────────────────────────────────────────────┐
│      Sheet Sequencer — ONE owner per active sheet             │
│  • assigns a monotonic seq number to every operation          │
│  • transforms cell edits against structural ops               │
│  • coalesces rapid edits to the same cell                     │
│  • holds the sheet's cells + dep graph in memory              │
└────────┬────────────────────────────────┬────────────────────┘
         │ append (synchronous, cheap)    │ recalc request
         ▼                                ▼
┌──────────────────────┐        ┌────────────────────────────┐
│  Durable op log      │        │  Formula Engine            │
│  (Kafka / Redis      │        │  • reverse dep index       │
│   Stream, per sheet) │        │  • topo sort of the        │
│  ── THE SOURCE OF    │        │    AFFECTED subgraph only  │
│     TRUTH ──         │        │  • cycle detection         │
└──────────┬───────────┘        └────────────┬───────────────┘
           │ async materialize               │
           ▼                                 ▼
┌──────────────────────┐        ┌────────────────────────────┐
│    PostgreSQL        │        │   Redis                    │
│  cells (sparse)      │        │  • pub/sub fan-out         │
│  sheets, history     │        │  • presence / cursors      │
│  ── A MATERIALIZED   │        │  • hot sheet cache         │
│     VIEW of the log  │        │  (all of it ephemeral)     │
└──────────────────────┘        └────────────────────────────┘
```

Two structural decisions carry the whole design:

1. **Each active sheet has exactly one sequencer** — a single writer that assigns a total order to operations. This is the thing that makes concurrent structural edits tractable, and I'll defend it below.
2. **The durable op log is the source of truth; PostgreSQL is a materialized view of it.** That inverts the usual relationship, and it's what makes 500K edits/second survivable.

## 💾 Data Model

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| spreadsheets | id, title, owner_id, created_at | (owner_id) | |
| sheets | id, spreadsheet_id, name, index | (spreadsheet_id) | Tabs |
| **cells** | sheet_id, row_index, col_index, **raw_value**, **computed_value**, format (JSONB) | **unique(sheet_id, row_index, col_index)** | Sparse — only non-empty cells exist. `raw_value` is `=SUM(A1:A10)`; `computed_value` is `42` |
| cell_deps | sheet_id, dependent (row,col), precedent (row,col) | (sheet_id, precedent) | The **reverse** index — "who depends on me" is the query that matters |
| op_log | sheet_id, **seq** (monotonic), user_id, op (JSONB), created_at | (sheet_id, seq) | Append-only. The real source of truth |
| edit_history | sheet_id, user_id, forward_op, inverse_op, seq | (sheet_id, user_id, seq DESC) | Per-user undo stacks |
| collaborators | spreadsheet_id, user_id, color, last_seen | unique(spreadsheet_id, user_id) | Presence; ephemeral, could live only in Redis |

Three things worth defending:

**Sparse storage is not an optimization, it's the only viable representation.** A dense grid stores every position: 10,000 rows × 100 cols = 1M rows per sheet, of which perhaps 1,000 are non-empty. That's 1000× waste, and at 100M sheets it's the difference between 10 TB and 10 PB. The cost is that "give me rows 100–200" becomes an index range scan instead of an offset calculation — which the composite index handles fine, because a range of rows in a sparse grid is a contiguous slice of that index.

**Storing both `raw_value` and `computed_value` is deliberate denormalization.** The computed value is derivable from the raw value plus the rest of the sheet — so storing it is redundant, and I store it anyway. Without it, opening a sheet with 100,000 formulas means evaluating 100,000 formulas before you can paint a single cell. With it, a read is a read. The cost is that they can drift if a recalculation is lost, which is why recalculation is part of the same durable operation as the edit, not a side effect of it.

**The dependency index is stored *reversed*.** The question we ask on every edit is never "what does A1 depend on" — it's "**who depends on A1**," because that's who needs recalculating. Indexing by `precedent` makes the hot query an index lookup instead of a scan.

## 🔌 API Design

```
POST   /api/spreadsheets                  Create
GET    /api/spreadsheets/:id              Metadata + sheet list
GET    /api/sheets/:id/cells              Load cells (paged by row range)
PATCH  /api/sheets/:id/cells              Batch update (non-realtime clients, import)

WSS    /ws?sheet_id=…
  → client sends: CELL_EDIT, INSERT_ROW, DELETE_COL, CURSOR_MOVE, SELECTION
  → server sends: OP_APPLIED (with seq), CELLS_RECALCULATED, PRESENCE, SYNC
```

The WebSocket protocol is where the real API lives. REST exists for load and for clients that aren't in the collaborative session.

**The protocol semantics matter more than the endpoint list.** Every client-to-server message carries the client's `last_seen_seq`; every server-to-client `OP_APPLIED` carries the authoritative `seq` the sequencer assigned. That pairing is the entire concurrency contract:

| Message | Direction | Semantics |
|---------|-----------|-----------|
| `CELL_EDIT` | C→S | Op id + coordinate + raw value + last-seen seq. Sequencer orders it, transforms coordinates if it was written against an older seq, applies, appends to log |
| `INSERT_ROW` / `DELETE_COL` | C→S | Structural op — becomes the thing later cell edits are transformed *against*. Rewrites references on the same total order |
| `OP_APPLIED` | S→C | The assigned seq + final coordinate. Doubles as the ack; the client advances its last-seen seq |
| `CELLS_RECALCULATED` | S→C | A batch of `(coord, computed_value)` from the affected-subgraph recalc, sent after the triggering edit |
| `CURSOR_MOVE` / `SELECTION` | C↔S | Conflated and throttled (~10/sec); newest supersedes, drops are fine |
| `SYNC` | S→C | Full or since-seq state, sent on join and on reconnect-too-far-behind |

The design rule: the client is never the authority on order. It proposes; the sequencer disposes and echoes back the truth via `OP_APPLIED`. A client that sends an edit and sees its own `OP_APPLIED` come back with a *transformed* coordinate learns, correctly, that the grid shifted under it.

## 🔧 Deep Dive 1: Conflict Resolution — Where Last-Write-Wins Is Right, and Where It Silently Corrupts

**The easy half, and I'll defend it.** For two users setting *the same cell to different values*, **last-write-wins is correct**, and reaching for OT or CRDTs here is over-engineering.

The reason is semantic, not technical: OT exists to merge *character-level* edits, where "Alice typed 'x' at position 3" and "Bob typed 'y' at position 7" have a meaningful merge. A cell value has no such structure. If Alice sets A1 to `100` and Bob sets it to `200`, there is no merged value — `150` is not a compromise, it's a bug. One of them has to win, and the only question is which. LWW answers that with zero coordination overhead, and because both users see the converged value within one round-trip (~50ms), they *notice* and coordinate socially — which is what actually happens in real spreadsheets.

**Now the hard half, which most designs miss entirely: structural operations.**

Alice inserts a row at index 5. Simultaneously, Bob — whose client hasn't seen that yet — edits cell A7.

- On Bob's screen, A7 holds the number he's changing.
- After Alice's insert, everything from row 5 down shifts by one. What *was* A7 is now A8.
- Bob's edit arrives at the server addressed to **A7**. Applied naively, it lands on the wrong cell — a cell that used to be A6.

**LWW cannot help here, because this is not a conflict — both operations are individually valid and both should be applied.** The problem is that Bob's operation was written against a *coordinate system that no longer exists*. Naive LWW doesn't detect a conflict; it silently writes the right value into the wrong cell. That is data corruption with no error message, and the user finds it three weeks later in a financial model.

And formulas make it worse: every formula referencing `A7:A10` must have its references rewritten. A cell edit is local; a row insert is a **global rewrite of the sheet's address space.**

**The fix: a single sequencer per sheet, plus operational transformation on coordinates only.**

1. Every active sheet is owned by exactly **one** sequencer process. Every operation for that sheet flows through it and receives a **monotonic sequence number**. This gives a total order, which is the precondition for any of the rest to work.
2. Every client tags each operation with the **last seq it has seen**.
3. When an operation arrives that was written against an older seq, the sequencer **transforms its coordinates** against the structural operations that happened in between. Bob's edit to A7, submitted at seq 40 when the insert committed at seq 41, is rewritten to A8 before being applied.
4. Formula references are rewritten by the same transform, on the same total order.

> "This is operational transformation — but applied to *coordinates*, not to characters, and only against *structural* ops. That's a dramatically smaller problem than Google Docs solves. The transform function has to handle maybe six operation types against four structural ops. I'm not building general OT; I'm building the minimum amount of it that stops silent corruption, and I'm keeping LWW for the case where LWW is genuinely correct. The trap is picking one model for the whole system: pure LWW corrupts on structural ops, and full CRDT/OT for cell values is a large amount of machinery to solve a problem — merging `100` and `200` — that has no solution."

**What the single sequencer costs me.** It's a single point of failure per sheet and a vertical scaling ceiling per sheet. I accept both, for a specific reason: **a sheet has at most ~50 concurrent editors**, so one process is never remotely near its capacity. The sequencer is not a throughput bottleneck; it's a *correctness* device. Failover is a lease in Redis with a heartbeat — a new sequencer picks up the sheet, replays the op log from the last checkpoint, and rebuilds in-memory state. Because the log is the source of truth, that replay is exact.

This is also why sheets shard beautifully: sheets are completely independent, so sequencers spread across the fleet by `sheet_id` with zero cross-shard coordination.

## 🔧 Deep Dive 2: Recalculation — The Cascade Is the Real Workload

A cell edit is not one write. It's one write plus however many cells depend on it, transitively.

**How the naive approaches break:**

| Approach | The specific bottleneck |
|----------|-------------------------|
| ❌ Recompute the whole sheet on every edit | A sheet with 100K formulas recomputes 100K formulas on every keystroke. At 500K edits/sec this is not a performance problem, it's arithmetic that doesn't fit on the planet |
| ❌ Recompute lazily, on read | Reads vastly outnumber writes (viewers!), and a read now costs a full evaluation. You've moved the cost to the more frequent operation — exactly backwards |
| ❌ No dependency tracking; just re-evaluate cells that "look related" | There is no such thing as "looks related." `=SUM(A:A)` depends on an entire column |
| ✅ Reverse dependency index + topological sort of the **affected subgraph only** | See below |

**The design:**

1. When a formula is written, parse it and extract its precedents. Store the edges **reversed**: `precedent → dependents`.
2. On an edit to A1, look up A1's dependents. Walk transitively to build the **affected subgraph** — usually a handful of cells, occasionally thousands.
3. **Topologically sort just that subgraph** and evaluate in order, so each cell is computed after everything it depends on. A cell is evaluated exactly once no matter how many paths reach it.
4. Broadcast the changed `computed_value`s to collaborators as one batch.

Cost is O(affected), not O(sheet). For the overwhelming majority of edits, "affected" is zero — you typed a number into a cell nobody references, and the recalculation is a no-op.

**Cycle detection** falls out of the topological sort: if the affected subgraph can't be ordered, there's a cycle, and the cells in it get an error value rather than an infinite loop. This has to be detected at *write* time, not evaluation time, so the user learns immediately.

**Two failure modes worth naming:**

**The cascade bomb.** Someone writes a formula that 10,000 cells depend on, and then types into it repeatedly. Each keystroke triggers a 10,000-cell recalculation. The fix is **debounce and coalesce**: aggregate edits over a ~100ms window, then recalculate once against the final state. The user typing "12345" produces five edits to one cell; only the last one's cascade matters, and computing the first four is pure waste. This is the same coalescing that saves the write path — one mechanism, two payoffs.

**Volatile functions.** `NOW()`, `RAND()`, and `TODAY()` depend on *nothing* and change *anyway*, which means they have no precedents and therefore never appear in any affected subgraph. They break the whole model. The honest answer is that they need a separate periodic recalculation pass, and that they are precisely why a purely dependency-driven engine isn't sufficient. I'd rather name that than pretend the dependency graph is complete.

**Why server-side evaluation, not client-side?** Client-side evaluation is tempting — it's free compute and it's instant. It fails on two counts. First, **50 collaborators evaluating independently can disagree** — different browsers, different float behavior, different versions of the function library — and a spreadsheet where two people see different totals is worse than one that's slow. Second, a **viewer** with a read-only link would have to evaluate 100K formulas just to look at a sheet. The server evaluates once; everyone reads the same answer. The client still evaluates optimistically for instant local feedback, but the server's value is authoritative and overwrites it. Optimism for feel; authority for truth.

## 🔧 Deep Dive 3: Surviving 500K Edits/Second by Inverting the Storage Model

Here is the number that breaks the obvious design: **500K cell edits/second, each producing an UPSERT and a history row = 1M writes/second to PostgreSQL.** A well-tuned Postgres primary does tens of thousands of writes per second. We are off by roughly two orders of magnitude.

**Why the usual fixes don't get there.** Sharding by `sheet_id` helps — spread across 100 shards and it's 10K writes/sec each, which is survivable. But we've now got 100 database primaries doing nothing but absorbing keystrokes, and we still write a row for *every intermediate state* of a cell someone is typing into.

**The inversion: make the log the truth and the database a materialized view.**

1. **The sequencer appends every operation to a durable, per-sheet log** (Kafka partitioned by sheet, or a Redis Stream). This is a **sequential append** — the cheapest write a computer can do — and it's what makes the operation durable. Once it's in the log, the edit cannot be lost.
2. **The edit is broadcast to collaborators immediately from the sequencer**, straight after the append. Broadcast latency never waits on PostgreSQL.
3. **A materializer consumes the log asynchronously** and writes to PostgreSQL in batches, **coalescing by cell**. A user typing "12345" into A1 emits five operations; the materializer writes **one** row.

**What coalescing actually buys.** Bursty human typing means most cells are written several times in quick succession. Coalescing over a 1-second window typically collapses 5–10 operations per cell into one write — an order of magnitude off the top. Combine that with batching (one multi-row statement instead of N statements) and sharding by sheet, and the write volume lands in territory PostgreSQL is comfortable in.

> "The trade I'm making is a window of *materialization lag* — PostgreSQL is behind the log by up to a second. That sounds alarming for a system holding people's financial models, so let me be precise about what it does and doesn't cost. It does **not** risk losing an edit: the log append is synchronous and durable, so an edit the user saw acknowledged is safe the moment it's in the log. What it costs is that a *cold read* — someone opening the sheet from a different server right now — could miss the last second of edits. The fix is that a cold read replays the log tail past the last materialized checkpoint. So the guarantee is: **durability comes from the log, and freshness comes from replaying it.** Postgres is an optimization for fast loads, not the record of truth. Treating it as the truth is what forces you into 1M writes/second."

**What I give up.** Operational complexity, honestly. There are now two stores that must agree, a materializer that can fall behind (and must be monitored — its lag *is* the freshness bound), and a replay path that has to be exercised or it will be broken when you need it. That's a real cost. I'd take it, because the alternative isn't "simpler" — it's "doesn't work at this scale," and a simple design that doesn't work is not simple.

**Fan-out**, meanwhile, is the easy half: 24M messages/second sounds huge, but it's 50 recipients per edit and it parallelizes perfectly. Redis Pub/Sub distributes an op to whichever gateways hold that sheet's connections. Presence and cursor moves — which are high-frequency and completely disposable — are **conflated**: a cursor's newest position supersedes the old one, so we throttle them to ~10/sec per user and drop the rest. Cell edits are never conflated in transit, because each one is a fact.

## 🧭 Consistency Model

| Data | Guarantee | Why |
|------|-----------|-----|
| Op log | Durable, totally ordered per sheet | The source of truth. Everything else derives from it |
| Cell values across clients | **Convergent** — all clients reach the same state | Achieved by the single sequencer's total order, not by hoping |
| Cell edits (same cell, concurrent) | Last-write-wins by seq number | There's no meaningful merge of `100` and `200` |
| Structural ops vs. cell edits | Transformed against the total order | LWW here would silently write the right value into the wrong cell |
| Computed values | Eventual, ~100ms behind the edit (debounce window) | A formula result lagging a tenth of a second is invisible |
| PostgreSQL | Eventual, ≤ ~1s behind the log | It's a materialized view; freshness comes from log replay |
| Presence / cursors | Best-effort, conflated, lossy | A stale cursor for 100ms harms nobody |

Cell edits are **idempotent by construction** — an UPSERT keyed on `(sheet_id, row, col)` applied twice produces the same state — which means a replayed log is safe, and that's what makes the whole log-as-truth model work.

## 🔁 Undo That Doesn't Clobber Collaborators

Undo is deceptively hard in a collaborative system, and the naive design is actively harmful.

**The naive design:** a global undo stack. Alice hits Ctrl-Z and it undoes *Bob's* last edit. This is a genuinely awful experience and it's what you get for free if you store one stack per sheet.

**What's needed is per-user undo:** each user's history is their own operations, and undoing one applies its **inverse**. So every operation is stored with both a forward op and an inverse op (`set A1 to "new"` / `set A1 to "old"`), and Alice's undo emits the inverse of *her* last operation as a **new operation** appended to the log.

That last point is what makes it correct: **undo is not a rewind, it's a new forward operation.** It gets a sequence number, it gets broadcast, it gets transformed against structural ops just like any other edit. Trying to actually rewind the log — removing an operation from history — would mean re-deriving every subsequent operation, which is unsolvable when those operations were other people's.

**The honest wrinkle:** if Bob has since overwritten the cell Alice is undoing, Alice's undo will overwrite Bob. There is no universally right answer here; real spreadsheets accept this. What matters is that the *behavior is defined* and the operation goes through the same ordered pipeline as everything else, rather than being a special path that bypasses the sequencer.

## 🔒 Authorization, Sharing, and Formula Injection

Authorization in a spreadsheet is deceptively load-bearing, because the mutating path is the WebSocket, not REST — so an auth model that only guards HTTP endpoints protects nothing.

**The sharing model.** A spreadsheet has an owner and a `collaborators` table mapping `user_id → role`, where role is one of **owner / editor / commenter / viewer**. Access is checked at two points: once when a client opens the WebSocket (reject the connection outright if the user has no role on the sheet), and again — this is the part people miss — **on the sequencer's hot path for every mutating operation**. The sequencer is already the single point every op flows through, which makes it the natural and only correct place to enforce "can this user edit at all," and later "can this user edit *this range*."

> "The trap is doing the authorization check as a database round-trip per keystroke — that would put a 2ms Postgres read in front of the one process that serializes the entire sheet, and turn the correctness device into a latency bottleneck. Instead the sequencer holds the sheet's ACL in memory alongside its cell and dependency state, refreshed only when a share actually changes. Auth becomes a hash lookup on the hot path, not an I/O. The cost is that a revoked collaborator can linger for the refresh window — acceptable, because the blast radius is one sheet and the fix is a targeted cache bust on the share-change event."

**Protected ranges** are the same idea one level finer: instead of a sheet-level yes/no, the sequencer consults a per-range rule before applying a coordinate. It's deferred in this design, but it lives in exactly one place — which is the whole point of routing every op through a single owner.

**Formula injection is a real attack surface, not a footnote.** `raw_value` is untrusted user input that the server *evaluates*. Any implementation that reaches for language `eval()` on that string (the kind of shortcut a demo takes for `=5+3*2`) is a remote-code-execution hole. The production formula engine must be a **sandboxed evaluator over a whitelist of functions** — it parses to an AST it controls, never executes arbitrary host code, bounds recursion/iteration to stop a `=SUM` over a giant range from becoming a DoS, and treats cross-sheet references as authorization checks (a `VLOOKUP` into a sheet you can't read must not leak its values). Server-authoritative evaluation is what makes this enforceable at all: there's one trusted evaluator, not fifty browsers.

**Idempotency pairs with the log.** Every `CELL_EDIT` carries a client-generated op id. On reconnect a client replays its unacknowledged ops; the sequencer dedupes by op id so a replayed edit produces exactly one log entry. That client-id dedup stops duplicate *log entries*; the UPSERT keyed on `(sheet_id, row, col)` stops duplicate *state*. Two layers, two different failure modes — a network retry can neither double-append nor double-apply.

## 🚀 The Read Path: Opening a 100,000-Cell Sheet Fast

The write path gets all the attention, but the read path has its own trap: a popular sheet is opened far more often than it's edited, and a cold open must paint fast.

| Concern | How it's handled |
|---------|------------------|
| Don't evaluate on open | `computed_value` is denormalized alongside `raw_value`, so opening a sheet with 100K formulas is 100K reads, not 100K evaluations. This is why the denormalization earns its keep despite the drift risk |
| Don't ship the whole grid | Cells load **paged by row range** (`GET /api/sheets/:id/cells?rows=1-200`), and because storage is sparse, a row range is a contiguous slice of the `(sheet_id, row, col)` index — an index range scan, not a full-sheet fetch |
| Don't hit Postgres for hot sheets | Active sheets are cached in Redis; the sequencer already holds the authoritative state in memory, so a warm open can be served without touching the database at all |
| Don't serve stale after a cold open | Postgres lags the log by up to ~1s, so a cold read replays the **log tail** past the last materialized checkpoint before handing the client a `SYNC` — durability from the log, freshness from replaying it |

> "The read path is where the storage inversion pays a second dividend. Because the sequencer holds live state and the log holds truth, the database is free to be *only* a fast-load cache for inactive sheets — it never has to be current, only close. That's what lets a viewer-heavy sheet scale: a read-only viewer doesn't join the collaborative session at all, it gets a CDN-cached snapshot of `computed_value`s plus a low-frequency update channel, and never consumes a sequencer slot meant for the ~50 people actually editing."

## 🛠️ Failure Handling

| Failure | Behavior |
|---------|----------|
| **Sequencer for a sheet dies** | Lease expires; a peer acquires it, replays the op log from the last checkpoint, rebuilds cells + dep graph in memory. Clients see a brief pause, then a `SYNC`. Because the log is the truth, the rebuild is exact — no guessing |
| **Redis Pub/Sub down** | Fan-out degrades to single-gateway; collaborators on *other* gateways stop seeing updates. Circuit-break and surface it — a collaborative editor that silently stops being collaborative is the worst possible failure, because users keep typing |
| **PostgreSQL down** | Editing **continues** — the log is the truth and broadcast doesn't depend on Postgres. Cold loads of inactive sheets fail. This is exactly the resilience the inverted storage model buys |
| **Op log unavailable** | **Reject edits.** This is the one place we fail closed: without a durable append we cannot promise the edit survives, and acknowledging an edit we might lose is worse than refusing it |
| **Client disconnects** | Reconnect with its last-seen seq; the server sends operations since then, or a full state sync if it's too far behind |
| **Formula engine overloaded** | Recalculation queues and lags; raw values still save and broadcast. Cells show a "calculating" state — degraded and honest |

The rule: **the log is sacred; everything else degrades.**

## 📊 Observability

| Signal | What it tells me |
|--------|------------------|
| Sequencer op-processing latency, p99 | The core SLO. It's the serialization point, so it's where queuing shows up first |
| **Materializer lag** | Directly bounds how stale PostgreSQL is — which is to say, it *is* the freshness guarantee. If it grows without bound, cold loads are silently wrong |
| Recalculation cascade size, p99 | Detects the cascade bomb before a user does. A p99 of 10,000 affected cells means someone built a spreadsheet that will melt |
| Convergence check | Periodically hash each client's visible state and compare. **Divergence is silent** — it produces no errors, no exceptions, just two people looking at different numbers. It is the single most dangerous failure in this system and the only way to catch it is to look for it |
| WebSocket connections per gateway | Rebalancing signal |
| Op log append latency | If this degrades, we start rejecting edits — it's the one hard dependency |

## 📐 Capacity Planning (Back-of-Envelope)

Turning the scale numbers into a fleet, because "it scales" means nothing without the arithmetic:

- **WebSocket gateways:** 2M concurrent editors ÷ ~50K connections per gateway ≈ **40 gateways**, call it ~60 with headroom. Viewers don't hold sequencer state and are served from CDN snapshots, so they don't size the editing fleet — which is the whole reason to keep them off it.
- **Sequencers:** one owner per *active* sheet, but each sheet is tiny (≤50 editors), so one process comfortably owns thousands of them. The binding constraint is **memory** — each sequencer holds its sheets' cells + dependency graphs in RAM — not CPU. Packed by `sheet_id`, this is low hundreds of processes, and it scales by adding processes and rebalancing sheet ownership.
- **Op log:** partitioned by `sheet_id`. 500K edits/sec across ~200 partitions ≈ 2.5K appends/sec/partition — trivial for Kafka. Partition count is chosen for **materializer parallelism**, not for append throughput, which sequential appends make a non-issue.
- **Materializers and Postgres:** coalescing collapses ~5–10 ops/cell into one write, turning the naive ~1M writes/sec into ~100–200K coalesced writes/sec spread across sharded Postgres — tens of shards, each in comfortable range-scan territory.

> "The single ratio that sizes the whole system is **materializer throughput vs. log ingest rate.** If materializers keep up, Postgres lags the log by well under a second and cold reads are fast. If they fall behind, lag grows without bound, cold reads replay more and more log tail, and the failure is *silent* — nothing errors, opens just get slower. That ratio, not CPU or connection count, is the capacity SLO I'd alert on first."

## 📈 Scalability: What Breaks First

1. **PostgreSQL write volume** — first, and by a wide margin. The log-as-truth inversion plus coalescing plus sharding by `sheet_id` is the answer, and it's the single most important thing in this design.
2. **WebSocket connections** — ~50K per gateway before event-loop latency eats the 200ms budget. Horizontal gateways, routed by sheet so that a sheet's collaborators tend to land together and much of the fan-out becomes local rather than crossing Redis.
3. **Recalculation cascades** — a pathological sheet (one cell feeding 10,000 formulas) can saturate a formula worker. Debounce, batch, and move heavy evaluation to a worker pool so it never blocks the sequencer's event loop. The sequencer must stay responsive: it's a serialization point, and anything that blocks it blocks everyone on that sheet.
4. **Op log / history growth** — every edit is a row, forever. Checkpoint periodically (snapshot the sheet state, truncate the log before it), and prune per-user history after 30 days. Without checkpoints, sequencer failover replay time grows without bound, and the recovery path degrades silently until the day you need it.
5. **The one-thousand-viewer sheet** — a popular public template has few editors and enormous read fan-out. That's a completely different problem, and it gets a different answer: viewers don't need a sequencer, they need a **CDN-cached snapshot** plus a low-frequency update channel. Serving a read-only viewer through the collaborative editing path is a waste of an expensive resource.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Cell conflict | ✅ Last-write-wins | ❌ OT / CRDT on values | There's no meaningful merge of `100` and `200` |
| **Structural ops** | ✅ Single sequencer + coordinate transform | ❌ LWW | LWW silently writes the right value into the *wrong cell* — corruption with no error |
| Ordering | ✅ One sequencer per sheet | ❌ Multi-writer with vector clocks | 50 editors never saturate one process; the sequencer buys correctness, not throughput |
| Source of truth | ✅ Durable op log | ❌ PostgreSQL | 1M writes/sec doesn't fit; a sequential append does |
| Persistence | ✅ Async materialize + coalesce | ❌ Synchronous write per edit | Typing "12345" should be one row, not five |
| Storage | ✅ Sparse cells | ❌ Dense grid | 1000× waste; 10 TB vs 10 PB |
| Formula eval | ✅ Server-authoritative (client optimistic) | ❌ Client-side | 50 clients computing independently can disagree; viewers shouldn't have to compute |
| Recalculation | ✅ Reverse dep index + topo sort of the affected subgraph | ❌ Full-sheet recompute | O(affected), not O(sheet) — and usually affected is zero |
| Cursors/presence | ✅ Conflated, throttled, lossy | ❌ Reliable delivery | Newest cursor supersedes; nobody needs the old one |
| Undo | ✅ Per-user, inverse ops appended as new ops | ❌ Global stack / log rewind | Undoing your colleague's work is unforgivable; rewinding a shared log is unsolvable |
| Edit log unavailable | ✅ Fail closed (reject edits) | ❌ Accept and hope | Acknowledging an edit we might lose is worse than refusing it |

## 🚀 Closing: What I'd Build Next

The most interesting unbuilt thing is **offline editing**, and it's interesting because it breaks my central assumption. Everything here rests on a single sequencer assigning a total order — which requires the client to be *online* to get one. A client that edits offline for an hour and reconnects has a batch of operations written against an ancient coordinate system, and transforming them all against an hour of other people's structural changes is exactly the case where OT gets genuinely hard and where a CRDT starts to look like the right tool after all. I'd want to be honest that the design I've described is a *connected* design, and that offline is not a feature you bolt on — it's a different concurrency model.

Beyond that: **cell-level permissions and protected ranges** (which turn every operation into an authorization check on the sequencer's hot path), **import/export** at scale (a 500MB CSV is a very different write pattern than a keystroke and shouldn't go anywhere near the sequencer), and **a real formula language** — the moment you support `VLOOKUP` across sheets, the dependency graph stops being per-sheet and the clean sharding boundary I've been relying on all answer quietly disappears. That last one is the kind of thing that looks like a feature request and is actually an architecture change.
