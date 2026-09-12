# GitHub — architecture

## System Overview

This is a proposed code-hosting system with real Git history, repository browsing, pull requests, issues, and searchable code. The central boundary is between immutable code objects, mutable branch references, and relational collaboration state. A reviewer must know which code they approved, and a retry must not publish a different merge. This is a learning design, not a description of GitHub's private infrastructure.

The local implementation is one Express process, PostgreSQL, Valkey, Elasticsearch, host filesystem bare repositories, and a React SPA. It implements parts of these flows but has significant routing, authorization, retry, and consistency gaps. Production sections describe the intended design; the exact existing SQL, local API table, and final Implementation Notes document what is actually present.

## Requirements

### Production scope

- Personal and organization repositories with public/private access and explicit reader, contributor, and maintainer permissions.
- Git fetch/push over authenticated Smart HTTP, plus commit-bound directory and file browsing in the web UI.
- Issues and pull requests with a shared repository number sequence; reviews and inline comments anchored to a specific comparison.
- A merge operation that checks the reviewed head, current base, permission, and required policy, and exposes a recoverable outcome.
- Search over an explicitly identified indexed revision of the default branch. A stale index must not grant access to private code.

Start with merge commits and same-repository pull requests. Squash/rebase, fork pull requests, webhook subscriptions, and SSH transport are extensions once the publication boundary is dependable. CI execution, a browser editor, live collaborative editing, Git LFS, and global code intelligence are outside the initial scope.

### Production targets and invariants

| Area | Proposed target / contract |
|------|----------------------------|
| Metadata reads | 99.9% availability; p95 below 200 ms within a region |
| Bounded file/diff views | p95 first useful content below 1 s for admitted small files; explicit limits for large inputs |
| Code search | p95 below 500 ms; p95 indexing lag below 60 s under admitted load |
| Merge | Exactly the admitted head/base comparison or an explicit conflict; pending until publication is reconciled |
| Durability | Acknowledged ref updates survive a storage-node failure within the configured replica failure model |
| Privacy | Current authorization before code, metadata, snippets, or cached responses are returned |
| UI | Stable revision context, preserved review drafts, keyboard-accessible browsing, bounded rendering work |

These are design targets, not measurements. Clone duration depends on transferred bytes and history complexity. “Zero data loss” without a failure model would conceal the need for independent backups and tested disaster recovery.

## Capacity Estimation

Illustrative assumptions at a mature deployment, using decimal units:

| Quantity | Assumption | Implication |
|----------|------------|-------------|
| Git storage | 200M repositories, mean 150 MB packed | 30 PB primary bytes; about 90 PB with three copies, before backups |
| Browser/API reads | 100M/day | About 1,157/s average, 11,574/s at an assumed 10× peak |
| Pushes | 10M/day, mean 1 MB new objects | About 116/s average and 10 TB/day ingress before replication |
| Code index | 1B eligible default-branch files, mean 10 KB | 10 TB raw text; index expansion must be measured separately |
| Merge jobs | 500K/day | About 5.8/s average; repository-local contention can dominate global averages |

Repository size and popularity are highly skewed. A single large repository can consume more pack-generation CPU or merge workspace than thousands of small ones. Admission budgets therefore include bytes, object count, CPU time, and per-repository concurrency, not just request rate.

### Local Development Scale

One browser, one backend, PostgreSQL, Valkey, and a single Elasticsearch node are sufficient to inspect the demo. Compose assigns Elasticsearch a 512 MB JVM heap; this is not its complete process memory budget. The five TypeScript-seeded repositories contain short README commits. No benchmark establishes production capacity or latency.

## High-Level Architecture

Production proposal; Git transport and the browser API share authorization and repository routing:

```text
┌────────────────────────────────────┐
│ Browser / Git CLI                  │
│ Web API and Git transport          │
└────────────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────┐     ┌────────────────────────────────────┐
│ Gateway + repository/review API    │────▶│ Git storage service                │
│ Authentication, policy, intents    │     │ Fenced writer, objects, refs       │
└────────────────────────────────────┘     └────────────────────────────────────┘
                   │                                          │
                   ▼                                          ▼
┌────────────────────────────────────┐     ┌────────────────────────────────────┐
│ PostgreSQL                         │────▶│ Durable event processing           │
│ Metadata, receipts, outbox         │     │ Reconciliation, indexing, search   │
└────────────────────────────────────┘     └────────────────────────────────────┘
```

The storage service maintains replicated Git objects and an authoritative durable command history for ref publication and operation receipts. Filesystem refs are managed behind that boundary. SQL holds collaboration state; a reconciler projects storage results back to pending merge intents. Redis accelerates metadata and content lookup but does not decide access or merge outcomes. CDN delivery of private content must also enforce authorization before a cache hit.

## Core Components / Request Flows

### Repository browsing

1. Resolve a repository identity and check current read permission.
2. Resolve the requested branch to an immutable commit ID once for this browsing context.
3. Fetch immediate children for the requested directory and file bytes at that commit. Return explicit encoding, size, truncation, and object identity.
4. Key derived caches by repository, commit/object ID, path, and representation version. A branch-name lookup has a short freshness contract; immutable object bytes are a different cache category.
5. Keep the displayed commit while navigating. Offer a visible “new commits available” action rather than silently replacing the code beneath a reader.

The browser loads directories on demand and bounds wide directories, long lines, and file bytes before syntax highlighting. A worker can tokenize bounded content without monopolizing the UI thread. Virtualization limits mounted rows; it does not limit bytes downloaded or parsing cost. Paginated file views remain available for copying, browser find, and assistive technology.

A comparison is identified by base commit, head commit, merge base, and diff options/version. Inline anchors include old/new paths, side, and source line or range. A patch's displayed row number is not a source line. Renames and binary files have explicit metadata; an unresolvable old anchor remains attached to its original revision as outdated.

### Git push and storage ownership

A Git protocol gateway authenticates the transport, checks repository/ref permissions, and streams a bounded pack into quarantine. Workers verify object integrity, connectivity, size limits, and policy. Received code is data: the service does not execute repository hooks or code during browsing/indexing.

Before acknowledging a ref update, all referenced objects must meet the durability policy. One fenced repository writer conditionally publishes the expected old ref to the new object ID and durably records the operation result. Losing the writer's lease prevents further accepted writes; a replacement must recover the command history before serving mutations. Simply pointing multiple Express instances at a shared folder does not supply this protocol.

Content addressing permits reuse within an object database; separate repositories do not automatically share storage. A managed fork object pool is a possible optimization, with ownership and reachability accounting. It is not a reason to promise global deduplication or to let one fork's deletion remove another's reachable objects.

### Pull request review and merge

The API returns a comparison revision and the current PR version. A review submission names that exact head/comparison and a client request key. The server validates every anchor and stores the review, comments, receipt, and event in one SQL transaction. If newer commits exist, the old review can remain historical but cannot silently approve them.

For a merge, the server checks current authorization, PR state, required reviews/statuses, and the expected head/base and policy version. It durably accepts a merge intent and reserves that PR against incompatible close/merge changes. Permission is evaluated when the operation is accepted; later revocation stops new operations but does not retroactively undo an accepted publication. Policy changes and operation admission follow the same repository coordination order.

A worker builds a candidate commit from the admitted immutable inputs. The repository writer verifies that the named head and base still match, then publishes the base ref and storage-side receipt as one authoritative recorded command. A normal fast-forward push is not equivalent to checking the user's expected old base. Git supplies conditional ref-update primitives, but replication, receipts, fencing, and SQL reconciliation are additional service responsibilities. [Git reference update semantics](https://git-scm.com/docs/git-update-ref).

Finally, the coordinator records the published result in SQL, releases the reservation, and emits its outbox event. The UI can show `merging` while this projection is pending. If the process crashes after publication, recovery asks the storage service about the same operation ID; it does not rerun a merge or infer success merely from the branch's current tip, which may have advanced again. Conflicts are terminal results for that admitted comparison. Recomputing against newer inputs requires a new confirmed attempt.

### Search indexing and reading

Durable ref events identify repository, generation, before/after commits, and sequence. An index worker resolves files at the event's immutable commit, applies byte/type limits before heavy parsing, and records indexed commit IDs. Changed and deleted paths are reconciled with versioned writes/tombstones. A late worker cannot restore a deleted repository or replace newer file content. Rebuilds use a new index generation and catch up from a retained event position before switching.

Repository access filters narrow candidates, then the query API verifies current permission before returning paths or snippets. This second check handles public-to-private changes during index lag. Search totals must reflect the permitted scope or be omitted/qualified; filtering only displayed hits while reporting global totals still leaks information.

Return escaped text plus match ranges and a commit-bound URL. The browser labels the indexed revision rather than linking every result to today's `main`. Cursor/PIT pagination preserves a bounded ranking context, not permanent permission: current access is checked on every page. Search failure is distinct from a successful empty result.

## Database Schema

### Exact local PostgreSQL schema

The following is the complete existing [initialization SQL](./backend/src/db/init.sql), including 23 tables and 17 explicit secondary indexes. Primary and unique constraints create additional indexes. There are no triggers or migration runner. Several tables describe planned features and have no operational callers.

```sql
-- GitHub Clone Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  bio TEXT,
  avatar_url VARCHAR(500),
  location VARCHAR(255),
  company VARCHAR(255),
  website VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  description TEXT,
  avatar_url VARCHAR(500),
  website VARCHAR(500),
  location VARCHAR(255),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Organization members
CREATE TABLE IF NOT EXISTS organization_members (
  id SERIAL PRIMARY KEY,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'member',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

-- Repositories table
CREATE TABLE IF NOT EXISTS repositories (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  org_id INTEGER REFERENCES organizations(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_private BOOLEAN DEFAULT FALSE,
  default_branch VARCHAR(100) DEFAULT 'main',
  storage_path VARCHAR(500),
  language VARCHAR(50),
  stars_count INTEGER DEFAULT 0,
  forks_count INTEGER DEFAULT 0,
  watchers_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_user_repo UNIQUE(owner_id, name),
  CONSTRAINT unique_org_repo UNIQUE(org_id, name),
  CONSTRAINT owner_or_org CHECK (
    (owner_id IS NOT NULL AND org_id IS NULL) OR
    (owner_id IS NULL AND org_id IS NOT NULL)
  )
);

-- Repository collaborators
CREATE TABLE IF NOT EXISTS collaborators (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(20) DEFAULT 'read',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repo_id, user_id)
);

-- Stars
CREATE TABLE IF NOT EXISTS stars (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, repo_id)
);

-- Forks
CREATE TABLE IF NOT EXISTS forks (
  id SERIAL PRIMARY KEY,
  source_repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  forked_repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Issues table
CREATE TABLE IF NOT EXISTS issues (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  state VARCHAR(20) DEFAULT 'open',
  author_id INTEGER REFERENCES users(id),
  assignee_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  UNIQUE(repo_id, number)
);

-- Labels table
CREATE TABLE IF NOT EXISTS labels (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  color VARCHAR(7) DEFAULT '#1a73e8',
  description TEXT,
  UNIQUE(repo_id, name)
);

-- Issue labels junction
CREATE TABLE IF NOT EXISTS issue_labels (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  label_id INTEGER REFERENCES labels(id) ON DELETE CASCADE,
  UNIQUE(issue_id, label_id)
);

-- Pull Requests table
CREATE TABLE IF NOT EXISTS pull_requests (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  state VARCHAR(20) DEFAULT 'open',
  head_branch VARCHAR(100) NOT NULL,
  head_sha VARCHAR(40),
  base_branch VARCHAR(100) NOT NULL,
  base_sha VARCHAR(40),
  author_id INTEGER REFERENCES users(id),
  merged_by INTEGER REFERENCES users(id),
  merged_at TIMESTAMP,
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  changed_files INTEGER DEFAULT 0,
  is_draft BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  UNIQUE(repo_id, number)
);

-- PR labels junction
CREATE TABLE IF NOT EXISTS pr_labels (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  label_id INTEGER REFERENCES labels(id) ON DELETE CASCADE,
  UNIQUE(pr_id, label_id)
);

-- PR Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  reviewer_id INTEGER REFERENCES users(id),
  state VARCHAR(20),
  body TEXT,
  commit_sha VARCHAR(40),
  created_at TIMESTAMP DEFAULT NOW()
);

-- PR Review Comments (inline comments)
CREATE TABLE IF NOT EXISTS review_comments (
  id SERIAL PRIMARY KEY,
  review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  path VARCHAR(500),
  line INTEGER,
  side VARCHAR(10),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Comments (for issues and PRs)
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT issue_or_pr CHECK (
    (issue_id IS NOT NULL AND pr_id IS NULL) OR
    (issue_id IS NULL AND pr_id IS NOT NULL)
  )
);

-- Discussions
CREATE TABLE IF NOT EXISTS discussions (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  category VARCHAR(50),
  author_id INTEGER REFERENCES users(id),
  is_answered BOOLEAN DEFAULT FALSE,
  answer_comment_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repo_id, number)
);

-- Discussion comments
CREATE TABLE IF NOT EXISTS discussion_comments (
  id SERIAL PRIMARY KEY,
  discussion_id INTEGER REFERENCES discussions(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  parent_id INTEGER REFERENCES discussion_comments(id),
  body TEXT NOT NULL,
  upvotes INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Webhooks
CREATE TABLE IF NOT EXISTS webhooks (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  url VARCHAR(500) NOT NULL,
  secret VARCHAR(100),
  events TEXT[],
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Webhook deliveries log
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER REFERENCES webhooks(id) ON DELETE CASCADE,
  event VARCHAR(50),
  payload JSONB,
  response_status INTEGER,
  response_body TEXT,
  duration_ms INTEGER,
  attempt INTEGER DEFAULT 1,
  delivered_at TIMESTAMP DEFAULT NOW()
);

-- Sessions table for authentication
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  data JSONB,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50),
  title VARCHAR(255),
  message TEXT,
  url VARCHAR(500),
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_repos_owner ON repositories(owner_id);
CREATE INDEX IF NOT EXISTS idx_repos_org ON repositories(org_id);
CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_id);
CREATE INDEX IF NOT EXISTS idx_issues_author ON issues(author_id);
CREATE INDEX IF NOT EXISTS idx_prs_repo ON pull_requests(repo_id);
CREATE INDEX IF NOT EXISTS idx_prs_author ON pull_requests(author_id);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_comments_pr ON comments(pr_id);
CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_id);
CREATE INDEX IF NOT EXISTS idx_stars_user ON stars(user_id);
CREATE INDEX IF NOT EXISTS idx_stars_repo ON stars(repo_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- Audit log table for security-sensitive operations
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(100),
  ip_address INET,
  user_agent TEXT,
  request_id VARCHAR(64),
  details JSONB DEFAULT '{}',
  outcome VARCHAR(20) DEFAULT 'success'
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

-- Idempotency keys table for preventing duplicate operations
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  operation_type VARCHAR(50) NOT NULL,
  resource_id INTEGER,
  response_body JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);

```

### Production schema additions

The local schema is not sufficient for the guarantees above. These are proposed changes, not existing migrations:

| Entity | Important additions / constraints |
|--------|------------------------------------|
| Repository | Stable namespace identity, lifecycle/access generation, storage placement and writer epoch |
| Issue/PR identity | One locked counter and a shared repository-number registry; uniqueness across both types |
| Pull request | Revision, comparison commits, admitted merge operation, publication/result state and merged commit ID |
| Review/inline comment | Immutable comparison identity, validated path/side/range, and outdated status |
| Request receipt | Actor + repository + operation + client key, payload digest, terminal response and retention boundary |
| Merge intent | Expected head/base, policy version, candidate object ID, storage operation ID and recoverable state |
| Outbox/index progress | Unique event ID, repository sequence/generation, delivery state and consumer position |

The current `(repo_id, number)` uniqueness exists separately on issues and pull requests. Two concurrent creators can both read the same maxima; different tables can accept the same number. The existing ownership XOR check preserves user-versus-organization identity, but most local routes only resolve user-owned repositories.

## API Design

### Implemented local API

All paths below are local `/api` routes. Their existence does not imply complete authorization or a reachable UI.

| Method | Path / family | Actual behavior |
|--------|---------------|-----------------|
| POST / GET | `/api/auth/register`, `/login`, `/logout`; GET `/api/auth/me` | Header session authentication; logout is POST |
| GET / POST | `/api/repos` | List public plus caller-owned repositories; create personal repository |
| GET / PATCH / DELETE | `/api/repos/:owner/:repo` | Detail checks private owner; update/delete require owner |
| GET | `/api/repos/:owner/:repo/tree/:ref(*)?path=...` | Immediate directory children; missing private check |
| GET | `/api/repos/:owner/:repo/blob/:ref/:path(*)` | String content; no binary/size contract or private check |
| GET | `/api/repos/:owner/:repo/branches`, `/tags`, `/commits`, `/commit/:sha` | Git reads; no shared read-permission enforcement |
| POST / DELETE / GET | `/api/repos/:owner/:repo/star`; GET `/starred` | Current user's desired star state; no repository access check |
| POST | `/api/repos/:owner/:repo/push` | Authenticated cache invalidation only; no write-role check or indexing |
| GET / POST | `/api/:owner/:repo/pulls`, `/issues`, `/discussions` | List/create; creations require login, not repository permission |
| GET / PATCH | `/api/:owner/:repo/pulls/:number`, `/issues/:number` | Details/updates; PR update checks author, issue update checks only login |
| GET / POST | `/api/:owner/:repo/pulls/:number/diff`, `/merge`, `/reviews` | GET diff, POST merge/review; no required-review or expected-SHA gate |
| GET / POST | PR `/comments` | Ordinary conversation comments, not inline review comments |
| POST | Issue `/comments`; discussion `/comments`, `/answer`, `/comments/:commentId/upvote` | Basic writes; answer checks author/owner, parent/answer membership is incomplete |
| GET / POST | `/api/:owner/:repo/labels` | List; owner-only create |
| GET / PATCH | `/api/users/:username`; PATCH `/api/users/me` | Public profile includes email; update does not refresh session copy |
| GET | `/api/users/:username/repos`, `/starred` | Public repositories only, including when viewing one's own account |
| POST / GET | `/api/users/orgs`, `/api/users/orgs/:name`, `/api/users/orgs/:name/repos` | Partial organization API; GET `/orgs` is shadowed by `/:username` |
| GET | `/api/search`, `/code`, `/symbols` | SQL combined search; Elasticsearch code/symbol search without ACL hydration |
| GET / POST | `/api/admin/audit-logs`, `/circuit-breakers`, POST `/circuit-breakers/:name/reset` | Admin-only operational APIs |

There are no collaborator management, organization membership management, outbound webhook configuration/delivery, fork, branch creation, or Git transport routes. Proposed production endpoints would add explicit resolved commits, bounded cursors, comparison IDs, request keys, structured errors, merge-operation lookup, and transport authorization. A merge acceptance returns a pending operation; its result endpoint distinguishes conflict, published, and unresolved work.

## Key Design Decisions

### Separate immutable code from mutable references

Git objects fit an immutable object graph; reviews, permissions, and issue state fit relational transactions. Native Git workers avoid rebuilding history traversal and merge algorithms, while a dedicated storage service owns durable ref publication. Storing Git byte blobs in SQL alone would not implement Git protocols, object connectivity, or pack negotiation. Conversely, a filesystem write cannot atomically commit a SQL review record. The cost is an explicit recovery protocol between the two authorities.

### Pin browsing and review to commits

A branch is convenient navigation, but its meaning changes. Caching `main/file.ts` for an hour can show a new directory listing beside old file contents. A comparison keyed only by PR number can display a previous diff after a force push. Resolving commits and including all diff inputs in the key lets derived artifacts be reused without changing their meaning. The cost is retaining old objects/diffs for the review retention window and explicitly refreshing branch views.

### Recover merge publication instead of retrying arbitrary side effects

A database transaction cannot roll back a pushed Git ref. A durable intent plus an operation receipt at the storage authority makes a lost response recoverable, even after later branch updates. This adds a pending state, a reconciler, storage protocol work, and operational alerts. That complexity is justified because duplicate or misattributed merges change shared history. For an ordinary issue comment, a single SQL transaction with a properly claimed request key is sufficient.

### Search is a derived view with current access checks

An inverted index supports cross-repository retrieval without scanning every Git file per query. Identifier analysis and optional parser-based symbols help code-specific queries; a relational database can also index tokens when the corpus is smaller, so this is a workload and operational choice, not an absolute language limitation. The cost of a separate index is freshness lag, reconciliation, and privacy-aware hydration. Exact code retrieval remains commit-bound Git access.

## Consistency and Idempotency

Production SQL mutations atomically claim a scoped request key and compare its payload digest before performing the mutation. A matching retry returns the original result; changed payload is a conflict. Concurrent claims wait or return a pending receipt, rather than both executing and ignoring the second key insert. Retain receipts for an explicit supported retry window, for example seven days; an expired operation requires user-visible recovery rather than silently creating a new merge.

Merge receipts have a different effect boundary: storage must record whether the ref publication occurred. SQL intent/outbox transactions alone cannot prove that fact. The event path is at least once; consumers deduplicate by event ID and apply repository sequence/generation rules. Search indexing and notifications may lag acknowledged core writes.

A star is a desired state on `(user, repository)`. The production transaction changes that relationship and updates its count only when membership changes, or uses an asynchronous projection with reconciliation. It does not implement a retried “toggle,” and fixture popularity counts must not be presented as exact relationship totals.

## Security / Auth

Use server-side sessions with secure cookies and CSRF protection for the browser, and separately scoped credentials for Git transport. Enforce current repository read/write/maintain policy consistently before metadata, Git bytes, cached artifacts, search snippets, and operation receipts. The authenticated identity and resource context belong in idempotency scope.

Validate namespace names, Git refs, paths, and object reachability. Resolve host storage by stable repository identity inside a contained root; do not interpolate unvalidated account names into filesystem paths. Bound Git subprocess CPU, wall time, output bytes, and concurrency. Do not interpret repository files as executable server configuration. HTML rendering escapes source text and validates any permitted Markdown links/HTML.

An optional webhook worker needs destination validation, safe DNS/redirect handling, bounded responses, per-destination concurrency, payload signatures, and stable delivery IDs. At-least-once delivery requires receivers to deduplicate; HMAC authenticates bytes but does not prevent a duplicate side effect. These are proposed integrations, not implemented local behavior.

## Observability

Production measures browser time to first file/diff, long tasks, request bytes, Git queue wait/CPU, failed ref comparisons, pending merge age, storage/SQL reconciliation lag, search generation/lag, permission-filtered candidates, and backup restore success. A successful HTTP response or an empty diff is not enough to establish code correctness. Keep repository/user IDs out of unbounded metric labels; include them in access-controlled logs when necessary.

Local wiring includes Pino request completion logs, selected best-effort SQL audit writes, HTTP/cache metrics, and Git breaker events. CI and webhook metrics are defined but have no producers. `/health` and `/health/ready` check PostgreSQL and Redis sequentially; neither checks Elasticsearch, Git directories, disk capacity, or subprocess availability. `/health/live` reports a responsive handler, not complete readiness.

## Failure Handling

| Failure | Proposed response |
|---------|-------------------|
| Storage writer lost | Fence it, recover a quorum-backed command history, and pause mutations until ownership is safe |
| Merge times out after publication | Show pending; query the same durable storage operation and reconcile SQL |
| Base or head moves | Reject the admitted comparison; require a new merge attempt after refresh |
| Search unavailable or delayed | Keep Git/metadata available; show search failure or indexed revision/lag explicitly |
| Cache unavailable | Use bounded primary reads; do not bypass current authorization |
| Huge file, pack, diff, or adversarial syntax | Reject/truncate clearly or queue bounded work; preserve useful metadata |
| Repository deleted during indexing | A newer lifecycle generation/tombstone prevents publication of stale index writes |

Timeouts must propagate cancellation where the underlying operation supports it. A promise timeout alone leaves a Git subprocess running. Admission control and job isolation limit the harm when cancellation is not reliable. Restore exercises must cover both Git objects/refs and relational metadata; their independent backups need a documented reconciliation point.

## Scalability Considerations

Scale API processes separately from Git worker pools. Route repositories through a placement map so large or popular repositories can move independently; do not assume uniform hashing solves their skew. Immutable objects can have read replicas, while ref mutations retain one authority per repository. Increase storage/network capacity before adding enough processes to saturate the same disk.

Cache commit-bound trees/blobs/diffs, cap outstanding Git jobs, and avoid a fresh full working clone for every repeated comparison. Isolate expensive merge work from interactive reads. Shard collaboration data by repository once a single database's measured write load demands it; global user/search views become derived projections. Search partitions and replicas follow measured corpus size and query fan-out, with a separate strategy for exceptionally large repositories.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Git data | Native object graph behind storage service | SQL blobs alone | Preserves Git semantics and a clear publication authority |
| File/diff identity | Immutable commits and comparison inputs | Moving branch/PR-only keys | Stable browsing and review meaning |
| Merge result | Durable intent plus storage receipt | Git push followed by assumed SQL atomicity | Recoverable lost responses and partial completion |
| Collaboration | SQL transactions and scoped receipts | Independent insert/check/store calls | Correct retries and shared numbering |
| Code search | Derived inverted index plus current authorization | Git scan per global query | Bounded retrieval without granting stale access |
| Large views | Bounded payloads and progressive/virtual rendering | Download and render everything | Controls transfer, parsing, DOM, and memory separately |

## Implementation Notes

### What actually runs

[Express entry point](./backend/src/index.ts) mounts REST route modules in one process. [Git service](./backend/src/services/git.ts) shells out through simple-git against bare repositories under `REPOS_PATH`, defaulting to `repositories` in the process working directory. The database's `storage_path` is recorded but Git reads reconstruct the owner/name path. No Git protocol server, queue, worker process, storage replication, or distributed lock is started.

[Compose](./docker-compose.yml) runs PostgreSQL 16, Valkey 7, and Elasticsearch 8.12.0. PostgreSQL has a 20-connection pool and two-second connection timeout, without a statement timeout. node-redis connects through a top-level await; Redis can therefore block startup before the server listens. Elasticsearch initialization is caught and logged, so the API can start without it, but repository deletion still calls Elasticsearch before removing its SQL row.

### Production patterns actually wired, with their limits

| Pattern | Source and actual scope |
|---------|-------------------------|
| Circuit breaker | [circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts): shared per Git operation class, 30 s timeout/reset, 50% threshold, minimum five calls |
| Cache-aside | [cache.ts](./backend/src/shared/cache.ts): Redis JSON values and SCAN-based invalidation; errors return misses/false rather than enforced recovery |
| SQL creation transaction | [idempotency.ts](./backend/src/shared/idempotency.ts): issue/PR row and optional receipt insert share a transaction |
| Metrics | [metrics.ts](./backend/src/shared/metrics.ts): HTTP finish, cache success and Git breaker events; defined integrations can remain unused |
| Request/audit logs | [logger.ts](./backend/src/shared/logger.ts), [audit.ts](./backend/src/shared/audit.ts): request IDs, Pino, selected non-transactional best-effort audit events |
| Session auth | [auth.ts](./backend/src/middleware/auth.ts): bcrypt cost 10 and UUID header tokens backed by seven-day Redis entries |

The breaker correctly accepts each current call's closure:

```typescript
return await breaker.fire(operation) as T;
```

It is not a concurrency limiter with an application-configured finite job budget, and it does not cancel Git work on timeout. Many Git helpers catch errors and return `[]`, `null`, an empty diff, or `{ success: false }`; the promise then resolves and the breaker can count it as a success. Creation/deletion/initialization and search traversal are not all wrapped. Open-breaker failures do not have a consistent route-level 503 mapping. Many async Express 4 handlers have no rejection wrapper or local catch, so the final error middleware alone does not reliably handle their rejected promises.

The transaction receipt insert is real, but insufficient:

```sql
INSERT INTO idempotency_keys (key, operation_type, resource_id, response_body)
VALUES ($1, $2, $3, $4)
ON CONFLICT (key) DO NOTHING;
```

Lookup happens before `BEGIN`, keys are global rather than actor/repository/operation-scoped, and no payload digest is checked. Concurrent requests can both execute; an ignored key conflict does not undo the second resource. Reusing a key on another endpoint can replay the wrong resource. Keys older than 24 hours are ignored by lookup but may remain until hourly cleanup, allowing repeated execution against the still-conflicting key. The frontend sends no idempotency header. Shared numbering uses unlocked maxima from two tables, not an atomic repository counter.

Audit writes run separately, swallow errors, and can record an attempted close before the update succeeds. Generated request IDs are returned and logged but not copied to the incoming header used by the audit helper, so an audit row may have no matching ID. Many declared actions, including authentication and collaborator events, have no caller. HTTP metrics decrement active requests only on `finish`, not an aborted response; fallback raw paths can create high-cardinality route labels. A breaker timeout emits timeout and failure events, so its metric labels are not disjoint request counts. Shutdown calls `server.close` but does not await its callback before closing dependencies and exiting; this is not guaranteed in-flight request drainage.

### Git and collaboration behavior

- `initWithReadme` ignores the seeded long README text, makes a fresh working repository using Git's configured initial branch, and pushes `main`. Its boolean failure result is ignored by callers. File creation, SQL insert, README push, label inserts, and audit write are separate steps; failure can leave partial resources.
- Git tree reads return one directory, not a recursive virtual tree. The newline/tab parser lacks NUL-delimited filename handling; Git-quoted names and submodule entries are not modeled correctly. File reads decode the whole blob as a string without a binary/base64 contract or a byte cap. Helper failures can resemble empty repositories.
- [Pull request routes](./backend/src/routes/pulls.ts) store initial head/base SHAs but calculate displayed commits/diffs from current branch names. The diff cache is keyed only by PR ID. Reviews store the original `head_sha`, even if the branch has moved. Inline review-comment rows are never written; `/comments` is the ordinary conversation table.
- Merge clones into a timestamp-named temporary directory, uses branch names, pushes the base, and then updates SQL. It does not enforce maintain permission, draft/review policy, expected SHAs, or a merge receipt. Merge/squash may refer to a head name present only as an `origin/...` remote-tracking branch in a fresh clone; commit identity is not configured in that clone. The normal merge path permits a fast-forward. An unvalidated strategy can skip all merge branches yet push and report success. Cleanup can fail after a push. SQL records no returned merge SHA, and concurrent close/merge/update calls are not serialized.
- [Issues](./backend/src/routes/issues.ts) use a transaction for creation/labels, but updates and label replacement are separate writes. Issue updates require only login. PR author updates accept unchecked state values and can assign `merged` without Git publication; neither state column has a CHECK constraint. Reopening does not clear `closed_at`.
- [Discussions](./backend/src/routes/discussions.ts) load root comments plus one reply level using repeated queries. A parent/answer ID is not checked against the same discussion; upvote increments by comment ID without checking the URL's repository/discussion or deduplicating a user's vote. Organization creation/member insertion is also non-transactional. Collaborator membership is schema-only.

### Cache, search, and authorization gaps

Metadata TTL is 300 s, trees 600 s, file strings 3,600 s, PR diffs 600 s, branches 60 s, and commit pages 300 s. File keys contain the supplied ref, often `main`, not a resolved SHA. `invalidateRepoCaches` deletes metadata/branches/trees/commits but **not file contents**. Commit-page keys omit page size. Merge invalidates its own PR diff but not other open PRs sharing the moved base. Cache deletion does not prevent an older in-flight read from repopulating stale data.

Only repository detail applies a private-owner check, using cached visibility. Lists implement different public/owner rules; an unparenthesized owner OR clause can defeat the requested owner filter. Most content, PR, issue, discussion, and label reads do not share this check. Tags and single-commit reads do not even require a metadata lookup. Authenticated creation, merging, comments, stars, and push notification also lack repository role enforcement. Collaborators and organization members are not honored by the owner-only detail check. User profile responses include email, and sessions retain copied role/profile data until expiry/login. No cookie parser or cookie setter wires the middleware's optional cookie fallback. There is no rate limiting.

[Search service](./backend/src/services/search.ts) defines recursive `HEAD` indexing but has **no caller** from creation, seeding, push notification, or merge. If invoked manually, it indexes extensions sequentially, reads complete files before checking JavaScript string length below one million, skips empty files, and catches per-file failures. It has no consistent commit snapshot, deleted-path reconciliation, ACL fields, or generation checks. Existing `code` index mappings are not upgraded on startup.

The analyzer applies lowercase before case splitting, so case boundaries have already disappeared: `getUserById` cannot be assumed to split into its identifier words. That conclusion follows from the configured order and the filter's case-transition semantics. [Elastic word delimiter documentation](https://www.elastic.co/docs/reference/text-analysis/analysis-word-delimiter-tokenfilter). Symbol extraction uses shallow regexes, not parsing; symbol names are keyword fields. Code/symbol queries use unbounded offset inputs, discard the total-hit relation, and return index results without current SQL access checks. Combined SQL search separately limits each public category to ten items.

### Frontend behavior and unfinished integration

[Generated routing](./frontend/src/routeTree.gen.ts) nests repository children, but [RepoPage](./frontend/src/routes/$owner.$repo.tsx) renders no `Outlet`. [IssuesPage](./frontend/src/routes/$owner.$repo.issues.tsx) also omits one for issue detail. These are composition defects, not evidence of successful file or review navigation. The remaining child-component descriptions below describe source that needs that integration repaired.

[Auth store](./frontend/src/stores/authStore.ts) is the only Zustand store. Data lives in component state and a [fetch-based API client](./frontend/src/services/api.ts), with a generic `sessionId` localStorage key and header authentication. There is no TanStack Query, Zod/shared runtime schema, Axios, WebSocket, service worker, or persistent draft system. Logout failure retains the token/user; overlapping auth calls have no generation guard. Root-wide loading can unmount the current page during auth actions.

Repository loading serially requests metadata, tree, commits, README, and star status. Route effects lack cancellation/request generations and often retain previous errors/content on navigation. The branch selector has no handler; star state changes **after** the request succeeds and the count is locally adjusted without authoritative refresh or a pending guard. Fork/Watch/Code and card-level Star controls are inert.

[CodeViewer](./frontend/src/components/CodeViewer.tsx) renders every source line but runs highlight.js only on the first line's ref. It does not load language grammars lazily, run highlighting in a worker, virtualize, support blame, or implement line permalinks. [DiffViewer](./frontend/src/components/DiffViewer.tsx) renders the entire unified patch, colors prefixes, and numbers patch rows; it does not compute old/new source coordinates, split view, inline anchors, or collapsed hunks. README and discussion/issue prose are rendered as text, not through react-markdown.

PR detail loads PR/diff/comments serially, supports plain comments and only the `merge` strategy, then refreshes PR metadata without refreshing its separate diff. It has no review submission form, mutation receipt, pending guard, or live updates. Issue/PR lists show the first page with no pagination controls; their search inputs are inert. Comment responses can overwrite newer local state or clear text typed during submission. Discussion detail/create and new issue/compare routes are absent, along with profile, Explore, settings, commit detail, fork, and stargazer screens.

[Search page](./frontend/src/routes/search.tsx) takes `q` from the URL but keeps its selected category in local state. It lacks debounce, language/repository filter controls, pagination, query generations, and visible fetch-error recovery. Code links hardcode `main` and render Elasticsearch highlight strings through `dangerouslySetInnerHTML`, without the proposed escaping/range contract. Several icon controls and form fields lack accessible names; there is no implemented tree keyboard model or complete focus-management system.

### Simplifications, omissions, and verification

The local filesystem replaces replicated Git storage, route modules replace services, and single-node databases replace clusters. Session auth is implemented but uniform repository authorization is not. Webhooks, notifications, inline comments, and organization collaboration have schema or partial API artifacts, not complete workflows. No CDN, durable job queue, outbox, storage journal, merge reconciler, branch protection, CI, sharding, cross-region replication, or backup/restore process is implemented.

The [README](./README.md) documents Docker/native setup, actual environment variables, seed incompatibilities, and missing UI paths. The TypeScript seed and screenshot SQL fixture are different datasets; only the former initializes matching Git repositories. The single [smoke test](./tests/smoke.spec.ts) checks the homepage shell.

This review inspected source and ran nine isolated checks with mocked dependencies, including cache invalidation, idempotency races/scope, content authorization, organization route ordering, index payloads, code/diff rendering, nested route topology, invalid merge strategies, and uncancelled breaker work. It did not run the database, Elasticsearch, application stack, builds, or end-to-end Git/browser workflows. The proposed guarantees require new implementation and targeted recovery/concurrency tests.
