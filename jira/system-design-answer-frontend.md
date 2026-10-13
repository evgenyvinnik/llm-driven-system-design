# 🎫 Issue Tracker (Jira) — System Design Answer (Frontend Focus)

*45-minute frontend interview, structured with the [RADIO framework](https://www.greatfrontend.com/front-end-system-design-playbook/framework): Requirements → Architecture → Data model → Interface → Optimizations. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "A Jira board is a bulk tool — people drag twenty cards in one planning session — but the browser is not the authority on any of it. The server decides whether a transition is allowed, what the order is, and whose edit wins, and other people are changing the same issues at the same time. So the frontend problem is being instant and honest at once: apply every action immediately, and reconcile visibly when the server says no or someone else got there first."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| R — Requirements | 5 min | Features, interaction and accessibility targets |
| A — Architecture | 8 min | Components, who owns which state, the key interactions |
| D — Data model | 5 min | Client entities, cache keys, the issue version |
| I — Interface | 5 min | The API as the client sees it; component contracts |
| O — Optimizations & deep dives | 20 min | Optimistic drags, board order at scale, edits that can't lose work |
| Loading, error & empty states | 2 min | What the UI does when things go wrong |
| Wrap-up | 2 min | Trade-offs and next steps |

---

## 🎯 R — Requirements (5 min)

"I'll confirm who uses this and how, because a planning tool and a reading tool want different budgets."

### Functional requirements

1. **Board**: one column per workflow status; drag a card to another column to run a transition, within a column to reorder it.
2. **Backlog**: the ranked list of issues not in a sprint, plus the active sprint; move issues between them.
3. **Issue panel**: a dialog over the board with inline-editable fields, comments, history and the transitions available now.
4. **Issues page**: a JQL query box with completion, and a results table.
5. **Create issue**: a form whose fields depend on the project.

Out of scope: dashboards and reports, the workflow editor, attachments.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Drag feedback | Card follows the pointer at 60 fps; drop applied in < 100 ms | Below that, drags feel detached |
| INP | < 200 ms on a 500-card board | Planning means dozens of interactions in a row |
| LCP | < 2.5 s for the board on a mid-range laptop | It is the landing page for most sessions |
| JavaScript | < 200 KB gzipped initial; issues page and editor lazy-loaded | Most sessions open only the board |
| Accessibility | WCAG 2.2 AA; every drag has a keyboard equivalent; results announced | Dragging is the primary action |
| Correctness | A rejected change is undone within a second and explained; no duplicate issues or comments on retry | A card that silently snaps back destroys trust |

### Assumptions

"I'll assume workflows are fully configurable per project — so nothing about statuses or transitions can be hard-coded in the client — boards top out in the low thousands of cards, and teammates' changes should appear within a few seconds during planning."

---

## 🏗️ A — Architecture (8 min)

"This is an authenticated, interaction-heavy app with no SEO needs, so I'd build a client-rendered SPA with route-level code splitting. Server rendering would speed up a first paint nobody shares publicly, at the cost of a rendering tier and hydration on a page that is almost all interactive."

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Router · URL state: project key, sprint, JQL, open issue (?issue=DEMO-5)                     │
└───────────┬────────────────────────────────┬────────────────────────────────┬────────────────┘
            │                                │                                │
            ▼                                ▼                                ▼
┌────────────────────────────┐   ┌────────────────────────────┐   ┌────────────────────────────┐
│ Board page                 │   │ Issue panel (dialog)       │   │ Issues page                │
│ columns of cards, drag,    │   │ fields, comments,          │   │ JQL editor with            │
│ Alt+Arrow to reorder       │   │ history, transitions       │   │ completion, results        │
└───────────┬────────────────┘   └───────────┬────────────────┘   └─────┬──────────────────────┘
            │ (1) move a card                │ (2) edit a field         │ run a query
            ▼                                ▼                          ▼
┌───────────────────────────────────────────────────────────────────────────┐  ┌───────────────┐
│ Server-state cache (TanStack Query): board, issue, search results         │  │ Client store  │
│ optimistic patch + rollback · refetch on 409 / 412 · invalidation         │  │ (Zustand)     │
└─────────────────────────────────────────────────┬─────────────────────────┘  │ session,      │
                ▲                                 │                            │ permissions   │
                │ patch / invalidate              │ fetch, mutate              └──────┬────────┘
                │                                 │                                   │
                │                                 ▼                                   ▼
┌───────────────┴────────────────┐  ┌──────────────────────────────────────────────────────────┐
│ Live channel (WebSocket)       │  │ API client: If-Match, Idempotency-Key, AbortSignal       │
│ resume from last event id      │  │ errors by class: 403 · 409 · 412 · 422 · 5xx             │
└────────────────────────────────┘  └───────────────────────┬──────────────────────────────────┘
                ▲                                           │
                │ (3) pushed issue events                   │ HTTPS, session cookie
                │                                           ▼
┌───────────────┴──────────────────────────────────────────────────────────────────────────────┐
│ Issue API · Search API (server side; see the backend design)                                 │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Move a card (1).** The board patches the cached issue at once (new status or new position), calls the API, and either merges the server's answer or restores the card and says why.
2. **Edit a field (2).** The issue panel sends the change with the version it showed (`If-Match`); a `412` means someone else saved first, so the panel shows the latest version and keeps the user's draft.
3. **Live updates (3).** The server pushes issue events over a WebSocket; the live channel applies the newer versions to the cache, so a teammate's drag appears on my board without a refresh.

### Who owns which state

| State | Owner | Why there |
|-------|-------|-----------|
| Issues, board lists, search results | Server-state cache (TanStack Query) | Dedupe, retries, cancellation, optimistic updates with rollback, invalidation |
| Project, sprint, JQL, open issue | URL (router search params) | Shareable, bookmarkable, back button works, survives reload |
| Session, project permissions | Client store (Zustand) | Read by every page to hide controls the server would refuse |
| Drafts: summary text, comment, create form + idempotency key | Component state | Must survive a failed save; never shared |
| Drag state, drop indicator, dialogs | Local component state | Short-lived and per-component |

"The rule: server data never lives in a hand-written store. Copying issues into Zustand means owning staleness, deduplication and invalidation by hand, which is where 'the card says Done but the panel says In Progress' bugs come from."

### Key interaction: dragging a card to another column

```
User                           Board                    Query cache                   Issue API
  │                              │                           │                            │
  │ 1 drop DEMO-5 on Done        │                           │                            │
  │─────────────────────────────▶│                           │                            │
  │                              │ 2 patch status, snapshot  │                            │
  │                              │──────────────────────────▶│                            │
  │                              │                           │ 3 GET …/5/transitions      │
  │                              │                           │───────────────────────────▶│
  │                              │                           │ 4 Complete → Done (id 12)  │
  │                              │                           │◀───────────────────────────│
  │                              │                           │ 5 POST …/transitions/12    │
  │                              │                           │───────────────────────────▶│
  │                              │                           │ 6 200 | 403 | 409 | 422    │
  │                              │                           │◀───────────────────────────│
  │                              │ 7 merge, or restore card  │                            │
  │                              │◀──────────────────────────│                            │
  │ 8 announce: moved / why not  │                           │                            │
  │◀─────────────────────────────│                           │                            │
  │                              │                           │                            │
```

"The drop is applied before the server answers. The board then asks which transitions are available from the card's status (the list is a hint; the server re-checks everything when the transition runs), runs the one that lands in the target column, and merges the returned issue — one card, not a board refetch, which would clobber a second drag still in flight."

### Key interaction: saving an edit someone else beat me to

```
User                           Issue panel                Query cache    Issue API
  │                                 │                          │             │
  │ 1 edit summary, Save            │                          │             │
  │────────────────────────────────▶│                          │             │
  │                                 │ 2 PATCH, If-Match "7"                  │
  │                                 │───────────────────────────────────────▶│
  │                                 │ 3 412 + current issue (v8)             │
  │                                 │◀───────────────────────────────────────│
  │                                 │ 4 replace issue with v8  │             │
  │                                 │─────────────────────────▶│             │
  │ 5 alert; draft stays in editor  │                          │             │
  │◀────────────────────────────────│                          │             │
  │ 6 Save again                    │                          │             │
  │────────────────────────────────▶│                          │             │
  │                                 │ 7 PATCH, If-Match "8"                  │
  │                                 │───────────────────────────────────────▶│
  │                                 │ 8 200, ETag "9"                        │
  │                                 │◀───────────────────────────────────────│
  │                                 │                          │             │
```

"The `412` carries the current issue, so the panel can show what changed without another request. The draft stays in the editor; saving again sends the new version."

### Key interaction: a teammate's change arriving live

```
 Issue API               Gateway                         Socket                        Cache
     │                      │                               │                            │
     │ 1 DEMO-7 moved, v12  │                               │                            │
     │─────────────────────▶│                               │                            │
     │                      │ 2 seq 1042: DEMO-7 v12        │                            │
     │                      │──────────────────────────────▶│                            │
     │                      │                               │ 3 v12 newer: patch card    │
     │                      │                               │───────────────────────────▶│
     ··························· laptop sleeps; socket drops ·····························
     │                      │ 4 resume after 1042           │                            │
     │                      │◀──────────────────────────────│                            │
     │                      │ 5 missed events or "too old"  │                            │
     │                      │──────────────────────────────▶│                            │
     │                      │                               │ 6 apply, or refetch board  │
     │                      │                               │───────────────────────────▶│
     │                      │                               │                            │
```

"Events carry a sequence number and the issue's version. The cache applies an event only if its version is newer than what it holds, so an event that crosses my own write in flight can't regress the card. After a disconnect the socket resumes from the last sequence it saw; if the server no longer has those events, the client refetches the board rather than pretending to be live."

---

## 💾 D — Data Model (5 min)

| Entity | Shape | Cache key | Freshness |
|--------|-------|-----------|-----------|
| `Issue` | `id`, `key`, `summary`, `status {id, name, category}`, `assignee`, `sprint`, `storyPoints`, `version`, `rank` | `['issue', key]`, and inside board lists | Live events; refetch on window focus |
| `BoardList` | `issues: Issue[]` in rank order, `nextCursor` | `['board', projectKey, sprintId]` | Live events; refetch after a `409` |
| `Workflow` | `statuses[]` (category, order), `transitions[]` | `['workflow', projectKey]` | Rarely changes; long stale time |
| `Permissions` | `['view_issue', 'edit_issue', …]` | Zustand, per project | Refetched when the project changes |
| `SearchResult` | `issues[]`, `total`, `cursor` | `['search', jql]` | Short stale time; may lag writes by seconds |
| `Draft` | text or form fields + `idempotencyKey` | Component state | Cleared on success |

Two modeling decisions:

- **Columns are derived, not stored.** A column is "issues in the board list whose status is X", in list order. Moving a card between columns changes one field on one issue; there is no second copy to keep in sync.
- **`version` and `rank` are part of the issue.** The client never computes them: it echoes `version` back in `If-Match` and sends "after issue 17" for reorders. Both are opaque tokens to the UI, which keeps the clever parts on the server.

---

## 🔌 I — Interface (5 min)

### The API as the client sees it

```
GET   /api/v1/boards/{id}/issues?cursor=…         → {issues (rank order), nextCursor}
GET   /api/v1/issues/{key}                        → Issue + ETag "7"
PATCH /api/v1/issues/{id}       If-Match: "7"     → 200 Issue | 412 {issue: current}
GET   /api/v1/issues/{id}/transitions             → transitions I may run now
POST  /api/v1/issues/{id}/transitions/{tid}       → 200 Issue | 403 | 409 | 422 {field}
PUT   /api/v1/issues/{id}/rank  {afterId}         → 200 {rank}
POST  /api/v1/issues            Idempotency-Key   → 201 Issue (replayed on retry)
GET   /api/v1/search?jql=…                        → results | 400 {error, position} | 503
GET   /api/v1/projects/{key}/permissions          → ['edit_issue', …]
WS    /api/v1/projects/{key}/events?after=1038    → {seq, issueId, version, type}
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `ETag` / `If-Match` | A write applies only to the version the user saw | Never overwrite a teammate's change silently |
| Error `code` and `field` | `condition_failed`, `validation_failed` + field, `invalid_from_status`, `version_conflict` | Explain a refusal and point at the right input |
| `Idempotency-Key` | Same key + same body → same response for 24 h | Retry after a timeout without creating twice |
| `{afterId}` rank placement | The issue lands directly after that issue as of now | Send intent, not positions; stale boards still work |
| Event `seq` + `version` | Ordered per project; resumable for a window | Apply only newer versions; refetch when the window passed |

### Component contracts

| Component / hook | Contract |
|------------------|----------|
| `<Board project sprint>` | Renders columns from the workflow; owns drag state; announces results in a live region |
| `useMoveCard()` | Optimistic transition or reorder; per-card sequence numbers; restores only that card on failure |
| `<IssuePanel issueKey>` | Dialog with focus trap; per-field pending and error states; keeps drafts on `412` |
| `useSaveIssue()` | Sends `If-Match`; on `412` swaps in the current issue and returns "conflict" |
| `<JqlEditor value onRun>` | Positional completion; never blocks a query the server might accept |

---

## 🔧 O — Optimizations & Deep Dives (20 min)

### Deep dive 1: optimistic drags against a server that decides (7 min)

"The hard part: a drag can be refused for reasons the card doesn't carry. A condition (only the assignee may close it) or a validator (resolving needs a fix version) lives in workflow configuration on the server. Refusals are not network noise; they are rules working correctly, and they're reproducible: the same user gets the same refusal every time."

| Approach | Feel | Correctness | Verdict |
|----------|------|-------------|---------|
| ❌ Wait for the server before moving the card | 200–400 ms with the card stuck under the pointer | Always right | Twenty drags in a planning session become a stutter |
| ❌ Move optimistically and ignore failures | Instant | The board lies until reload, every time, for that user | Unacceptable |
| ❌ Re-implement workflow rules in the client | Instant, few rollbacks | Two implementations of every rule; the client's drifts | Wrong source of truth |
| ✅ Move optimistically, reconcile by error class | Instant | Converges within one round trip, with an explanation | Chosen |

**Reconciling by class.** `403` (a condition) restores the card and says who may move it. `422` (a validator) restores it and opens the panel on the field the validator named — the transition is legal, the issue just isn't ready. `409` means the issue moved under us: restore and refetch the board. Network errors and `5xx` restore the card with a retry option. Each message goes into an `aria-live` region, because a silent rollback is invisible to a screen-reader user.

**Restoring only the card.** I snapshot the dragged issue, not the whole board. If the user dragged a second card while the first request was in flight, restoring a board snapshot would undo the second move too.

**Out-of-order responses.** Two quick drags of the same card can resolve in the wrong order. Each move of a card gets a sequence number, and only the newest move's response is applied.

**Hints, not authority.** Columns the user can't drop into could be shaded using the available-transitions list, and drags are disabled entirely without the transition permission. These are hints: the server evaluates the rules again when the transition runs, and a list fetched a minute ago may be stale.

"What I give up: for a moment the board shows something the server may reject. For a tool whose job is moving cards quickly, a visible, explained correction is the right price."

### Deep dive 2: board order and big boards (6 min)

**Reordering.** Dropping a card between two others moves it in the list at once and sends `PUT /rank {afterId}` — the card it now sits under. The server computes the new rank key and returns it; the client stores it on the issue. If the request fails, sorting the list by rank undoes the move, because the moved card still carries its old key. The client never invents keys, so there's no client-side ordering logic to drift from the server's.

**Keyboard parity.** A focused card moves up or down with `Alt+Arrow`, which calls the same reorder code as a drag; `Enter` opens it; transitions are buttons in the panel. I build the keyboard path first and treat dragging as the shortcut, so the two never drift.

**Rendering 500+ cards.**

| Approach | Verdict |
|----------|---------|
| ❌ Virtualize every column | Drop targets that aren't in the DOM can't be hit-tested, and drag auto-scroll fights the virtualizer |
| ❌ Render everything | 500 rich cards make every optimistic update re-render the board |
| ✅ Memoized cards, capped columns, virtualized backlog | Moving one card re-renders one card and two columns; columns show the first ~100 cards with "show more"; the flat backlog list is virtualized because it has no horizontal drop targets |

"Nobody drags a card to position 140 by hand. Past a screen or two people filter, or use the backlog, which is built for volume. Drag feedback uses transforms only, so it stays on the compositor."

### Deep dive 3: edits and retries that never lose work (5 min)

**When to commit.** Discrete fields (assignee, priority, points) save on change. Text fields save on blur or Enter and discard on Escape. Saving per keystroke is the option I reject hardest: every save writes audit history, and forty partial summaries would bury the real "Alice changed the summary" entry.

**Conflicts.** Every save sends `If-Match` with the version shown. On `412` the panel swaps in the current issue, keeps the user's draft in the editor, and says what happened. For discrete fields the user just picks again; for long text they can compare and re-apply. That's honest, and the conflict UI is the real work — the version plumbing is cheap.

**Retries.** A create or comment gets an idempotency key when the user submits. If the request times out or returns `5xx`, a retry reuses the key and the server replays the original result instead of creating a second issue. A definite answer (`201`, `403`, `422`) retires the key; editing the draft makes a new one. The comment box keeps its text until the server confirms, so a failure never discards what was typed.

| Approach | Verdict |
|----------|---------|
| ✅ `If-Match` + keep the draft on `412` | No silent overwrite; no lost typing |
| ❌ Last write wins | Loses a teammate's edit with a clean history |
| ✅ Idempotency key per draft, reused only on uncertain failures | Safe retries without duplicates |
| ❌ Disable the button and hope | Prevents double clicks, not a retry after a timeout |

### Deep dive 4: JQL editor, security and performance checklist (2 min)

- **JQL completion is positional, not authoritative.** The editor knows whether the cursor expects a field, an operator or a value, and suggests from server vocabularies (fields, statuses, `currentUser()`). It never rejects a query; the server's parser returns errors with a character position, which the editor underlines.
- **XSS.** Summaries, comments and descriptions are user content: render as text, or as sanitized Markdown; links get `rel="noopener noreferrer"` and only `http(s)` schemes. A strict CSP backs this up.
- **CSRF.** Session cookie `SameSite=Lax`, JSON-only mutations, CORS limited to the app origin.
- **Performance.** Route-level code splitting (issues page, editor), prefetch the issue on card hover, `AbortController` for superseded searches, and real-user INP tracked per route.

---

## 🧯 Loading, Error and Empty States (2 min)

| Situation | What the user sees | How |
|-----------|--------------------|-----|
| Board first load | Column skeletons with card-height placeholders | Workflow and list requested in parallel |
| A drag refused | Card slides back; "Only the assignee can close DEMO-5" | Live region; `422` opens the panel on the field |
| Board changed under me (`409`) | "DEMO-5 had already moved — board refreshed" | Refetch the list, keep scroll position |
| Edit conflict (`412`) | Alert in the panel; current values shown; my draft kept | Swap in the server's issue |
| Search down (`503`) | "Search is temporarily unavailable" — not "no results" | Board and issue pages unaffected |
| Session expired | Login dialog over the page; drafts intact | Drafts in component state; retry after login |
| Read-only member | Cards not draggable; edit controls hidden | Project permissions in the client store |
| Empty column / empty filter | "No issues" in the column; "No issues match" with the query shown | Empty states that look intentional |

---

## ⚖️ Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Rendering | SPA with code splitting | SSR | Authenticated, interaction-heavy, no SEO |
| Server state | TanStack Query | Copy into Zustand | Caching, rollback and invalidation without bespoke code |
| Drags | Optimistic, reconcile by error class | Wait for the server | Planning is bulk work; refusals get explained |
| Rollback | Restore one card | Restore a board snapshot | Doesn't undo other in-flight moves |
| Order | Server rank keys, client sends `afterId` | Client-computed positions | One source of truth for order |
| Big boards | Capped columns + virtualized backlog | Virtualize columns | Virtualization breaks drop targets |
| Edits | `If-Match`, keep draft on `412` | Last write wins | No silent loss of anyone's work |
| Live updates | WebSocket events with versions and resume | Polling | Polling scales with idle tabs, not changes |

"With more time I'd add multi-select drags for bulk moves, offline queuing of edits with the same idempotency keys, and per-route Web Vitals in production."
