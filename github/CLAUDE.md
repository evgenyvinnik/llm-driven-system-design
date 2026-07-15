# GitHub (Code Hosting Platform) — Development with Claude

## Project Context

A code-hosting platform: real Git repositories with browsable file trees and commit history, pull requests with computed diffs and merge/squash/rebase strategies, issues and discussions, and full-text code search. The genuinely hard part is that this is not a CRUD app pretending to host code — it drives **actual bare Git repositories on disk** via `git`, so the source of truth for code is the Git object model, while everything *around* the code (PR state, reviews, issues) lives in Postgres.

**Learning goals:** integrating a real VCS (bare repos, refs, diffs, merge strategies) behind a web API, code-aware search with a custom analyzer, and modeling the collaboration layer (PRs, reviews, issues, discussions) as a relational state machine.

## Architecture at a Glance (what actually runs)

Three datastores plus the filesystem for Git objects — each holds a different kind of truth.

| Store | Role | Why this one |
|-------|------|--------------|
| **PostgreSQL** (`pg`) | Users, repos, pull requests, reviews, issues, labels, discussions, comments, webhooks | ACID relational state machine — a PR's `open → merged/closed` lifecycle and its FK web (repo → PR → review comments) is exactly what SQL is for |
| **Filesystem** (`simple-git`) | Bare Git repositories at `repositories/{owner}/{repo}.git` | Git operations (diff, merge, log, ls-tree, show) require the native object model; reimplementing packfiles over a DB would be pointless |
| **Redis** (`redis` v4) | Sessions (`session:<id>`, 7-day TTL), cache, idempotency keys | Sub-ms session lookups on every authenticated request; TTL handles expiry for free |
| **Elasticsearch** (`@elastic/elasticsearch` 8) | Code search index with a custom `code_analyzer` | Postgres full-text can't split `getUserById` into `get/user/by/id`; a code tokenizer + camelCase filter can |

**Frontend:** React 19 + TanStack Router + Zustand v4 + highlight.js (syntax highlighting) + react-markdown + lucide-react. Auth is a header-based session token (see below).

## Key Design Decisions

### 1. Real bare Git repos via `simple-git`, not a database blob store
`services/git.ts` initializes bare repositories and runs real plumbing (`ls-tree`, `show`, `diff`, `log`, `rev-parse`) by shelling out through `simple-git`. This gives correct diffs, real SHAs, and true merge semantics for free. Trade-off given up: filesystem storage doesn't shard horizontally — at scale you'd route repos across storage servers — and every Git call is a subprocess, so it's not free per request. `isomorphic-git` is a declared dependency but is **not actually used**; all Git work goes through `simple-git`.

### 2. Merges run in a throwaway working clone, then push back to the bare repo
A bare repo has no working tree, so `mergeBranches()` clones it into a temp dir under `.tmp/`, checks out the base branch, applies the chosen strategy (`merge` with a message, `--squash` + commit, or `rebase` then `--ff-only`), pushes the result back to `origin`, and deletes the temp dir in a `finally`. This isolates the merge and keeps the bare repo clean. Trade-off: a full clone per merge is I/O-heavy and slow for large repos — acceptable at learning scale, a bottleneck at real scale where you'd merge in-place with lower-level plumbing.

### 3. Code-aware Elasticsearch analyzer, not Postgres full-text
The ES index defines a `code_analyzer`: a pattern tokenizer splitting on `[^a-zA-Z0-9_]+`, then a `lowercase` + `camelcase_split` filter, so `getUserById` matches queries for `user`, `id`, or `getUserById`. On top of that, `extractSymbols()` regex-scans each file for function/class definitions per language (JS/TS/Python/Java/…) and language is detected from the extension. Trade-off: regex symbol extraction is shallow (no real parser/AST), so it misses some definitions and has no cross-reference/"go to definition" — but it's language-agnostic and cheap to index.

### 4. Header-based session tokens (`X-Session-Id`), not JWT
Login returns a `sessionId` stored in Redis with a 7-day TTL; `authMiddleware` reads it from the `X-Session-Id` header (falling back to a `sessionId` cookie), looks it up in Redis, and attaches the user. The frontend `ApiClient` singleton keeps the token in `localStorage` and sends it as a header on every request. Chosen over JWT for immediate server-side revocation (delete the Redis key) and simplicity. Trade-off: a stateful lookup on every request (vs. stateless JWT) — fine given Redis is already on the hot path.

## Current State

**Implemented and working end-to-end:** repo CRUD with an initial README commit; file-tree browsing, file content, commit history and single-commit view (all from real Git); branches/tags listing; pull requests with computed diffs (`base...head`), review comments, and merge/squash/rebase; issues with labels and comments; discussions with threaded comments; collaborators and repo settings; code search over Elasticsearch with symbol extraction and language detection; session auth (bcrypt + Redis) with a demo seed set; shared circuit breaker, idempotency, audit log, cache, Prometheus metrics, and Pino logging.

**Intentionally omitted:** the Git wire protocol (Smart HTTP / SSH `git clone`/`push` — everything is via the REST API, not `git` over the network), webhook delivery workers with retry (schema exists; delivery is not a durable queue), branch protection rules, CI/status checks, and Git LFS / partial-clone / packfile optimizations.

## Iteration & Repair Log

- **Boilerplate CLAUDE.md replaced (2026-07).** The prior version was a "Phase 1 Completed / Phase 2 In Progress / Phase 4 Pending" checklist. Replaced with the actual architecture and grounded decisions; feature status now lives under Current State, not a fictional roadmap.
- **`isomorphic-git` is an unused dependency.** It's in `backend/package.json` but never imported — `services/git.ts` uses `simple-git` exclusively. `architecture.md` previously claimed both libraries drive Git operations; corrected to `simple-git` only in the same pass as this rewrite.
- **Schema-apply path.** No `migrate.ts` / `db:migrate` script exists. The schema in `backend/src/db/init.sql` is applied via the Postgres `docker-entrypoint-initdb.d` mount (fresh volume only); sample data is loaded with `npm run db:seed` (`src/db/seed.ts`). After a schema change, recreate the volume (`docker-compose down -v`) then reseed.
- **Password normalization.** Seed users (`johndoe`, `janedoe`, `admin`) all use `password123`, hashed with bcrypt (cost 10) in `seed.ts` — consistent with the repo-wide normalized login password.
- **`redis` v4 client**, not `ioredis` — this project uses the `redis` package; connection helpers live in `backend/src/db/redis.ts`.

## Open Questions

1. Merge-by-full-clone is the clearest correctness bottleneck. When does it need to move to in-place three-way merge with lower-level plumbing (or a merge queue), and how do you keep merge isolation without a temp working tree?
2. Symbol search is regex-based. Is the right upgrade a real per-language parser (tree-sitter) for accurate symbols and references, or does that cost outweigh the benefit for a search-only feature?
3. Repos live on one local filesystem. What's the routing/sharding layer that maps `{owner}/{repo}` to a storage node, and where does that mapping live so the API stays stateless?
4. Webhooks are schema-only. What's the minimal durable-delivery design (queue + worker + exponential-backoff retry + delivery log) before they can be called reliable?

## Resources

- [Git Internals — Plumbing and Porcelain](https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain)
- [simple-git](https://github.com/steveukx/git-js) — the library driving all Git operations here
- [Elasticsearch custom analyzers](https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-custom-analyzer.html) — the basis for the code tokenizer
