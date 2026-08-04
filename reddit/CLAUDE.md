# Reddit — Development with Claude

## Project Context

Reddit looks like a CRUD app until you notice that its two central data structures both fight the relational model. The first is the comment tree: arbitrarily deep, read far more often than written, and always fetched as a *whole subtree* rather than a row. The second is the feed, which is not a query over posts but a query over a *derived score* that changes continuously as votes arrive and as time passes — even for posts nobody has touched.

That second property is the one that shapes everything. A post's "hot" rank decays with age, so the correct ordering changes every second whether or not any user acts. You cannot compute it at read time across a whole subreddit without scanning and sorting every candidate row on every page load, and you cannot compute it purely at write time because there is no write when time passes. The design here splits the difference: `hot_score` is a materialized `DOUBLE PRECISION` column, refreshed on vote and swept periodically by a worker, so feed reads become a plain index scan on `(subreddit_id, hot_score DESC)`.

**Learning goals:** materialized-path storage for unbounded comment trees, the trade-off between synchronous and asynchronous vote aggregation, why Reddit's log-scale hot formula behaves the way it does, and how to make a time-decaying ranking cheap to read.

## Architecture at a Glance (what actually runs)

| Component | Port / How it starts | Why this one |
|-----------|---------------------|--------------|
| **API server** (`backend/src/index.ts`) | **3001** (`npm run dev` → `PORT=3001 tsx watch`) | Single Express process; `dev:server1/2/3` also exist on 3001–3003 for multi-instance experiments |
| **Vote aggregator** (`backend/src/workers/voteAggregator.ts`) | `npm run dev:worker`, 5s loop | Backstop sweeper that re-tallies anything voted on in the last minute |
| **Ranking calculator** (`backend/src/workers/rankingCalculator.ts`) | `npm run dev:ranking`, 60s loop | Recomputes `hot_score` for all posts <7 days old, so time-decay applies without writes |
| **PostgreSQL 16** | 5432 (`reddit`/`reddit_password`, db `reddit`) | Everything: `users`, `sessions`, `subreddits`, `subscriptions`, `posts`, `comments`, `votes`, `audit_logs` |
| **Valkey 7** | 6379 | Only a per-user vote cache (`vote:{userId}:{type}:{id}`, 1h TTL) and `cacheGet`/`cacheSet` helpers |

Sessions live in the Postgres `sessions` table, not Redis — auth is a cookie (`session`) resolved by `backend/src/middleware/auth.ts` on every request. Ranking math is in `backend/src/utils/ranking.ts`; comment-tree logic in `backend/src/models/comment.ts`; vote handling in `backend/src/models/vote.ts`. Frontend is React 19 + TanStack Router (file-based, including `r.$subreddit.comments.$postId.tsx`) + Zustand + Tailwind, on Vite 5173 proxying `/api` → 3001.

## Key Design Decisions

### 1. `hot_score` is a stored column swept by a worker, not computed at read time

The Reddit hot formula is `sign(score) · log₁₀(max(|score|,1)) + (created_at − 1134028003) / 45000`. The second term is fixed at insert; only the first moves with votes. But ordering by it in SQL means evaluating a `log10` over every candidate row per request — for a 100K-post subreddit that is a full scan plus an in-memory sort on every page load, with no index able to help because the sort key is an expression over mutable columns.

Storing it as a column makes `ORDER BY hot_score DESC LIMIT 25` an index-only walk of `idx_posts_hot_score (subreddit_id, hot_score DESC)`. Two things keep it fresh: `castVote` recomputes it via `updatePostScore` on every vote, and `rankingCalculator` re-sweeps all posts newer than 7 days every 60 seconds. The 7-day window is what makes the sweep bounded — the log term for an old post would have to change by a full order of magnitude to reorder it against the `seconds/45000` term, which for anything week-old is effectively never.

What we give up: rank is stale by up to 60 seconds for posts whose *only* change is the passage of time, and the sweep is a full `UPDATE` per row rather than a batched statement — fine at seed scale, quadratic-feeling at real scale.

### 2. Materialized path over adjacency-list recursion for comments

Comments store `path VARCHAR(255)` like `"12.47.103"` plus a denormalized `depth`, indexed with `varchar_pattern_ops` so `WHERE path LIKE '12.47.%'` is a range scan rather than a sequential filter. `getCommentSubtree` is therefore one query at any depth.

The alternative — pure adjacency list with `parent_id` — needs a recursive CTE, and its cost is one index probe *per level*: a 15-deep thread is 15 sequential round trips that cannot be parallelized because each level's IDs are the input to the next. Latency scales with thread depth, which is exactly the dimension that makes a thread interesting.

The costs are real. `VARCHAR(255)` caps depth at roughly 40–60 levels depending on ID width, and creating a comment takes two statements inside a transaction (INSERT with `path = ''`, then UPDATE once the serial ID is known) because the path contains the row's own ID. Moving a subtree would mean rewriting every descendant's path — acceptable only because comments are never re-parented here.

### 3. Votes aggregate synchronously on write; the worker is a backstop, not the mechanism

This is the decision most likely to be misread from the architecture doc. `castVote` in `models/vote.ts` inserts/updates the vote row *and then immediately* calls `aggregateVotesForTarget`, which re-tallies with a `SUM(CASE ...)` over that target's votes and writes the result back to `posts`. The response therefore carries a correct score, so the UI needs no optimistic reconciliation.

Pure async aggregation — insert the vote, return, let a 5-second worker tally — was the alternative. It removes the write-path `UPDATE`, but it means a user who upvotes watches the counter not move for up to five seconds and reasonably concludes the click was lost. The usual patch is client-side optimistic increment, which then disagrees with the server on the next refetch whenever another user voted in the same window.

What we give up is exactly what async would have bought: a post receiving many votes per second serializes on `UPDATE posts SET ... WHERE id = $1`, since every voter's transaction touches the same row. `aggregateAllVotes` still runs every 5s over anything voted on in the last minute, which repairs drift from failed writes but does nothing for contention. The real fix at scale is Redis `INCR` counters flushed periodically — deliberately not built here, because the point was to feel the contention rather than design around it.

### 4. Vote uniqueness is a database constraint, not application logic

`votes` carries `UNIQUE(user_id, post_id)`, `UNIQUE(user_id, comment_id)`, and a `CHECK` enforcing that exactly one of the two target columns is non-null. Duplicate-vote prevention could have lived in the handler as read-then-write, but that is a textbook race: two concurrent requests from the same user both see no existing vote and both insert, and the user has now voted twice with no error anywhere. The constraint makes that outcome unrepresentable regardless of concurrency or how many API instances are running. The cost is that "change my vote" becomes a SELECT-then-UPDATE rather than an upsert, and that the mutual-exclusion `CHECK` forces the slightly awkward `INSERT ... (user_id, post_id, comment_id) VALUES ($1, $2, NULL, $3)` shape with a dynamically chosen column.

### 5. Feed sorts are SQL expressions; only "hot" gets a materialized column

`ranking.ts` exports five scoring functions, but only `calculateHotScore` is called from application code. `top` is `ORDER BY score DESC` (already a stored column), and `controversial` is an inline SQL `CASE` computing `(ups+downs) · min/max`. Comment "best" sorting is likewise an inlined Wilson lower bound in `listCommentsByPost`.

That asymmetry is deliberate rather than sloppy: `top` and `controversial` are pure functions of columns that only change when a vote arrives, so they need no sweeper and no materialization — they are correct the instant the row is written. Only `hot` has a time term, and only a time term requires a background process. `calculateWilsonScore`, `calculateRisingScore`, `calculateTopScore`, and `calculateControversialScore` are currently unreferenced from routes; they exist for comparison and would need either a stored column or a Redis sorted set before they could back a real feed.

## Current State

Runs end to end: registration and cookie-session login, subreddit creation with auto-subscribe and subscribe/unsubscribe, post submission (text or link) with 300-char title validation, arbitrarily nested comments with best/top/new/controversial sorting, up/down/remove voting on both posts and comments with karma recomputed for the target's author, and hot/new/top/controversial feeds both globally and per-subreddit. Prometheus metrics (`/metrics`) cover vote totals, comment depth histograms, hot-score sweep duration and aggregation lag; `/health`, `/health/live`, `/health/ready` probe Postgres and Redis; graceful shutdown drains in-flight requests with a 30s cap.

Seeded via `npm run db:seed` (`backend/src/db/seed.ts`, **not** `db-seed/seed.sql`, which is an empty placeholder): users `admin`, `alice`, `bob`, `charlie`, `diana`, all with password **`password123`**, plus 5 subreddits, 7 posts, 9 comments including a 3-level thread, and 11 votes.

Simplified or omitted: the home feed is global rather than filtered to your subscriptions; no Redis sorted sets for feed retrieval (all sorting is Postgres); no moderation tools, no rate limiting, no vote fuzzing or brigading defenses; no "load more" pagination for deep comment threads — the whole tree is fetched and assembled in memory by `buildCommentTree`. `shared/retention.ts` defines archival policy and `archiveComments`/`is_archived` exist in the schema, but no archival worker runs.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md. Its "Design Decisions Log → Decision 2: Async Vote Aggregation — *Insert to vote table, background worker aggregates. Rationale: eliminates locks*" described a system that was never built: `castVote` calls `aggregateVotesForTarget` inline, performing exactly the contended `UPDATE` the entry claimed to avoid. Phase 2 was also labelled "In Progress" with all four of its boxes ticked.
- **Illegal partial-index predicate (fixed):** `idx_audit_recent` was declared `ON audit_logs(timestamp DESC) WHERE timestamp > NOW() - INTERVAL '90 days'`. Postgres requires index predicates to be IMMUTABLE, and `NOW()` is not — so the statement failed *during* `docker-entrypoint-initdb.d` execution, aborting schema load. The visible symptom was misleading: the container came up, the API started, and every query failed against a half-created database, which read as a backend connection failure. The predicate was dropped; the index is now unconditional.
- **Login inputs missing `name` attributes (fixed):** `frontend/src/routes/login.tsx` had unnamed `<input>` elements, so the harness's `input[name='username']` selector matched nothing and fell through to the header's search box — credentials were typed into search and login silently never happened. `name="username"` / `name="password"` were added (commit `273d1a0e`).
- **Backend port pinned:** `dev` is `PORT=3001 tsx watch src/index.ts` to match the Vite proxy target in `frontend/vite.config.ts`; `index.ts` still defaults to 3000 if `PORT` is unset, so running `tsx src/index.ts` directly will not be reachable through the proxy.
- **Seed location:** `db-seed/seed.sql` is a placeholder containing only comments — the real fixture is the TypeScript seeder, because bcrypt hashes have to be generated at seed time rather than pasted into SQL.
- **2026-08-03 — the comment tree had no screenshot because the route was unreachable.** `r.$subreddit.tsx` renders **no `<Outlet />`**, but under TanStack's flat file routing it is the parent of `r.$subreddit.comments.$postId.tsx` — so `/r/programming/comments/1` rendered the subreddit listing and the post page could not be reached by any path. Renamed the listing to `r.$subreddit.index.tsx` so the two are siblings under the root. (Identical to the `transactions.tsx` / `transactions.$id.tsx` case in this repo's payment-system.) The 3-level thread that decision 2 is entirely about had never been visible.
- **Seed posts all shared one timestamp.** Every post was inserted at `NOW()`, so the feed read "just now" throughout and — more to the point — every post got an identical time term in the hot formula, leaving the time-decay ranking this project is built around with nothing to order by. Posts now carry ages of 1–52 hours, and `hot_score` is computed from each post's real `created_at` rather than from "now".
- **Screenshots:** 4 → 6, adding the post page with its nested comment thread and a subreddit view.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. The 60s hot-score sweep updates every post from the last 7 days one row at a time. Is a single `UPDATE ... FROM (VALUES ...)` batch the right fix, or does the existence of a sweep at all mean ranking belongs in a Redis sorted set that the API reads directly?
2. Synchronous aggregation gives correct-on-write scores at the cost of row contention on hot posts. Where is the crossover — is it vote *rate* on a single post, or total write throughput, that should trigger the move to Redis counters?
3. `buildCommentTree` loads every comment on a post and assembles the tree in Node. Materialized path makes *partial* subtree fetches cheap, so what is the right unit of pagination — top-level comments with collapsed replies, or a depth cap with explicit "load more" per branch?
4. Karma is recomputed for the author on every single vote against any of their content. Should it instead be a periodic rollup, given nobody needs karma to be second-accurate, and it currently puts an extra two queries on the vote hot path?

## Resources

- [How Reddit ranking algorithms work](https://medium.com/hacking-and-gonzo/how-reddit-ranking-algorithms-work-ef111e33d0d9) — the hot/controversial/best formulas implemented in `ranking.ts`
- [How not to sort by average rating](https://www.evanmiller.org/how-not-to-sort-by-average-rating.html) — the Wilson lower bound used for comment "best"
- [PostgreSQL: partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html) — the IMMUTABLE-predicate rule behind the `idx_audit_recent` bug
- [PostgreSQL: operator classes](https://www.postgresql.org/docs/current/indexes-opclass.html) — why `varchar_pattern_ops` makes `LIKE 'prefix%'` an index range scan
- [PostgreSQL ltree](https://www.postgresql.org/docs/current/ltree.html) — the purpose-built alternative to hand-rolled materialized paths
