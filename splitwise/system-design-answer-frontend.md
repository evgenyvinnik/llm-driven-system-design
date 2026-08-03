# Splitwise Frontend — System Design Answer

## 45–50 minute interview walkthrough

## Opening — 2 minutes

“I’ll design the frontend for an expense-splitting product. The defining interaction is not the dashboard; it is entering an expense and making the resulting balances trustworthy. I’ll design the client around exact integer-cents calculations, server-authoritative balances, and a route-level data model that remains usable on a phone.”

I’ll use the RADIO structure as a guide:

| Stage | What I will cover | Approximate time |
|---|---|---:|
| Requirements | Personas, correctness, scope, and scale | 4 min |
| Architecture | Routes, stores, feature boundaries, and data flow | 8 min |
| Data model | Server entities, drafts, derived state, and ownership | 6 min |
| Interfaces | REST APIs and component contracts | 8 min |
| Optimizations/deep dives | Money, optimistic UX, offline, accessibility, and failure | 18–22 min |
| Wrap-up | Trade-offs and what breaks first | 3 min |

## R — Requirements — 4 minutes

### Clarifying questions

I would ask:

- Is this primarily a consumer mobile product, a desktop family product, or both?
- Are balances and settlements the source of truth for real money, or are they informal reminders?
- Do we need offline expense capture, or can the app become read-only while disconnected?
- Can multiple members edit the same group at the same time?
- Should users split only by equal shares, or also by exact amount, percentage, and weighted shares?
- How large can groups, expense histories, and activity timelines become?
- Are currencies fixed per group, and do we need currency conversion?

For this answer I’ll assume a mobile-first responsive web app, small groups of 2–50 members, a single currency per group, exact expense and settlement values, shared group access, and a 10-second freshness target for balances. Offline drafting is useful; offline financial writes are optional and require idempotency.

### Functional requirements

1. Users view a dashboard with total owed, total owed to them, groups, friends, and recent activity.
2. Users open a group and view its expense ledger, members, balances, and settlement suggestions.
3. Users add an expense with payer, amount, participants, category, notes, and split mode.
4. The split editor supports equal, exact amount, percentage, and shares modes.
5. Users settle a suggested transfer and see the authoritative balance afterward.
6. Users can retry failed reads and recover a write whose response was lost.
7. The UI works with keyboard navigation, screen readers, narrow screens, and reduced motion.

### Non-functional requirements

- Split validation should respond within one frame for normal groups.
- The save interaction should feel immediate without displaying incorrect balances.
- Duplicate submissions must not create duplicate expenses or settlements.
- The app should remain usable when a single query fails.
- The ledger must scale through pagination rather than downloading unbounded history.
- The UI must preserve a draft across authentication renewal or a transient network failure.

### Out of scope

I will not design the backend debt-simplification algorithm, payment processor integration, multi-currency conversion, or a full offline-first sync engine. I will define the client contracts and explain where those features would attach.

## A — Architecture — 8 minutes

### High-level diagram

``` 
┌──────────────────────────────────────────────────────────────────┐
│                         Frontend Shell                           │
│ routing · auth · responsive layout · announcements · theme       │
├──────────────────────────────────────────────────────────────────┤
│ Dashboard / Group Route                                          │
│ ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│ │ Expense Ledger  │  │ Balances Panel   │  │ Activity Feed    │ │
│ └────────┬────────┘  └────────┬─────────┘  └────────┬─────────┘ │
│          │                    │                     │           │
│          └────────────────────┴─────────────────────┘           │
│                         Server-state layer                      │
│                query cache · invalidation · retries             │
├──────────────────────────────────────────────────────────────────┤
│ Expense Draft / Split Editor                                    │
│ local reducer · integer-cents preview · validation · focus       │
├──────────────────────────────────────────────────────────────────┤
│ Typed API Client                                                │
│ credentials · idempotency keys · cancellation · typed errors    │
└──────────────────────────────┬───────────────────────────────────┘
                               │ HTTPS
                    ┌──────────▼──────────┐
                    │ Server API boundary │
                    │ auth · permissions  │
                    │ expenses · balances │
                    └─────────────────────┘
```

### Shell

The shell owns routing, authentication status, global navigation, responsive layout, and cross-cutting announcements. It does not own every expense or balance in one global store.

The route owns the group page composition. The dashboard route owns dashboard totals and group summaries. A group route owns the queries needed to render that group and coordinates invalidation after a mutation.

### Feature boundaries

The expense feature owns the draft and submit lifecycle. The balance feature renders server-provided balances and settlement suggestions. The ledger feature owns cursor pagination and pending-row presentation. Shared UI owns modal focus behavior, form controls, currency formatting, and error announcements.

The split editor must be a pure interaction boundary. It accepts members, total cents, split mode, and draft fields. It returns field changes and a validation result. It does not fetch data or mutate the balance store.

### State approach

I would keep authentication and small shell preferences in Zustand or an equivalent store. Server-originated group data belongs in a server-state layer such as React Query, or in a typed route-level cache for the smaller local project. Draft state remains local to the modal.

The alternative is one global store containing dashboards, groups, expenses, balances, drafts, and loading flags. That makes cross-route access convenient, but invalidation becomes implicit and one stale update can affect unrelated screens. The narrower ownership model is easier to reason about.

## D — Data Model — 6 minutes

### Server-originated entities

| Entity | Owner in the client | Important fields | Consistency |
|---|---|---|---|
| `User` | auth/session layer | ID, name, avatar, capabilities | authoritative |
| `Group` | dashboard/group route | ID, name, member IDs, currency, version | authoritative |
| `Expense` | ledger query | ID, group ID, payer, amount cents, split lines, created time | authoritative |
| `BalanceSnapshot` | balances query | group ID, member ID, net cents, computed time | authoritative but refreshable |
| `SettlementSuggestion` | balances panel | from ID, to ID, amount cents, algorithm version | derived by server |
| `ActivityPage` | activity query | events, cursor, next cursor | cursor-paginated |

### Client-owned entities

| Entity | Lifecycle | Purpose |
|---|---|---|
| `ExpenseDraft` | ephemeral, optionally persisted | amount, payer, participants, split mode, fields |
| `SplitValidation` | derived from draft | resolved cents, remaining cents, error, can submit |
| `PendingMutation` | until acknowledged | idempotency key, command, status, retry count |
| `ViewPreferences` | persisted locally | selected group, compact mode, currency display |
| `FocusState` | ephemeral | active field, modal focus, live-region message |

Money is represented as integer cents in the client for arithmetic. Decimal display formatting happens at the edge. A floating-point number is not allowed to become the source of truth for the amount, split allocation, balance, or settlement.

### Ownership and derived state

The expense ledger owns expense rows. The balance panel owns no calculation of group balances; it renders the server snapshot. The split editor owns its draft and derives its validation result. The route coordinates queries and invalidation but does not duplicate the split algorithm.

This gives every important value one home. A draft can be wrong while it is being edited, but it cannot silently become a balance. A pending row can be optimistic, but the balance card remains authoritative.

## I — Interfaces — 8 minutes

### Server API

``` 
GET  /api/me                              → current user and capabilities
GET  /api/groups                          → accessible groups and summaries
GET  /api/groups/:groupId                 → group metadata and members
GET  /api/groups/:groupId/expenses        → cursor-paginated ledger
GET  /api/groups/:groupId/balances        → net balances and suggestions
POST /api/groups/:groupId/expenses        → create expense
POST /api/groups/:groupId/settlements     → create settlement
GET  /api/groups/:groupId/activity        → cursor-paginated activity
```

Expense and settlement commands include an idempotency key, group version when available, integer amount cents, currency, and a normalized set of allocations. The server validates membership, permission, exact sum, currency, and command uniqueness.

A successful mutation returns the canonical entity and the new group version. The client then invalidates ledger, balances, totals, and activity. A `409` returns the current version and enough context for the UI to preserve the draft and explain the conflict.

### Query and mutation lifecycle

Reads can use stale-while-revalidate. A visible group can render the last successful balances with a stale timestamp while a refresh is in flight. A financial mutation has stricter semantics: the UI may show a pending ledger row, but it cannot say that balances changed until the server confirms.

When a request times out after transmission, the client enters `unknown`, not `failed`. It queries the command status by idempotency key or refetches the group before allowing a new command. A new key would make a duplicate write possible.

### Component interfaces

| Component | Inputs | Outputs/events |
|---|---|---|
| `GroupRoute` | group ID, route state | load, refresh, invalidate, navigate |
| `ExpenseLedger` | expense page, cursor, pending rows | load-more, retry, select expense |
| `BalancesPanel` | balance snapshot, suggestions, freshness | settle intent, refresh |
| `AddExpenseModal` | members, defaults, submit status | draft change, submit command, cancel |
| `SplitEditor` | members, total cents, mode, fields | resolved allocation, validation |
| `SettleUpModal` | suggested transfer, permissions | settlement command, cancel |

These interfaces intentionally pass data and events. Child components do not import a global API client or reach into sibling state.

## O — Optimizations and Deep Dives — 18–22 minutes

### Deep dive 1: Split preview versus server authority

The client should calculate a preview because the user is solving an interactive constraint problem. Equal, exact, percentage, and shares modes can be represented as bounded integer arithmetic. The editor can show the remaining amount or percentage instantly and teach the user how to fix it.

The server must still decide the final result because it knows membership, permissions, currency, concurrent expenses, and fraud or policy controls. The client sends the resolved command and treats its preview as provisional. If the server returns a different canonical allocation, the UI explains the difference and retains the draft.

The alternative is server-only validation on every keystroke. That centralizes logic but creates latency, unnecessary requests, and a poor offline experience. The chosen design duplicates one deterministic allocation function while retaining server validation as the correctness boundary.

The key implementation detail is largest-remainder allocation. A total of 1000 cents split three ways becomes 334, 333, and 333 according to a deterministic remainder order. The same rule must be used in the client preview and server result, and tests must cover ties and participant reordering.

### Deep dive 2: Optimistic feel without optimistic balances

Optimistic UI is appropriate for local modal interactions and a pending expense row. It is dangerous for balances because another member may add an expense at the same time, the server may reject the write, or the user may lose authorization.

My choice is optimistic presentation for the list, pessimistic presentation for financial truth:

1. The modal validates locally and submits with an idempotency key.
2. The ledger may show a pending row with a clear saving label.
3. The balance card continues to show the previous authoritative snapshot.
4. On success, the client inserts the canonical expense and invalidates balances.
5. On conflict or timeout, the draft remains available and the UI explains the next action.

This costs a small moment where the new expense appears before the balance changes, but it avoids displaying a wrong dollar amount. For a financial product, trust is more valuable than pretending every write is instant.

### Deep dive 3: Query cache versus route-owned fetching

The small app can use a typed fetch client and route-owned state. This keeps dependencies low and makes invalidation explicit. As users navigate between dashboard, group, and activity views, the same group data begins to appear in multiple places. At that point a server-state cache provides deduplication, focus refetch, background refresh, and mutation invalidation.

The cost is cache-key discipline. A developer can invalidate expenses but forget balances. I would define invalidation groups around a mutation: expense creation invalidates the ledger, balance snapshot, totals, and activity for that group. A mutation test should verify those relationships.

### Deep dive 4: Offline and retries

Offline reads can show the last group snapshot with a timestamp. Offline drafting can be useful, but offline writes should be introduced only if the product proves that capture without connection is essential. A queued command must contain the original idempotency key, group version, currency, and exact allocations.

On reconnect, the client submits the command once, resolves unknown status, and handles a version conflict. It never calculates a new balance from the local queue. The safer alternative is read-only offline mode plus a persisted draft; I would choose that for the first release.

### Deep dive 5: Accessibility and mobile

The modal becomes a full-screen sheet on a narrow viewport while keeping the same semantic order. The amount input receives focus first. Participant rows have labels that include member names. Split modes use a tab pattern. Validation messages use a polite live region and text such as “34 cents left to assign,” not only color.

The balances panel provides a text alternative for visual arrows: “Carol pays Alice 741 dollars.” A reduced-motion preference disables animated balance transitions. Focus returns to the Add Expense button after a successful save or remains in the modal after an error.

### Failure matrix

| Failure | UI behavior | Recovery |
|---|---|---|
| Group read fails | route error with retry | retry same URL |
| Balance refresh fails | stale timestamp | retry in background; block settlement if too old |
| Expense timeout | unknown command | lookup by idempotency key |
| Version conflict | retain draft and show server changes | review and resubmit |
| Session expiry | preserve draft | reauthenticate, then retry |
| Offline | banner and draft mode | save draft locally or retry later |

### Performance and scaling

The first scaling problem is an unbounded ledger. Cursor pagination comes before client virtualization because rendering less does not fix downloading too much. The second is repeated group data across routes, which motivates server-state caching. The third is concurrent edits, which motivates group versions and visible conflict resolution.

The performance budget is under one frame for split validation, immediate feedback for local interactions, first-page rendering before secondary activity, and bounded retained cursor pages on mobile. I would measure input latency, route-to-first-content, balance staleness age, duplicate mutation rate, and query-cache hit rate.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Money representation | integer cents | floating-point numbers | exact arithmetic and comparison |
| Split validation | local deterministic preview plus server validation | server-only validation | immediate feedback without giving up authority |
| Balance updates | refetch authoritative result | optimistic balance patch | correctness beats cosmetic immediacy |
| Data layer | route-owned queries first, cache as usage grows | one global store | avoids stale cross-feature state |
| Mutation retry | idempotency key and unknown state | disabled button only | UI state cannot guarantee exactly-once behavior |
| Offline | drafts first, queued writes later | full offline sync immediately | financial conflict complexity is high |
| Ledger rendering | cursor pagination, then virtualization | download everything | bounds transfer before DOM work |
| Simplification | server-derived suggestions | duplicate graph algorithm in client | one authoritative business rule |

## Closing — 3 minutes

“The client is organized around one promise: the user should never be misled about money. Local state makes split editing immediate, but server state owns balances. The route and data layer keep related group views coherent. Idempotency handles ambiguous writes, cursor pagination handles history, and accessible text states make the same truth available to every user.”

If time remains, I would discuss multi-currency support, itemized tax and tip splits, shared expense editing, and whether a background sync queue is worth its conflict-resolution cost.
