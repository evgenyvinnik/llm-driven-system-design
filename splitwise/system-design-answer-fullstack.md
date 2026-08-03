# Splitwise Full-Stack — System Design Answer

## 45–50 minute interview walkthrough

| Segment | Focus | Time |
|---|---|---:|
| Requirements | Shared-expense user journey | 4 min |
| Architecture | React shell through API and projections | 8 min |
| Data model | Expense facts, splits, balances, client state | 6 min |
| Interfaces | REST, errors, mutation lifecycle | 8 min |
| Deep dives | Money, optimistic feel, consistency, scaling | 20 min |
| Trade-offs and close | Alternatives and rollout | 4 min |

## Opening — 2 minutes

I am designing a full-stack shared-expense application. A user opens a group, adds an expense, selects participants, sees a local split preview, submits it, and trusts the resulting balances.

The browser owns interaction state and provisional feedback. The API owns authentication and validation. The expense ledger owns durable facts. A balance projection makes reads fast, but its source version and freshness are visible.

## R — Requirements — 4 minutes

### Clarifying questions

I would ask whether groups have one currency, whether users can edit old expenses, whether settlement payments are required, and whether offline writes are in scope. I will support one currency per group, audited edits, settlement records, and saved drafts before offline command replay.

### Functional requirements

- Create groups and manage members.
- View group ledger, balances, and activity.
- Add equal, exact, percentage, or shares-based expenses.
- Validate exact allocation and currency precision.
- Edit or delete expenses according to permissions.
- Suggest and record settlements.
- Paginate history and preserve shareable group routes.
- Recover from network failures without duplicate expense creation.

### Non-functional requirements

- The split editor responds locally to every input.
- A balance never displays a guessed value as authoritative.
- A timeout can be resolved by command key.
- One failed panel does not blank the group page.
- Group data is isolated by server authorization.
- Currency values remain exact across browser, API, and database.

### Out of scope

I will not design bank transfers, currency exchange, debt collection, or a fully offline-first mutation engine. I will define the interfaces where they attach.

## A — Architecture — 8 minutes

### Combined architecture diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                       React SPA (Vite + TypeScript)                         │
│ Routes: /groups · /groups/$id · /groups/$id/add · /activity                │
│                                                                            │
│ authStore · groupStore · ledgerStore · draftStore                          │
│ server-state cache · invalidation · retry · freshness                      │
│ form/render adapters · currency formatting · focus management              │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ HTTPS
┌──────────────────────────────▼─────────────────────────────────────────────┐
│ Splitwise API boundary                                                     │
│ auth · membership · expenses · balances · settlements · idempotency        │
├───────────────────────┬───────────────────────┬────────────────────────────┤
│ Expense ledger         │ Balance projections   │ Settlement boundary        │
│ facts · splits · audit │ workers · explain API │ records · payment provider │
├───────────────────────┴───────────────────────┴────────────────────────────┤
│ PostgreSQL source of truth · cache · outbox/events · background workers     │
└────────────────────────────────────────────────────────────────────────────┘
```

### Frontend responsibilities

The shell owns routing, authentication status, responsive layout, announcements, and global errors. The group route composes ledger, balances, activity, and settlement panels. The draft store owns only the active expense form.

The server-state layer caches group-scoped queries and invalidates related data after mutations. Render adapters handle currency formatting, pending rows, skeletons, and accessible errors. Components do not calculate canonical balances from local drafts.

### Backend responsibilities

The API checks membership and role, validates amounts and splits, writes the expense atomically, and returns canonical results. A projection worker derives balances and activity from committed facts. The settlement service records an explicit command and integrates with a payment provider if enabled.

### End-to-end add flow

1. The route loads group members and current balances.
2. The user edits a local draft and receives split validation immediately.
3. The client submits one command key with exact inputs.
4. The API checks authorization, currency, membership, and versions.
5. The transaction writes expense, splits, audit, and outbox records.
6. The client shows a canonical or pending ledger row.
7. Projection refresh invalidates balances and activity.

## D — Data Model — 6 minutes

### Server entities

| Entity | Important fields | Authority |
|---|---|---|
| `Group` | ID, currency, version, status | group service |
| `Membership` | group, user, role, status | authorization |
| `Expense` | payer, total, currency, revision | expense ledger |
| `Split` | participant, exact amount, mode metadata | expense ledger |
| `Settlement` | from, to, amount, provider status | settlement service |
| `BalanceProjection` | pair amount, source version, computed time | read model |

### Client entities

| Entity | Owner | Lifetime |
|---|---|---|
| `GroupSummary` | query cache | server freshness |
| `LedgerPage` | route cache | cursor session |
| `BalanceSnapshot` | query cache | source version |
| `ExpenseDraft` | local reducer | form session/recovery |
| `MutationState` | command client | pending to resolved |
| `SelectionState` | UI component | ephemeral |

The URL owns the group ID and committed route. The draft owns raw input. The server owns exact splits and balances. The result of one mutation is never treated as a complete replacement for all group queries unless the API explicitly provides those projections.

### Money and consistency

Amounts are integer minor units or fixed decimal strings with one group currency. The API returns strings or minor units with currency. The frontend formats but does not use binary floating point for allocation.

Expense facts and settlements are durable. Pending rows, form previews, and cache entries are provisional. The UI labels stale balance data and does not imply that a pending expense has changed the authoritative balance.

## I — Interfaces — 8 minutes

### REST API

```
GET  /api/v1/groups                         → visible groups
GET  /api/v1/groups/:id                     → members and permissions
GET  /api/v1/groups/:id/expenses?cursor=    → ledger page
POST /api/v1/groups/:id/expenses             → idempotent expense command
PATCH /api/v1/expenses/:id                  → versioned edit
DELETE /api/v1/expenses/:id                 → audited deletion
GET  /api/v1/groups/:id/balances             → balance snapshot
GET  /api/v1/groups/:id/balances/explain     → contributing facts
POST /api/v1/groups/:id/settlements          → settlement command
GET  /api/v1/commands/:key                   → resolve unknown command
```

### Expense command

The request contains payer, total, currency, split mode, participant inputs, note, expected group version where needed, and command key. The response contains canonical expense ID, exact splits, group version, audit reference, and projection freshness.

### Error interface

The API distinguishes invalid allocation, unauthorized member, expired session, version conflict, duplicate command, unavailable projection, and payment failure. The frontend maps them to field errors, reauthentication, draft recovery, retry, or explicit review.

### Frontend interfaces

| Component | Receives | Emits |
|---|---|---|
| Group route | group ID and viewer | composed page state |
| Ledger | paged records and cursor state | load next, retry |
| Balance panel | snapshot and freshness | refresh, explain |
| Expense editor | members, currency, draft | validate, submit |
| Settlement panel | canonical balance | create command |
| Query layer | key and fetcher | data, stale, error |

### Mutation lifecycle

The client creates a stable command key when the user chooses submit. It can retry the same key. A timeout enters checking status. A duplicate response resolves to the original entity. A version conflict preserves the draft and asks the user to review current data.

## O — Optimizations and Deep Dives — 20 minutes

### Deep dive 1: Local split preview versus server authority

The browser calculates a deterministic preview so equal, exact, percentage, and share modes feel immediate. The server repeats the calculation with authoritative currency scale, membership, and policy checks.

The alternative is a server round trip for every keystroke. That creates latency and makes the editor feel broken on mobile. The cost of local preview is duplicate logic, so the rule set must be tested with the same edge cases and the response must replace the preview with canonical amounts.

### Deep dive 2: Optimistic feel without optimistic balance

The ledger can show a pending row after a successful command response, while the balance panel remains on its authoritative snapshot with a refresh marker. On projection success, the balance updates. On failure, the row and stale balance remain explainable.

Optimistically adding a new balance is tempting but dangerous. Concurrent expenses, authorization changes, or server rounding can make it wrong. A small delay is preferable to a financial number that users cannot trust.

### Deep dive 3: Projection, cache, and invalidation

The expense transaction writes facts and an outbox event. A worker updates the balance projection. The query cache receives invalidation for ledger, balances, totals, and activity. The frontend can keep old data visible while fetching the new source version.

Caching each panel independently without an invalidation graph creates contradictory UI: a new ledger beside an old balance. Explicit invalidation groups add maintenance, but they make consistency relationships testable.

### Deep dive 4: Version conflicts and edits

An expense edit includes the expense or group version observed by the client. The server rejects stale changes rather than silently overwriting another member’s edit. The response includes canonical data and a reason.

The frontend keeps the user’s draft separate from the canonical record. It can show a field-level or expense-level review. Retrying without a new version would repeat the conflict; blindly accepting the server would lose intent.

### Deep dive 5: Settlement and payment boundary

The balance suggestion is a read model. When a user accepts it, the backend validates current balances and records a settlement command. If a payment provider is enabled, provider intent and webhook status are separate from the group debt fact.

The UI distinguishes suggested, initiated, pending, paid, failed, and cancelled. A payment timeout cannot create a second debt because the command key and provider ID are stable.

### Deep dive 6: Failure matrix

| Failure | Backend behavior | Frontend behavior |
|---|---|---|
| First page fails | return typed error | route-local retry |
| Expense timeout | retain command result | status lookup |
| Projection lag | return source version | stale balance label |
| Version conflict | reject stale write | preserve draft |
| Session expiry | deny command | reauthenticate safely |
| Payment delayed | retain pending status | no false paid state |
| Cache down | bypass or rebuild | slower response |

### Deep dive 7: Offline boundary

Read-only cached groups and persisted drafts are safe starting points. Offline mutation replay requires storing command key, group version, exact amounts, and authorization assumptions. On reconnect, the server must resolve membership and version conflicts.

I would not add offline writes until the product proves the need. The simpler design preserves user input without claiming that a financial command has been accepted while disconnected.

## Capacity, rollout, and review checkpoints

### Capacity assumptions

I would test a normal group, a hot group with concurrent edits, a long ledger, and a mobile client on a lossy connection. The capacity budget includes form responsiveness, API mutation latency, projection lag, and browser rendering cost.

### What I would measure

- Split-preview input latency.
- First ledger and balance response time.
- Expense command timeout and duplicate rates.
- Projection freshness and cache invalidation age.
- Version conflicts and draft recovery.
- Cursor page size and rendering cost.
- Settlement command and provider latency.

### Rollout sequence

1. Build group route, membership, ledger reads, and accessible loading states.
2. Add local split preview and exact server allocation.
3. Add idempotent expense commands and pending ledger rows.
4. Add balance projection, invalidation, and stale labels.
5. Add audited edits, settlements, and payment status.
6. Add offline command replay only after conflict and authorization tests pass.

### Alternative architecture review

One global frontend store is easy to start but mixes form keystrokes with server data. Route-scoped queries plus feature-local stores preserve reuse without making every component rerender.

An iframe per ledger or balance panel is unnecessary for trusted first-party code. Shared focus, currency context, responsive layout, and invalidation are more valuable than hard isolation. Module boundaries can still provide team ownership.

The backend can calculate balances synchronously for small groups, but a projection is safer for hot groups and gives a repair path. The UI always labels whether it is showing canonical, pending, or stale data.

### Full-stack interview checkpoints

I trace an Add Expense journey from local form state to typed command, transaction, projection, cache invalidation, and balance refresh.

I pause on the exact amount invariant and the timeout-to-status-lookup path.

I close by showing that a failed balance panel does not prevent ledger review and that a failed payment does not erase recorded debt.

## Scalability and operations

Cursor pagination bounds ledger transfer. Projection workers partition by group ID for stable ordering. Hot groups can use serialized command queues or optimistic version checks. API and query nodes scale horizontally.

The first browser bottleneck is an unbounded ledger; the first backend bottleneck is projection work for hot groups. The first correctness risk is duplicate or stale mutation handling. Metrics must cover all three.

## Security and observability

Every group query and mutation checks membership and role. Cache keys include group and viewer scope. Expense notes and member data are treated as private. Rate limits apply to mutation commands and expensive balance explanations.

Metrics include query latency, mutation latency, command duplicate rate, projection lag, conflict rate, cache hit rate, draft recovery, and settlement provider delay. Traces carry group and command IDs with privacy-safe sampling.

## Testing and correctness review

I would test the complete Add Expense journey with reordered participants, a lossy network, a projection delay, a version conflict, and a session expiry during submit. The draft must survive while canonical state remains clear.

Backend tests verify exact allocation, idempotency, group authorization, projection replay, and settlement status. Browser tests verify focus, keyboard split editing, pending rows, stale labels, and retry behavior.

The acceptance criteria are no duplicate expenses, no silently changed amounts, and no balance shown as authoritative when its source is stale.

## Implementation sequence

1. Build group route, membership, ledger, and balance loading states.
2. Add local split preview with exact server confirmation.
3. Add idempotent commands and pending ledger presentation.
4. Add projections, invalidation, and stale balance labels.
5. Add versioned edits and settlement status.
6. Add draft recovery before attempting offline writes.

The sequence demonstrates a coherent user journey early and delays the most ambiguous feature—offline mutation replay—until the conflict protocol is explicit.

## Interview walkthrough: one expense

The route loads members and balances. The editor calculates a local preview, then submits one exact command key. The API validates membership, currency, and version and returns the canonical expense.

The ledger can show a pending row while the balance query refreshes. A projection delay becomes a visible stale state, not a guessed arithmetic update. A conflict preserves the draft for review.

This scenario ties form state, typed APIs, idempotency, projections, and accessible failure states together.

## Further design decisions

The draft is persisted only as user recovery state, never as an accepted expense. The server response replaces the preview with canonical allocations.

The group route can keep a successful ledger visible while a balance request retries. Independent panel states make partial failure honest and useful.

The query cache invalidates all projections affected by an expense mutation. A pending row is removed or replaced by canonical data using command key, not array position.

The shell owns authorization context and announcements; feature panels own their queries and local errors. This keeps a failed activity feed from hiding balances.

The production review asks whether the UI distinguishes draft, pending, stale, conflict, and committed states and whether those states map directly to API semantics.

### Final questions

- Is the split preview authoritative?
- What does a pending row mean?
- How is a duplicate avoided?
- Can the user explain a balance?
- What survives offline?

The answers should point to local drafts, canonical commands, projections, and visible freshness.

### Launch gate

The launch gate is accessible split editing, exact server confirmation, safe retry, visible stale state, and recovery of drafts after authentication or network failure.

I would not launch offline writes until the product can explain duplicate commands and version conflicts to users.

### Final handoff

- The form is local, while the ledger is authoritative.
- The API returns canonical amounts and error classes.
- Projections and caches expose freshness.
- Failed panels preserve the rest of the group workflow.

The presentation closes on the boundary between immediate interaction and durable financial truth.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Balance truth | ledger facts plus projection | mutable balance only | explainable and rebuildable |
| Form behavior | local preview | server on every keystroke | responsive interaction |
| Balance display | authoritative/stale labels | optimistic arithmetic | protects trust |
| Retry | stable command key | new request ID | avoids duplicates |
| History | cursor pagination | full download | bounded payload |
| Conflict | version rejection | last write wins | preserves shared edits |
| Offline | drafts first | queued writes immediately | less ambiguity |

## Closing — 3 minutes

The full-stack boundary is deliberate: React owns interaction and presentation, the API owns validation and authorization, the expense ledger owns facts, and projections own fast derived reads. The user gets immediate split feedback without being shown invented financial truth.

I would build one-currency groups, exact splits, cursor history, idempotent expense commands, and balance projections first. Then I would add payments, offline replay, multi-currency, and group partitioning after their consistency contracts are proven.
