# Facebook Post Search — Full-Stack System Design Answer

A 45-minute proposal connecting the browser's search experience with reliable indexing and
current authorization. Proposed contracts extend the local implementation.

## 🎯 Start With One User Journey — 4 minutes

> “A user searches for a post, narrows the results, opens one, and goes Back. I want the query to remain clear, pagination to remain coherent, and every returned snippet to be something this viewer may currently read.”

The first version supports keyword/phrase/hashtag search, date/type/author filters,
suggestions, snippets, and continued result pages. Anonymous users search public content;
signed-in viewers can also search permitted friend and private posts.

I would clarify the audience rules before drawing infrastructure. Here Friends means an
accepted relationship. Friends-of-friends, groups, and saved searches are extensions
because they change authorization, not just labels.

Full result search happens on Enter, selection, or Apply. Suggestions can update after a
short typing debounce. That separates frequent draft interaction from the more expensive
committed query.

| Requirement | Proposed contract |
|-------------|-------------------|
| Local input | Immediate typing feedback |
| First useful results | Target within one second on a defined device/network |
| Search API | Healthy p95 below 300 ms, p99 below one second |
| Freshness | Ordinary accepted changes indexed within 10 seconds |
| Availability | 99.9% regional search-serving target |
| Privacy | Current validation before returning protected content |
| Continuity | Bounded stable search session and explicit expiry |
| Recovery | Preserve intent and distinguish failed search from no matches |

Those numbers are goals, not test results. I would also ask whether Back must restore the
same result anchor and whether sharing query intent in a URL is expected. Another viewer
may run the same query and legitimately see different posts.

## 🏗️ Architecture and Scale — 5 minutes

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser: drafts / committed intent / safe snippets              │
│ Account + request identity / bounded result pages               │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Search API: PIT context / current access / ranking              │
└─────────────┬────────────────────────────────────┬──────────────┘
              ▼                                    ▼
┌────────────────────────────┐       ┌────────────────────────────┐
│ Elasticsearch projection   │◀──────│ Canonical SQL + outbox     │
│ PIT + audience tokens      │       │ Versioned index workers    │
└────────────────────────────┘       └────────────────────────────┘
```

The browser owns draft input, committed query state, request generations, safe rendering,
and a bounded result cache. The server owns query semantics, ranking, current access, and
continuation. Index workers own projection progress and repair.

React, TypeScript, TanStack Router, and Zustand fit this UI. PostgreSQL keeps canonical
posts, relationships, and operation results. Elasticsearch supplies text retrieval; Redis
caches graph-derived token sets and explicitly scoped suggestion data.

I would keep these as logical boundaries first. A shared generated API schema can reduce
drift without making every type a shared database entity. The actual demo duplicates its
frontend/backend types and validates environment configuration, not request bodies with
shared Zod schemas.

Assume 100 million daily searchers making five submitted searches each: 500 million
searches per day, about 5,787 per second average and 28,935 at a five-times-average peak.
Four suggestion requests per submission would add up to two billion suggestion requests
before caching and coalescing.

At 100 million new posts per day and 1 KB raw searchable records, raw storage grows by 100
GB per day. Indexed fields, postings, replicas, media, and merge headroom add to that. I
would measure shard/recovery behavior before choosing a fixed cluster size.

| Data boundary | What crosses it |
|---------------|------------------|
| Browser to search API | Committed query/filters and opaque continuation |
| Search to retrieval | Fixed query/ranking context and coarse audience tokens |
| Retrieval to authority | Candidate IDs/revisions for current validation |
| Source to indexing | Durable post revision/tombstone events |
| API to browser | Authorized versioned result, safe snippet, session state |

## 🔍 Deep Dive 1: Query Intent Must Survive Asynchrony — 10 minutes

### Separate what is being edited from what was searched

The user types coffee, submits, and gets results. Then they open Filters and select
Photos. Until Apply, those selections are drafts; they must not silently change the query
used by an existing Load More cursor.

I would keep raw input and draft filters local to the controls. Committing them creates a
new normalized search key and generation. Pagination always uses the captured committed
tuple, even if the user is editing the next query.

| State | Owner | Invariant |
|-------|-------|-----------|
| Query/filter draft | Controls | Editing does not mutate current pagination |
| Committed intent | Route/controller | Query, filters, locale, mode move together |
| Account generation | Auth boundary | Old viewer responses cannot commit |
| First-page request | Search controller | Latest generation wins |
| Next-page request | Session/page controller | At most one request per active cursor |
| Suggestions | Combobox | Options match current draft generation |

A URL can encode committed intent for Back/share. It should not contain access tokens,
private result JSON, or the internal PIT. Normalize filter ordering deterministically,
while preserving punctuation/case when meaningful to the query language.

### Debounce is a load control, not a race solution

A roughly 200 ms suggestion debounce is a reasonable initial value to measure. Enter can
cancel the timer and submit immediately. IME composition needs its own boundary so
intermediate characters are not treated as final input.

Abort obsolete requests to save work, but still check account/search identity when a
response arrives. The transport may ignore cancellation or complete just before it. A
stale result must not be accepted merely because the request once belonged to this
component.

Suppose query A starts, then query B completes first. A's later response is discarded. If
the user logs out while B is in flight, B is also discarded after the account generation
changes. Clearing current state without guarding later commits does not solve either
sequence.

### Give each failure its own UI

First-page failure means the user has no result for this intent. Next-page failure means
some useful results already exist. Suggestion failure does not mean full search is
unavailable.

I would keep separate loading/error states and show an inline retry for a failed
continuation. Keep the committed query visible so the reader knows what the results
describe.

For a different query, my initial UI replaces the result area with a labeled loading
state. Retaining old results is a possible refinement, but they must be labeled as the
previous query. Unlabeled stale cards under a new heading are misleading.

### The backend must support the browser's continuity promise

The server should not call an offset string a stable cursor. Index refreshes can move
records across an offset, and even score-plus-ID continuation can drift if the ranking
context changes.

For the initial in-engine ranker, I would use a short-lived point-in-time search session
with fixed query, sort, social features, and time reference. The server cursor carries its
session and complete continuation sort tuple; the client only stores and returns it.

Changing filters creates a new session. Expiry produces an explicit restart. New posts
become visible on a new search rather than reshuffling a reader's page sequence.

| Choice | Benefit | Cost |
|--------|---------|------|
| ✅ Draft/committed separation | Filter editing cannot mix page meanings | More explicit state |
| ✅ Identity guards plus cancellation | Correct under reordering/account changes | Lifecycle bookkeeping |
| ✅ Stable server search session | Predictable continuation and Back | Expiry and server resource limits |
| ❌ Debounce/abort as sole correctness | Small initial implementation | Old callbacks and mixed cursors still corrupt state |

> “The request identity is shared reasoning across the stack. The browser must know which intent may commit, and the server must know which query context a cursor continues.”

## 🔍 Deep Dive 2: Privacy Includes Every Returned Fragment — 10 minutes

### Efficient filtering and final authority have different jobs

An indexed friends post can carry FRIENDS:author. The viewer supplies tokens for accepted
friends and their own content. Elasticsearch intersects those tokens with the text query
before selecting candidates.

This avoids storing every recipient in every post. A friendship change updates the
reader's eligible token set; the post's stable token need not be rewritten merely because
one friend changed.

But a post's own audience/content change does require projection work. If public becomes
private and indexing fails, the old ES document still looks public. Efficient filtering
over a stale document cannot make that response safe.

I would validate the bounded candidate batch against current posts and relationships.
Require the indexed content revision to match the canonical one before exposing its text
or highlights. Skip deleted, inaccessible, or stale-version candidates.

### Stable index state cannot freeze permission

A point in time deliberately preserves an old search view. That is useful for ranking
continuity, but it makes current validation more necessary, not less.

Keep the retrieval query fixed, scan forward through candidates, and advance the cursor
across examined hits. If current checks remove many rows, overfetch only within a work
budget and report a continuation or partial-work state.

A graph-context revision change may explicitly expire the search session. Do not silently
change its token/ranking query and then pretend the old cursor still describes the same
order.

The privacy contract is evaluated at the current check. The system cannot recall
downloaded content, but new validated responses must honor completed revocations. Active
clients should remove known invalidated content and revalidate protected state on resume.

### Totals, facets, and suggestions must follow that policy

Filtering result cards after retrieval does not fix an unauthorized total or hashtag
aggregation. Those values can reveal hidden topics without showing any full post.

I would initially display verified loaded counts and continuation instead of an
exact-looking candidate total. Any added total/facet API needs current authorization and
an explicit relation/approximation policy.

Shared suggestions come from a public-safe corpus. Personal history is keyed by viewer,
and directory suggestions follow their own visibility rules. Cache keys include every
factor that changes the response; a prefix alone is insufficient for personalized or
authentication-dependent options.

Trending search terms require a publication policy. A search for a private matter should
not automatically become a public suggestion. Time windows, distinct-user counts, and
moderation can reduce noise/disclosure risk, but a frequency threshold alone is not a
formal privacy guarantee.

### Snippets are an untrusted rendering boundary

Search engines often produce highlighted markup, but the post author controls the
surrounding text. The fallback path may also be raw content. Inserting either directly as
HTML can execute content the application did not intend to trust.

I prefer plain text plus typed fragments or ranges. Agree on offset units, validate bounds
and versions, and let React create text nodes and marked spans. A malformed highlight
becomes plain text, not a broken card or unsafe HTML.

If an existing integration requires markup, use explicit HTML encoding and a strict
allowlist through every path, including fallback. A response from our own API is not
inherently sanitized.

| Decision | Benefit | Cost |
|----------|---------|------|
| ✅ Coarse tokens plus current batch validation | Efficient retrieval and revocation correctness | Extra bounded authority work |
| ✅ Structured, versioned snippets | Safe text with meaningful highlights | Cross-stack fragment contract |
| ❌ Trust old index/PIT ACLs | Fast simple serving | Failed restrictions can disclose old text |
| ❌ Treat suggestions/counts as harmless | Easy global caching | Hidden content can leak through metadata |

> “I would not call the system privacy-aware just because the main query has a filter. I would trace every field that leaves the service, including snippets, counts, suggestions, and mutation responses.”

## 🔍 Deep Dive 3: Reliable Writes and a Bounded Reading Experience — 9 minutes

### Separate durable acceptance from search visibility

The author saves a post while Elasticsearch is unavailable. If SQL commits first and the
request then reports failure, a retry may create another post. If the request reports
success without durable repair work, the post can remain missing from search.

The proposed transaction includes source state, an actor-scoped operation receipt, a
monotonic revision, and an outbox event. The client receives canonical acceptance and can
distinguish it from index progress.

A timeout is an unknown outcome, not proof of failure. Retry the same operation ID or read
its result; do not generate a new content operation blindly. An idempotent ES document ID
cannot deduplicate two different SQL post IDs.

Workers apply revisions monotonically and inspect individual bulk results. A stale event
cannot overwrite a newer private audience, and a delayed update cannot resurrect a deleted
post. Deletions need durable tombstones or equivalent retained version state.

For a rebuild, create a new index generation, backfill at a defined boundary, catch up
changes/deletions, validate coverage, and then switch the read alias. Existing search
sessions need bounded overlap or an explicit reset. A bulk upsert of current rows does not
remove orphan index documents.

### The frontend shows meaningful progress, not guessed success

The first search UI need not include a full composer. If post editing is added, show saved
state from its durable receipt and a separate indexing status when relevant. A user can
understand “saved, becoming searchable” better than an ambiguous failed save that actually
committed.

When results later arrive, keep post metadata identity separate from query-specific
snippets. The same post can appear in several searches with different match context; one
global snippet field would overwrite the meaning of another page.

Current content versions matter for rendering as well. Do not combine newly edited text
with old highlight offsets. Revalidate or omit a stale result until a consistent
authorized representation is available.

### Bound resources through the full journey

Start with twenty ordinary text cards and explicit Load More. Add virtualization if
measured accumulated-card work justifies it. Windowing limits mounted DOM, while a
separate page/cache budget limits retained data.

| Resource | Initial policy |
|----------|----------------|
| Result pages | Five pages near the reading anchor, reload within a valid session |
| Private cache | Small account-scoped in-memory budget |
| Suggestions | Current options, short debounce, cancel stale work |
| Media previews if added | Known dimensions, responsive sources, lazy loading |
| PITs | Short idle lifetime and bounded total session age |
| Bulk writes | Bounded batch size with item-level retry state |

If media previews are added, text remains useful when an image fails. Reserve aspect
ratios before loading and limit concurrent media work. The local result UI displays type
icons; it does not render uploaded photos or video players.

On opening a future detail route, retain committed intent, compatible page references,
result anchor, and offset. Back restores content after necessary access revalidation, not
merely a pixel coordinate. Expired sessions rerun under the current viewer with an
explicit reset.

Virtualization changes keyboard and screen-reader behavior because off-screen rows leave
the DOM. Keep a focused row within a small exception budget, or move focus deliberately
before disposal. Do not retain every previously focused row indefinitely.

| Choice | Why it fits | Trade-off |
|--------|-------------|-----------|
| ✅ Durable receipt/outbox | Saved work survives lost replies and ES outages | Worker/storage operations and search lag |
| ✅ Versioned projection and rebuild generation | Older work cannot regress newer state | Tombstone and catch-up lifecycle |
| ✅ Bounded pages and content anchor | Stable resource use and useful Back behavior | Page reload and remeasurement |
| ❌ Inline indexing plus unlimited retained results | Easy demo path | Ambiguous saves and growing resources |

## 🧪 Contracts and Verification — 5 minutes

The API contract should be small enough to explain on a whiteboard:

| Contract | Essential information |
|----------|------------------------|
| Search request | Query, committed filters, opaque cursor; identity from auth |
| Search page | Search/session identity, ordered results, expiry, continuation/partial state |
| Result | Post ID, authorized revision, snippet fragments, action hints |
| Suggestion | Stable option ID, type/scope, label, committed action |
| Mutation receipt | Operation ID, canonical result, index-progress distinction |
| Failure | Invalid intent, unavailable dependency, permission change, or session expiry |

Validate network input at runtime: field types, bounded strings/arrays, enum values,
dates, and positive integer limits. Define date boundaries and timezone semantics
explicitly rather than letting browser dates and backend parsing disagree.

Tests should span the boundary where the failure occurs:

1. Reorder search replies while changing accounts; old state must not commit.
2. Edit filters before Apply, then Load More; the cursor stays with committed intent.
3. Restrict a post while ES is unavailable; old indexed text is denied.
4. Retry a saved post after a lost reply; one canonical content operation exists.
5. Fail one item in a bulk response; the reported repair state names the missing work.
6. Send an old update after deletion; it cannot resurrect content.
7. Return hostile snippet text or wrong highlight ranges; rendering stays safe.
8. Open Back after PIT expiry; the user sees a clear restart.

Use isolated state/contract tests for races and real dependency tests for indexing,
versioning, and query semantics. A login form render and generic main element do not prove
authenticated search or admin authorization.

Observe accepted-write latency, index lag, partial failures, unauthorized/stale candidates
dropped, session resets, request races, and first useful rendered content. A high cache
hit rate can coexist with stale privacy or incomplete results.

A circuit breaker must allow a recovery probe, and its timeout must connect to
cancellation or bounded in-flight work. A health check should describe usable capability,
not report all search paths ready merely because SQL responds.

## 📝 Close and Local Boundary — 2 minutes

> “The browser preserves committed intent and accepts only matching responses. The server provides stable retrieval with current authorization, while durable versioned indexing keeps accepted changes recoverable. Those contracts are more important than adding more caching layers.”

The local implementation has React search/admin views, SQL/Redis sessions, visibility
tokens, one ES ranking query, synchronous indexing, and an offset cursor. It has no shared
request schema, PIT, outbox, revision protocol, safe snippet structure, frontend
virtualizer, or live channel.

Current gaps include stale request/filter state, retained data across logout, raw HTML
snippets, prefix-only suggestion caches, inconsistent post permissions, and SQL/index
split failures. Admin health expects a different response shape, and reindex success
ignores bulk item failures.

The [architecture](./architecture.md#implementation-notes) links those findings to source;
the [README](./README.md) explains the two fixtures and setup. The review ran isolated
source checks, not the full stack or a production benchmark.
