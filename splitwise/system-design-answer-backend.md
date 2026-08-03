# Splitwise Backend — System Design Answer

## 45–50 minute interview walkthrough

| Segment | Focus | Time |
|---|---|---:|
| Requirements | Expense, balance, settlement promises | 4 min |
| Architecture | API, ledger, balance projection, jobs | 8 min |
| Data model | Groups, expenses, splits, settlements | 6 min |
| Interfaces | REST commands, pagination, events | 8 min |
| Deep dives | Money math, balances, idempotency, simplification | 20 min |
| Scaling and close | Bottlenecks, trade-offs, rollout | 4 min |

## Opening — 2 minutes

I am designing the backend for a shared-expense product. Users create groups, record expenses, assign shares, inspect who owes whom, and optionally settle debts. The system must preserve exact amounts and make a balance explainable from the underlying expense history.

The central design choice is to treat expenses and settlements as durable facts, then derive balances from them. A cached balance is a read optimization, not the only source of truth. This makes retries and reconciliation safer.

## R — Requirements — 4 minutes

### Clarifying questions

I would ask whether one expense can use multiple currencies, whether groups can be very large, whether users can edit history, and whether payments are in scope. I will support one currency per group initially, expense edits with audit history, and an optional settlement command.

I would ask whether offline expense capture is required. I will support saved drafts and safe read caching first. Offline mutation replay is a separate feature because it needs conflict and duplicate semantics.

### Functional requirements

- Create groups and manage membership.
- Add expenses with equal, exact, percentage, or share-based splits.
- Validate that allocations sum exactly to the expense total.
- Show paginated ledger history and activity.
- Derive balances and suggested settlements.
- Edit or delete expenses with authorization and audit history.
- Record settlements idempotently.
- Support cursor pagination and group-level permissions.
- Expose explainable balance details.

### Non-functional requirements

- No fractional-cent loss or rounding drift.
- Duplicate requests must not create duplicate expenses or settlements.
- Balance reads should be fast without hiding stale or rebuilding state silently.
- A failed projection refresh must not lose the canonical expense.
- Group data must remain isolated by membership and authorization.
- Read history should scale beyond an unbounded client payload.

### Out of scope

I will not design payment processor settlement, bank verification, tax reporting, debt collection, or a multi-currency exchange engine. I will define where those services attach to the expense and settlement boundaries.

## A — Architecture — 8 minutes

### High-level diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         Splitwise API Layer                                │
│ auth · membership · idempotency · validation · pagination                   │
├───────────────────────┬───────────────────────┬────────────────────────────┤
│ Group and Expense API │ Balance Query Service  │ Settlement Service          │
│ commands · history    │ projections · explain  │ commands · payment boundary │
├───────────────────────┴───────────────────────┴────────────────────────────┤
│ Expense Ledger and Group Version Store                                      │
│ expenses · splits · settlements · audit entries                             │
├──────────────────────────────┬─────────────────────────────────────────────┤
│ Projection Workers            │ Cache and Event Bus                         │
│ balances · activity · totals  │ invalidation · notifications · rebuilds     │
├──────────────────────────────┴─────────────────────────────────────────────┤
│ PostgreSQL source of truth · Valkey cache · durable job/event storage       │
└────────────────────────────────────────────────────────────────────────────┘
```

### Request flow

The API authenticates the user, checks group membership and role, validates the expense shape, and assigns an idempotency key. It writes the expense, split rows, audit record, and an outbox event in one transaction.

A worker consumes the event and refreshes the group balance projection. The expense response can return the canonical expense immediately while the balance query reports its current projection version and freshness.

The balance service can derive a result synchronously for small groups or read a projection for common requests. Both paths use the same money and ordering rules and expose the source version used.

### Group isolation

Every group-scoped query includes the group ID and authorization context. Membership is checked in the service, not inferred from a client-provided list. Cache keys include group and authorization scope, and logout or membership changes invalidate affected entries.

### Event and cache path

The outbox prevents a committed expense from losing its invalidation event. Consumers are idempotent by event ID. Cache invalidation is best effort because the database remains authoritative; a cache miss or stale entry triggers a refresh.

## D — Data Model — 6 minutes

| Entity | Key fields | Authority | Notes |
|---|---|---|---|
| `User` | user ID, status, locale | identity service | not group data |
| `Group` | group ID, currency, version, status | group service | version for conflicts |
| `Membership` | group, user, role, status | group service | authorization boundary |
| `Expense` | ID, group, payer, amount, currency, version | expense ledger | immutable history plus revisions |
| `ExpenseSplit` | expense, member, exact amount, share metadata | expense ledger | sums to total |
| `Settlement` | ID, group, from, to, amount, command key | settlement service | idempotent command |
| `AuditEntry` | actor, action, entity, before/after reference | audit store | explainable edits |
| `BalanceProjection` | group, member pair, amount, source version | read model | rebuildable |

### Expense invariants

All split amounts use integer minor units or a decimal representation with group currency scale. The sum of split amounts equals the expense total exactly. The payer is a group member, every split participant is authorized, and the currency matches the group.

An edit creates a new canonical revision or an audit-linked replacement. It does not silently mutate historical data used by a previous settlement without recording the consequence.

### Balance derivation

For each expense, the payer receives a credit for the total and each participant receives a debit for their share. The net directed graph is aggregated by member pair. Settlements reduce the corresponding outstanding amount.

The projection stores the result for fast reads, but a rebuild can replay expense and settlement facts in group order. A response includes the source version or computed-at timestamp so the client can label freshness.

### Idempotency records

The command key is unique per user intent and operation type. The stored result includes success or rejection, canonical entity ID, and a response hash. A retry returns the original result rather than executing a second command.

## I — Interfaces — 8 minutes

### REST API

```
POST /api/v1/groups                         → create group
GET  /api/v1/groups                         → groups visible to user
GET  /api/v1/groups/:id                     → group, members, permissions
GET  /api/v1/groups/:id/expenses?cursor=    → expense page
POST /api/v1/groups/:id/expenses             → idempotent expense command
PATCH /api/v1/expenses/:id                  → authorized revision
DELETE /api/v1/expenses/:id                 → audited deletion
GET  /api/v1/groups/:id/balances             → balance projection and freshness
GET  /api/v1/groups/:id/balances/explain     → contributing expenses
POST /api/v1/groups/:id/settlements          → idempotent settlement command
GET  /api/v1/commands/:key                   → resolve unknown command
```

Expense creation accepts payer, total, currency, split mode, participant inputs, note, and command key. The server returns canonical split amounts, group version, expense ID, projection freshness, and audit reference.

### Error contract

Errors distinguish validation, membership, authorization, duplicate command, version conflict, unavailable projection, expired session, and payment-provider failure. A client may retry an unavailable read, but it should not retry a conflict without reloading or merging.

### Internal contracts

| Boundary | Input | Output | Guarantee |
|---|---|---|---|
| Expense command | authenticated draft | canonical expense | atomic ledger write |
| Projection worker | expense/settlement event | balance version | idempotent rebuild |
| Balance query | group and viewer | pair balances | scoped source version |
| Settlement command | group, parties, amount | settlement state | stable command key |
| Audit service | entity event | audit reference | immutable history |

### Pagination and ordering

Expense history uses an opaque cursor based on canonical created order and stable ID. The server may return a next cursor and projection version. Clients do not infer offsets or fetch all history to calculate a balance.

## O — Optimizations and Deep Dives — 20 minutes

### Deep dive 1: Derive balances versus store mutable balances

I choose immutable expense and settlement facts plus a rebuildable balance projection. Derived balances are explainable: every number can link back to expense splits and settlement events.

The alternative is a mutable balance row updated directly for every expense. It is fast for reads and simple at low scale, but a retry, partial transaction, or manual correction can make the balance impossible to audit. A projection adds worker lag and rebuild complexity, but those costs buy correctness and repairability.

The projection worker uses event IDs and group versions. If it processes an event twice, it does not double-count. If it falls behind, the API reports stale source version instead of pretending the latest expense is reflected.

### Deep dive 2: Money-safe split allocation

Equal splits divide integer minor units and distribute remainder units according to a deterministic participant order. Exact splits must sum to the total. Percentages must sum to the configured precision before conversion to minor units.

The server performs the final allocation because it knows currency scale, membership, and policy. A frontend preview improves interaction but is provisional. The response returns canonical allocations so every client agrees.

The trade-off is duplicating preview logic in the client and server. Server-only allocation adds round trips and makes forms feel slow. Duplicated deterministic rules require shared tests and versioned behavior, but preserve usability without weakening authority.

### Deep dive 3: Expense mutation and idempotency

The command transaction inserts an idempotency record, expense, splits, audit entry, and outbox event. A unique command key prevents duplicate execution. If the network fails after commit, lookup returns the original expense.

The alternative is relying on disabled buttons or client-generated timestamps. Those controls fail on refresh, multiple tabs, mobile retries, and proxy retries. Idempotency belongs in the server protocol and database constraint.

Updates use group or expense versions. A stale edit returns conflict with enough information to retain the user’s draft and show the canonical server revision. Silent last-write-wins can erase another member’s expense correction.

### Deep dive 4: Debt simplification

The raw balance graph describes who owes whom. A settlement suggestion computes each member’s net balance, places creditors and debtors into queues, and transfers the smaller absolute amount until all residuals are zero.

This algorithm minimizes the number of transfers for the net amounts but does not optimize fees, trust, or payment routes. It should be a read-side suggestion, not a mutation of expense facts.

If a user accepts a suggestion, the settlement command checks the current group version and records the chosen transfer. The server revalidates because another expense may have changed the balance after the suggestion was displayed.

### Deep dive 5: Cache-aside and invalidation

Group summaries, balance projections, and recent activity are cacheable by group and source version. An expense mutation invalidates ledger pages, balances, totals, and activity. The outbox publishes invalidation reliably after commit.

The alternative is cache every query independently without an invalidation graph. That improves hit rate initially but leaves stale totals and balance panels disagreeing. Explicit invalidation groups are more work and easier to test.

### Deep dive 6: Settlement integration

If payment processing is in scope, the settlement service creates a payment intent with the provider and records provider IDs. The internal settlement remains pending until the provider webhook confirms it. Webhooks are idempotent and authenticated.

The product must distinguish “recorded that Alice owes Bob” from “money moved successfully.” Conflating those states makes failed payment retries look like duplicate debt. The ledger of expenses remains separate from external payment status.

### Failure matrix

| Failure | Backend behavior | User-visible state |
|---|---|---|
| Expense request timeout | command lookup | checking or recovered expense |
| Projection lag | preserve expense | stale balance timestamp |
| Version conflict | reject stale revision | review and resubmit |
| Cache unavailable | read source or degrade | slower but correct response |
| Outbox delayed | retry publisher | activity may lag |
| Payment webhook delayed | pending settlement | no false paid state |
| Membership revoked | deny scoped request | access removed |

## Capacity, rollout, and review checkpoints

### Capacity assumptions

I would begin with ordinary groups of a few dozen members, a paginated expense history, and a smaller number of very hot groups. The workload is dominated by writes to hot groups, balance reads, activity reads, and occasional full explanations.

### What I would measure

- Expense command latency and duplicate-command rate.
- Projection lag by group.
- Balance rebuild duration and mismatch count.
- Cache hit rate and invalidation age.
- Version conflict rate for edits.
- Outbox age and worker retry count.
- Settlement provider latency and webhook delay.
- Authorization denials by group and operation.

### Rollout sequence

1. Ship group membership, one-currency expenses, and exact splits.
2. Add idempotency records and audited revisions.
3. Add balance projections and explain endpoints.
4. Add cursor history and cache invalidation groups.
5. Add settlements as explicit records.
6. Add payment providers, offline writes, and group partitioning only after conflict behavior is proven.

### Alternative architecture review

A mutable balance table gives cheap reads, but it makes corrections and retries difficult to audit. Facts plus projections cost worker capacity and temporary staleness, but every number remains explainable.

Synchronous balance derivation is acceptable for small groups and useful as a rebuild path. It becomes too expensive for hot groups or long histories, so the projection is the default read path with source version metadata.

An offline command queue can improve capture, but it requires resolving membership, edits, and duplicates after reconnect. Persisted drafts provide much of the user value without claiming an uncommitted financial fact.

### Backend interview checkpoints

I trace an expense from authorization to atomic facts, outbox event, projection, cache invalidation, and balance explanation.

I explain why a duplicate command returns the original result and why a stale edit becomes a conflict.

I distinguish “recorded debt” from “payment completed.”

I close by returning to exact money, rebuildable balances, and scoped authorization.

## Scalability and operations

The first bottleneck is unbounded expense history and balance recomputation. Cursor pagination and projections address both. The second is hot groups with many concurrent edits. Group versions, serialized command processing where needed, and partitioned events prevent lost updates.

Scale API nodes horizontally. Partition event work by group ID so ordering is stable. Keep recent projections in cache with source versions. Archive old audit and expense records without removing the facts required for balance reconstruction.

## Security and observability

Authorization is checked for every group-scoped command and query. Roles distinguish member, admin, and settlement capabilities. Cache keys include group and viewer scope. Logs avoid expense notes and amounts unless explicitly protected diagnostics require them.

Metrics include command latency, duplicate-command rate, projection lag, balance rebuild duration, conflict rate, cache hit rate, outbox age, settlement provider latency, and authorization denials.

## Testing and correctness review

I would test equal splits with remainder cents, percentages at precision limits, duplicate commands, concurrent edits, projection replay, cache invalidation, membership revocation, and settlement provider retries.

The acceptance criteria are exact totals, idempotent expense and settlement commands, explainable balances, visible projection freshness, and no unauthorized group data in cache or responses.

## Implementation sequence

1. Define group membership, currency, expense, split, and settlement invariants.
2. Add atomic expense commands with stable idempotency keys.
3. Add exact balance derivation and a rebuildable projection.
4. Add cursor ledger reads and explain endpoints.
5. Add outbox invalidation and cache versioning.
6. Add audited edits, settlements, and provider status.
7. Add hot-group partitioning only after conflict metrics are known.

The sequence makes the source of truth explicit before adding speed-focused caches. It also makes a rebuild path available before operational scale increases.

## Interview walkthrough: one expense

The API authenticates the member, validates exact split amounts, and writes expense, splits, audit, idempotency, and outbox records in one transaction. The response contains canonical amounts.

A worker updates the group balance projection. A cache invalidation refreshes ledger, balances, totals, and activity. If the request times out, the command key returns the original result.

If another member edits the group before a retry, the version conflict is explicit. The user reviews the canonical state rather than silently overwriting it.

This scenario demonstrates why the ledger is authoritative while projections and caches are optimizations.

## Further design decisions

Group versioning protects edits and settlement suggestions from stale reads. A version conflict is preferable to silently changing another member’s expense.

Balance explanations are a first-class API because support and users need to understand a number. They can be generated from projection references rather than scanning every expense on every request.

The cache key includes group, viewer scope, currency, and source version where useful. Membership removal invalidates cached group data immediately.

The expense ledger, projection worker, and settlement service can be independently deployed only after their event and version contracts are stable. An iframe boundary is irrelevant to this backend ownership problem.

The production review asks whether a balance can be rebuilt, whether a retry can duplicate a fact, and whether an unauthorized user can infer group data through timing or cache behavior.

### Final questions

- Can every balance be explained?
- What happens after a timeout?
- How are stale edits rejected?
- Which projection is stale?
- What does settlement mean?

The answers should point to facts, versions, idempotency, and scoped authorization.

### Launch gate

The launch gate is exact allocation, atomic expense writes, projection replay, group authorization, and a balance response that identifies its source version.

I would not launch settlement payments until provider webhook idempotency and reconciliation are tested independently from expense recording.

### Final handoff

- Facts are immutable and projections are rebuildable.
- Commands are idempotent and versions are explicit.
- Authorization is enforced at every group boundary.
- Stale data is visible rather than silently corrected.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Balance truth | facts plus projection | mutable balance only | explainability and repair |
| Money | integer minor units | floating point | exact totals |
| Retry | server idempotency key | disabled button | survives transport retries |
| History | cursor pagination | full group download | bounded reads |
| Updates | versioned conflict | silent last-write-wins | protects shared edits |
| Suggestions | read-side graph algorithm | mutate balances | facts remain authoritative |
| Cache | explicit invalidation groups | independent TTL only | consistent panels |

## Closing — 3 minutes

The system treats expenses and settlements as durable facts, derives balances through idempotent projections, and exposes canonical amounts and versions through typed APIs. The frontend can preview splits and display pending state, but the backend owns authorization, money math, and final balance truth.

I would ship group membership, one-currency expenses, exact allocation, cursor history, balance projection, and idempotent commands first. Then I would add settlement provider integration, offline mutation replay, multi-currency support, and group partitioning only after their consistency contracts are explicit.
