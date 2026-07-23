# Design Jira - System Design Answer (Frontend Focus)

*45–60 minute system design interview — Frontend Engineer position*

## 📋 Problem Statement

"I'm designing the Jira web client: a Kanban board, a backlog, an issue list driven by a query language, and an issue detail view. The interesting part isn't drawing cards in columns — it's that **the client is not the authority on what it's allowed to do**. Whether an issue may move from 'In Review' to 'Done' is decided by a per-project workflow the admin configured, evaluated server-side. So the UI has to feel instant while being wrong-capable: I optimistically apply a change the server may legitimately reject on business-rule grounds, not just because the network failed.

That single tension drives most of my decisions today."

## 🎯 Requirements Clarification

Before designing, I'd want to pin down what "board" means at scale and how live it has to be.

### Functional Requirements

1. **Board** — columns derived from the project's workflow statuses; drag a card between columns to trigger a transition
2. **Backlog** — sprint groupings plus an unscheduled pool; move issues between them
3. **Issue list** — filterable by JQL, with the query box offering completion
4. **Issue detail** — slide-over panel with inline-editable fields, comments, and an audit history
5. **Issue creation** — modal whose fields depend on issue type and project configuration

### Non-Functional Requirements

| Requirement | Target | Why this number |
|-------------|--------|-----------------|
| Interaction feedback | < 100ms | Below the threshold where a drag feels "attached" to the cursor |
| Board load (p95) | < 1.5s | Board is the landing page for most sessions |
| Board size | 500+ cards in a sprint without jank | Large teams run fat sprints; degrading here is very visible |
| Accessibility | WCAG 2.1 AA, full keyboard parity | Drag-and-drop must have a non-pointer equivalent |
| Correctness | Never show a state the server rejected | A card that silently snaps back destroys trust |

### Questions I'd Ask

> "Three things change the design materially. First — do teammates need to see each other's changes live, or is refresh-on-focus acceptable? That's the difference between a WebSocket layer and polling. Second — how configurable are workflows? If any project can define arbitrary statuses, I can't hardcode column layouts or transition rules anywhere in the client. Third — what's the realistic upper bound on cards in one board? 50 and 5,000 are different rendering architectures."

For this design I'll assume: **near-real-time is nice-to-have, not required**; **workflows are fully admin-configurable**; **boards top out in the low thousands**.

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                            Route Layer                                │
│   /projects · /projects/:key/{board,backlog,issues,settings}         │
│   Nested layout route resolves :key ──▶ project + workflow           │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ project & workflow guaranteed loaded
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          View Components                              │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│   │   Board    │  │  Backlog   │  │ Issue List │  │ Detail Panel │  │
│   └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └──────┬───────┘  │
└─────────┼───────────────┼───────────────┼────────────────┼──────────┘
          │               │               │                │
          └───────────────┴───────┬───────┴────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        Client State (stores)                          │
│   issues (by id) · project + workflow · UI/session                    │
│   One issue record, many views ──▶ no cross-view reconciliation       │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          API Client Layer                             │
│   REST + idempotency keys on mutations · normalizes errors to a       │
│   discriminated shape the UI can branch on (403 / 422 / 409 / 5xx)    │
└──────────────────────────────────────────────────────────────────────┘
```

**The route layer carries real weight.** The project layout route resolves the `:projectKey` URL segment into a loaded project *and its workflow* before any child view renders. Every child then treats "project and workflow exist" as an invariant instead of defensively null-checking.

That guard is also the single easiest place in this app to introduce a bug, so it's worth stating precisely how it must behave:

> "The redirect condition has to be 'the fetch completed and found nothing' — never 'we don't have a project yet'. Those look equivalent and aren't. Client state starts empty, and effects run after the first paint, so a 'no project yet' test is true on mount for *every* deep link. The result is that every bookmarked board URL bounces the user to the project list before its own fetch even starts, and it fails in the most confusing possible way: navigating from inside the app appears to work, because the data happens to already be in the store. Loading and absent are different states and the guard must distinguish them."

### Component Responsibilities

I split components along the axis of *what owns a decision*, not by visual nesting:

| Component | Owns | Explicitly does not own |
|-----------|------|-------------------------|
| Project layout route | Resolving `:projectKey` → project + workflow; loading/absent states | Anything about issues |
| Board | Grouping issues into columns; drag orchestration | Whether a transition is legal |
| Column | Drop-target affordance; its own card window | Issue mutation |
| Card | Presentation + drag source + keyboard action menu | Fetching anything |
| Detail panel | Per-field edit lifecycle; tab loading | Board layout |
| API client | Idempotency keys, error normalization, retry policy | UI decisions about errors |

> "The rule I'm applying is that a component may render a decision but shouldn't make one it lacks the context for. Cards don't fetch, because a card can't know whether its data is already in flight for the board. The board doesn't decide transition legality, because that lives server-side. Pushing those upward keeps the leaf components pure and, more practically, means a card can be rendered in the board, the backlog, or a search result without dragging a data dependency along with it."

## 💾 Client State Model

I keep **one canonical record per issue**, keyed by id, and let each view derive what it needs:

| View | Derivation | Recomputed when |
|------|-----------|-----------------|
| Board column | Group issues by `status_id`, filtered to the selected sprint | Any issue's status or sprint changes |
| Backlog | Group by sprint, with an unscheduled bucket | Sprint assignment changes |
| Issue list | Filter/sort the flat collection | Query or sort changes |
| Detail panel | Look up one issue by id | That issue changes |

> "The alternative — each view owning a private copy of its slice — is the classic source of 'I changed the assignee in the detail panel and the card behind it still shows the old avatar'. With copies, you need an explicit sync step on every mutation, and every new view adds another sync path you can forget. Deriving views from one record makes that class of bug unrepresentable. The cost is that a change to a single issue invalidates any memo covering the whole collection, so I memoize the grouping per column rather than for the board as a whole, and give cards stable identity so React reconciles only the card that actually changed."

I deliberately **do not cache issues across projects**. Switching projects discards the collection. Holding several projects' issues would mean tracking which are stale, and the fetch is cheap — a board is hundreds of rows, not hundreds of thousands.

## 🔧 Deep Dive 1: Optimistic Drag-and-Drop Against a Server-Authoritative Workflow

This is the hardest interaction in the product, because the client genuinely does not know whether a drop is legal.

A transition can be rejected for reasons that live entirely on the server: a **condition** (this user isn't the assignee, so they may not move it), or a **validator** (resolving requires a fix version this issue lacks). Neither is knowable from the card alone.

### The three options

| Approach | Feel | Correctness | Verdict |
|----------|------|-------------|---------|
| ❌ Wait for the server before moving the card | 200–400ms of the card stuck under the cursor | Always right | Fails the core interaction |
| ❌ Move optimistically, ignore failures | Instant | Silently diverges from the server | Unacceptable |
| ✅ Move optimistically, reconcile on response | Instant | Converges, with a visible correction | Chosen |

> "I move the card the instant the drop fires, then reconcile. The reason waiting loses isn't that 300ms is objectively long — it's that a board is a *bulk* tool. Sprint planning means twenty drags in a row, and a serialized 300ms confirmation turns a thirty-second triage into a stuttering two-minute one. The reason 'ignore failures' loses is subtler and worse: because rejections here are business rules rather than flaky networks, they're *reproducible*. A user without permission to close issues would drag to Done and see it work, every time, and only discover on reload that nothing they did stuck. Optimism plus reconciliation is the only option that keeps the interaction fast and the state honest."

### Making rejection legible

Rolling back isn't enough — a card that silently slides home reads as a bug. I distinguish the failure classes, because each deserves a different response:

```
   drop
     │
     ▼
 apply move locally ──▶ POST transition
     │                        │
     │        ┌───────────────┼───────────────┬──────────────┐
     │        ▼               ▼               ▼              ▼
     │      2xx            403 cond.      422 valid.    network/5xx
     │        │               │               │              │
     │        ▼               ▼               ▼              ▼
     │    confirm       revert + explain  revert + open   keep move,
     │    (no-op,       "only the         the field the   retry once,
     │     already      assignee can      validator       then revert
     │     applied)     move this"        demands
     ▼
 reconcile from response
```

- **403 (condition failed)** — revert and explain *who* may do it. The user cannot fix this by retrying.
- **422 (validator failed)** — revert, but immediately surface the field that's missing. The transition is legal; the issue just isn't ready. Making the user hunt for it is the difference between a two-second fix and a support ticket.
- **Network/5xx** — the only genuinely transient case, and the only one worth retrying automatically. I retry once with the same idempotency key so a response lost in flight can't double-apply.

**Why the reconciliation is a merge, not a refetch.** The transition response returns the updated issue, and I apply that rather than re-requesting the board. A refetch would be simpler, but it would clobber concurrent edits — the user may have already dragged a second card while the first was in flight, and a whole-board replacement would stomp it.

**Suppressing stale responses.** With rapid drags, two transitions on the *same* issue can be in flight simultaneously and resolve out of order. I keep a per-issue sequence number and drop any response older than the newest one applied, so a slow first response can't overwrite a fast second one.

### The accessibility obligation

Drag-and-drop is a pointer gesture with no keyboard equivalent by default, and it's the *primary* action of this screen.

> "I treat the drag as a shortcut for something else, not as the mechanism itself. The underlying operation is 'apply transition X to issue Y', which is exposed on every card as a keyboard-reachable status control listing the transitions the server says are available. The drag calls the same code path. That ordering matters: if you build the drag first and bolt on keyboard support later, the two paths drift and the keyboard one quietly rots. Building the explicit control first means the drag is a progressive enhancement over an interface that already works — and it also gives me the honest answer for touch, where drag-and-drop between horizontally scrolling columns is miserable regardless of implementation."

I announce results in a live region — a silent rollback is invisible to a screen reader user, which turns a mild annoyance into a total loss of feedback.

## 🔧 Deep Dive 2: Rendering a Large Board Without Breaking the Drag

A 500-card sprint is where the naive board falls over. The standard fix is virtualization — render only what's visible. But **virtualization and drag-and-drop actively fight each other**, and that conflict is the actual design problem.

### Why the obvious fix doesn't compose

```
┌──────────────────────────────────────────────────────────┐
│  Column: In Progress (180 cards)                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  rendered window (≈12 cards)                        │  │
│  │  ────────────────────────────────────────────────   │  │
│  │  │ card 44 │ card 45 │ ... │ card 55 │              │  │
│  └────────────────────────────────────────────────────┘  │
│     ▲ cards 1–43 and 56–180 are NOT in the DOM           │
│                                                           │
│  Dragging toward an unrendered target:                    │
│    · no element to compute a drop position against        │
│    · the auto-scroll that would reveal it is itself       │
│      driven by the drag we're trying to resolve           │
└──────────────────────────────────────────────────────────┘
```

Dragging a card to position 140 of a virtualized column means dragging toward something that doesn't exist in the DOM. You end up reimplementing hit-testing against a virtual coordinate space, and drag auto-scroll becomes circular.

### What I do instead

| Approach | Pros | Cons |
|----------|------|------|
| ❌ Virtualize every column | Constant DOM size | Breaks drop targeting; complex scroll coupling |
| ❌ Render everything | Drag "just works" | 500+ cards × rich content = slow scroll, heavy re-renders |
| ✅ Cap the column, page the remainder | Drag works on what's draggable; DOM stays bounded | The tail needs a different affordance |

> "I cap each column at roughly 50 rendered cards with a 'show N more' control, rather than virtualizing. The justification is behavioural, not technical: nobody drags a card to position 140 by hand. Past a screen or two, users filter, or they use the backlog view, which is a flat list built for bulk moves — and *that* I do virtualize, because it has no horizontal drop targets to hit-test against. So the board optimizes for the interaction it's actually for, and the bulk view optimizes for volume. Uniform virtualization everywhere would be architecturally tidier and worse to use.
>
> What I'm giving up is honest: a column with 400 cards can't be reordered end-to-end by dragging. I think that's correct — a board in that state is telling you the sprint is mis-scoped, and the answer is a filter, not a longer scroll."

Two supporting decisions:

- **Cards are memoized on identity**, so moving one card re-renders one card plus two columns, not the board. Without this, optimistic updates get quadratically worse exactly when the board is busiest.
- **Drag feedback is transform-only** (translate/scale/opacity) so it stays on the compositor. Animating layout properties during a drag is what makes boards feel like they're chewing gum.

## 🔧 Deep Dive 3: Inline Editing and Concurrent Edits

The detail panel edits fields in place. Two questions decide the design: when to commit, and what to do when someone else got there first.

### When to commit

| Approach | Pros | Cons |
|----------|------|------|
| ❌ Save on every keystroke | Never lose work | A write per character; every intermediate string hits the audit history |
| ❌ Explicit Save button for everything | Predictable | Heavy for changing a dropdown; users forget and lose edits |
| ✅ Commit on blur/Enter for text, immediately for discrete fields | Matches intent | Escape must reliably discard |

> "I split by field type because the user's intent differs. Picking an assignee from a dropdown *is* the decision — there's nothing to confirm, so it commits immediately. Typing a summary is a draft until you stop, so it commits on blur or Enter and discards on Escape. Autosaving text per keystroke is the option I reject hardest: this system writes an audit-history row per field change, so keystroke-level saves would bury the genuine 'Alice changed the summary' entry under forty partial strings. The history is a compliance artifact for a lot of teams — polluting it to save a blur handler is a bad trade."

Every field also renders its own pending/error state rather than the panel showing one global spinner. Fields fail independently, so a failed priority write shouldn't imply the comment you just posted didn't land.

### Losing a race

Because issues carry no client-visible version in the current design, the server accepts last-write-wins per field. That's a deliberate scoping decision and I'd name it as one:

> "For assignee or priority, last-write-wins is genuinely fine — the fields are small, and the loser can see what happened in the history. Where it stops being fine is long-form description edits, where a lost write can be ten minutes of typing. The upgrade path is a version column on the issue and a compare-and-swap update, returning 409 when the version moved. I'd want that before I'd call this production-ready, and I'd pair it with a merge affordance rather than a bare 'someone else edited this, your changes are gone' — the client already holds both the original and the edited text, so it can offer a real choice. I'd stage it that way because the conflict *plumbing* is cheap and the conflict *UI* is where the actual work is."

## 🔧 Deep Dive 4: Configuration-Driven Rendering and JQL Completion

Nothing about statuses, transitions, or issue types is hardcoded in the client. Columns come from the workflow's statuses; the actions on a card come from the server's list of currently-available transitions for that issue and user; create-issue fields come from the project's field configuration for the chosen type.

> "The temptation is to hardcode the four statuses every demo project has, because it makes the board simpler for about a week. It breaks permanently the moment a team adds a 'Blocked' column — and worse, it breaks *per project*, so to the user it looks like data corruption rather than a missing feature. Since the whole premise of the backend is that workflows are data, the client has to treat them as data too. The cost is that the client can't pre-validate much and has to render whatever shape it's handed, including workflows with more statuses than fit on screen — which is exactly why the board scrolls horizontally instead of assuming a column count."

### Dynamic forms without a client-side schema engine

The create-issue modal changes shape with the selected issue type: a bug asks for severity, an epic for a name, a story for points. The field list is server-provided metadata — type, label, required flag, allowed values.

| Approach | Pros | Cons |
|----------|------|------|
| ❌ Hardcode a form per issue type | Simple; precise control | Breaks on any custom field; unmaintainable per project |
| ❌ Full client-side schema validation engine | Instant feedback on every rule | Duplicates server validators; the two drift silently |
| ✅ Render from field metadata, validate shape only client-side | Adapts to any configuration | Business-rule errors surface on submit |

> "I validate *shape* on the client — required fields present, numbers are numbers — and let the server own *rules*. The distinction matters because shape errors are context-free and rules aren't: 'story points must be a number' is always true, while 'cannot resolve without a fix version' depends on workflow configuration the client would have to mirror to evaluate. Mirroring it means two implementations of the same rule, and the client's copy will be the stale one. So the client catches what it can prove and renders the server's field-level errors verbatim against the right inputs — which is why the transition failure path in Deep Dive 1 returns *which* field failed rather than a message string."

### JQL completion

The query box keeps a **grammar-aware but not authoritative** completion model: enough structure to know whether the cursor sits where a field, an operator, or a value belongs, and to suggest accordingly.

```
  project = DEMO AND assignee = ▌
  └─ field ─┘ └op┘ └val┘ └and┘ └field─┘ └op┘  ▲
                                                └─ expects a value:
                                                   suggest users, currentUser()
```

> "The two failure modes here are symmetric. Reimplementing the full parser client-side gives beautiful inline validation and guarantees two grammars that diverge the first time someone adds an operator server-side — and a client that rejects a query the server would happily run is worse than no validation at all. Offering no completion is the other extreme, and it's how you make a query language that only its authors can use. The middle is a positional model: track enough to know what *kind* of token comes next, suggest from server-provided vocabularies, and let the server be the only thing that ever says a query is invalid. It degrades honestly — an unfamiliar operator just means no suggestions, not a false error."

## ⚡ Performance

| Concern | Approach |
|---------|----------|
| Initial board paint | Route-level split; board and detail panel load separately |
| Re-render scope | Per-card memoization on identity; grouping memoized per column |
| Drag smoothness | Transform-only feedback; no layout thrash mid-drag |
| Backlog volume | Virtualized flat list — no horizontal drop targets to break |
| Detail panel | Comments and history load per tab, not on panel open |

The detail panel choice is worth calling out: opening an issue fetches the issue and its available transitions, but comments and history load when their tab is selected. Most panel opens are "what is this and who owns it", not "read the audit log".

## 🧯 Error and Degradation Handling

The API client normalizes every failure into a small set the UI can branch on, rather than letting raw status codes leak into components:

| Class | UI response | Retry? |
|-------|-------------|--------|
| Authorization (403) | Revert; explain who may act | No — retrying can't help |
| Validation (422) | Revert; focus the offending field | No — user must supply data |
| Conflict (409) | Show both versions; let the user choose | User-driven |
| Transient (5xx, network) | Retry once with the same idempotency key, then revert | Yes, bounded |
| Session expired (401) | Preserve in-progress edits, prompt re-auth | After re-auth |

The 401 case is the one most often gotten wrong: a session expiring mid-edit should not discard what the user typed. Edits are held in component state until commit, so re-authenticating and retrying is possible — but only if the client doesn't hard-redirect on the first 401 and throw the draft away.

**Mutations carry idempotency keys.** A transition retried after a timeout must not apply twice — without a key, the "safe" retry is exactly what creates a duplicate comment or a double transition, so the retry policy and the key generation are one decision, not two.

## 🧪 Testing Strategy

| Layer | What it covers | Why here |
|-------|----------------|----------|
| Unit | Grouping logic, JQL cursor-position model, error normalization | Pure functions with real edge cases |
| Component | Optimistic apply → reject → revert, per field class | The logic most likely to regress silently |
| Integration | Route guard: deep link with a cold store must render, not redirect | The exact bug class described earlier |
| E2E | Login → board → drag → detail → comment | Proves the stack agrees end to end |

> "I'd weight tests toward the optimistic paths, because they're the ones where a bug produces a *plausible* wrong answer rather than a crash. A card in the wrong column after a failed rollback looks like real data. I'd also explicitly test the cold-start deep link, since that failure only appears on first load — navigating from inside the app leaves data in the store and masks it completely, which makes it exactly the kind of bug that survives manual testing."

## ♿ Accessibility

- **Keyboard parity for the core action** — every transition reachable without a pointer, via the same code path as the drag (see Deep Dive 1)
- **Focus management** — the slide-over traps focus and returns it to the originating card on close, so keyboard users don't get dumped at the top of the document
- **Live regions** — transition results, save confirmations, and rollbacks are announced; optimistic UI is otherwise invisible to screen readers
- **Status is never colour-alone** — columns and cards pair category colour with text, since status is the primary signal on this screen

## 🔄 Live Collaboration: What I Deferred, and Why

I scoped out real-time updates early, and I want to defend that rather than let it pass as an oversight.

| Approach | Fit for this product | Cost |
|----------|---------------------|------|
| ❌ Poll the board every few seconds | Wasteful; a board is a large payload to re-request on a timer | Server load scales with idle tabs |
| ❌ Full CRDT / collaborative editing | Wrong model — issues are field-level records, not shared documents | Very high complexity for no gain |
| ✅ Refresh on window focus (today) | Covers the common "come back to the tab" case | Divergence while two people plan simultaneously |
| ✅ Server-pushed issue events (next) | Matches the existing event stream exactly | Connection lifecycle, reconnect, backfill |

> "Jira isn't a collaborative editor, and treating it like one would be a serious mis-read. Two people almost never edit the same *field* of the same issue at the same moment — they work on different issues on the same board. That means I don't need character-level merge; I need each client to learn that some issue changed and re-render one card. That's a much smaller problem, and the backend already publishes issue events for search indexing and notifications, so the payload and the fan-out exist.
>
> What makes it non-trivial on the client isn't the socket — it's reconnection. A tab that sleeps for ten minutes and wakes up has missed events, so a naive subscription silently shows a stale board while *looking* live, which is worse than obviously-stale. So a correct implementation needs the connection to carry a resume point and fall back to a full board refetch when it can't backfill. Refresh-on-focus is the honest 80% version of that, and it's why I'd ship it first rather than treat it as a placeholder."

The key structural point: pushed events would merge into the same store the optimistic path writes to, using the same server-shaped issue record. No second code path, and no separate reconciliation to keep in sync — which is the payoff for the single-record state model.

## 📈 What Breaks First

1. **Board grouping cost** — recomputing groups on every issue change is fine at hundreds of cards, not at thousands. Fix: incremental group updates keyed by the changed issue rather than a full regroup.
2. **No live updates** — with several people planning a sprint simultaneously, boards diverge until refresh. Fix: subscribe to issue events per project and merge them into the same store the optimistic path writes to. I'd add this before anything else on this list; it's the most-felt gap.
3. **Stale search results** — the issue list is served from an eventually-consistent index, so a freshly created issue may not appear in a JQL result immediately. Fix: for the creating user, merge the write response into the local result set rather than waiting for the index.
4. **Detail panel field sprawl** — custom fields per project eventually outgrow a fixed sidebar. Fix: a configuration-driven field renderer with collapsible groups.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Drag commit | Optimistic + reconcile | Await server | Boards are bulk tools; serialized confirmation kills triage |
| Rejection handling | Branch by status class | Generic error toast | 403 and 422 need different user actions |
| Board volume | Cap + page per column | Virtualize columns | Virtualization breaks drop targeting; backlog is the bulk tool |
| Backlog volume | Virtualized list | Cap + page | No horizontal drop targets, so virtualization composes cleanly |
| State shape | One record per issue | Per-view copies | Removes an entire class of cross-view staleness bugs |
| Text commit | On blur/Enter | Per keystroke | Keystroke saves pollute the audit history |
| Concurrency | Last-write-wins (today) | Version + 409 | Scoped deliberately; named as the next hardening step |
| Workflow rendering | Fully config-driven | Hardcoded statuses | Workflows are admin data; hardcoding breaks per project |
| Route guard | Distinguish loading vs absent | Redirect when empty | Otherwise every deep link bounces before its fetch starts |

## 🚀 Closing

"The through-line is that this client is a fast, honest view over a server that owns the rules. It applies changes instantly because a board used for real planning has to keep up with the person using it — and it reconciles carefully, and visibly, because the server rejecting a move is a normal, reproducible outcome here rather than an exception.

If I had another iteration, I'd spend it on live updates: everything I've described converges correctly for one user, and sprint planning is the one activity where several people are guaranteed to be on the same board at the same time. The optimistic path already merges server-shaped issue updates into a single store, so subscribing to issue events is a smaller change than it sounds — which is largely why I structured the state that way."
