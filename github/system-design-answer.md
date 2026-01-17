# System Design Interview: GitHub - Code Hosting Platform

## Opening Statement

"Today I'll design a code hosting platform like GitHub, built on Git. The core technical challenges are storing Git objects efficiently, building code search across billions of files, designing collaborative pull request workflows, and implementing reliable webhook delivery for integrations."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **Repositories**: Create, clone, push, pull Git repositories
2. **Pull Requests**: Create, review, and merge code changes
3. **Code Search**: Find code across millions of repositories
4. **Actions**: Run CI/CD workflows on events
5. **Webhooks**: Notify external systems of repository events

### Non-Functional Requirements

- **Availability**: 99.99% for Git operations (critical developer infrastructure)
- **Latency**: < 100ms for API requests
- **Scale**: 200 million repositories, 1 billion files indexed
- **Durability**: Zero data loss (code is irreplaceable)

### Scale Estimates

| Metric | Estimate |
|--------|----------|
| Repositories | 200M |
| Daily Git Operations | 100M |
| Daily Pushes | 10M |
| Files Indexed | 1B |
| Webhooks/Day | 100M |

---

## Step 2: High-Level Architecture (7 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│  Web UI │ Git CLI │ GitHub CLI │ IDE Extensions                 │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   Git Server  │    │   API Server  │    │ Search Service│
│               │    │               │    │               │
│ - SSH/HTTPS   │    │ - REST/GraphQL│    │ - Code index  │
│ - Pack files  │    │ - PRs, Issues │    │ - Elasticsearch│
│ - LFS         │    │ - Webhooks    │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Storage Layer                              │
├─────────────┬─────────────┬─────────────────────────────────────┤
│ Git Storage │ PostgreSQL  │           Elasticsearch             │
│ (Object store)│ - Repos    │           - Code search             │
│ - Blobs     │ - PRs       │           - Symbols                 │
│ - Trees     │ - Users     │                                     │
│ - Commits   │ - Webhooks  │                                     │
└─────────────┴─────────────┴─────────────────────────────────────┘
```

### Why This Architecture?

**Separate Git Server**: Git operations (clone, push, pull) use SSH/HTTPS protocols that are different from REST APIs. Dedicated Git servers optimize for pack file transfer.

**Object Storage for Git**: Git objects are content-addressed and immutable - perfect for object storage. Same blob appearing in 1000 repos is stored once.

**Elasticsearch for Code Search**: Searching billions of lines of code requires specialized indexing. PostgreSQL can't handle this scale of full-text search.

---

## Step 3: Git Storage Deep Dive (10 minutes)

### Understanding Git Objects

Git has four object types, all content-addressed by SHA-1 hash:

| Type | Contains | Example |
|------|----------|---------|
| **Blob** | File contents | `function hello() {...}` |
| **Tree** | Directory structure | `src/` → blob, blob, tree |
| **Commit** | Commit metadata | Author, message, parent, tree |
| **Tag** | Annotated tag | Tag name, tagger, commit |

### Storage Layout

```
/repositories
  /{owner}
    /{repo}
      /objects
        /pack
          pack-abc123.pack    # Compressed objects
          pack-abc123.idx     # Index for fast lookup
      /refs
        /heads
          main                # Points to commit SHA
          feature-branch
        /tags
          v1.0.0
```

### Content-Addressed Deduplication

```javascript
// Git objects are identified by SHA-1 of content
async function storeObject(content, type) {
  // Hash = SHA-1 of "type length\0content"
  const hash = sha1(`${type} ${content.length}\0${content}`)

  // Check if already exists
  const existing = await objectStore.exists(hash)

  if (!existing) {
    // Compress and store
    await objectStore.put(hash, zlib.deflate(content))
  }

  return hash
}
```

**Example**: If 1000 repos all have the same `LICENSE` file:
- Traditional: 1000 copies stored
- Git: 1 blob stored, 1000 refs to it

### Pack Files

Rather than storing millions of loose objects, Git packs them:

```
pack-abc123.pack:
┌──────────────────────────────────────────┐
│ Object 1: blob (compressed)              │
│ Object 2: tree (compressed)              │
│ Object 3: commit (compressed)            │
│ Object 4: delta of Object 1              │  ← Delta compression!
│ ...                                      │
└──────────────────────────────────────────┘

pack-abc123.idx:
┌──────────────────────────────────────────┐
│ SHA abc123 → offset 0                    │
│ SHA def456 → offset 1024                 │
│ ...                                      │
└──────────────────────────────────────────┘
```

Delta compression means similar objects (e.g., versions of same file) store only differences.

---

## Step 4: Pull Request Workflow (10 minutes)

### PR State Machine

```
OPEN → REVIEW_REQUIRED → APPROVED → MERGED
  │         │               │          │
  └─────────┴───────────────┴──────────┘
                  │
              CLOSED (without merge)
```

### Creating a Pull Request

```javascript
async function createPullRequest(repoId, data) {
  const { title, body, headBranch, baseBranch, authorId } = data

  // 1. Validate branches exist
  const head = await getRef(repoId, `refs/heads/${headBranch}`)
  const base = await getRef(repoId, `refs/heads/${baseBranch}`)

  if (!head || !base) {
    throw new Error('Branch not found')
  }

  // 2. Compute diff
  const commits = await git.log(base.sha, head.sha)
  const diffStats = await git.diffStats(base.sha, head.sha)

  // 3. Create PR record
  const pr = await db('pull_requests').insert({
    repo_id: repoId,
    number: await getNextPRNumber(repoId),
    title,
    body,
    head_branch: headBranch,
    head_sha: head.sha,
    base_branch: baseBranch,
    base_sha: base.sha,
    author_id: authorId,
    state: 'open',
    additions: diffStats.additions,
    deletions: diffStats.deletions,
    changed_files: diffStats.files.length
  }).returning('*')

  // 4. Trigger webhooks
  await emitWebhook(repoId, 'pull_request.opened', { pr: pr[0] })

  // 5. Trigger CI
  await triggerCI(repoId, pr[0])

  return pr[0]
}
```

### Merge Strategies

```javascript
async function mergePullRequest(prId, strategy, userId) {
  const pr = await getPullRequest(prId)

  // Check merge requirements
  await validateMergeRequirements(pr)

  switch (strategy) {
    case 'merge':
      // Create merge commit with two parents
      await git.merge(pr.head_sha, pr.base_branch, {
        message: `Merge pull request #${pr.number}`
      })
      break

    case 'squash':
      // Combine all commits into one
      const commits = await git.log(pr.base_sha, pr.head_sha)
      const combined = combineCommitMessages(commits)
      await git.commit(combined, pr.base_branch)
      break

    case 'rebase':
      // Replay commits on top of base
      await git.rebase(pr.head_branch, pr.base_branch)
      await git.fastForward(pr.base_branch, pr.head_sha)
      break
  }

  // Update PR status
  await db('pull_requests')
    .where({ id: prId })
    .update({
      state: 'merged',
      merged_by: userId,
      merged_at: new Date()
    })

  // Emit webhook
  await emitWebhook(pr.repo_id, 'pull_request.merged', { pr })
}
```

### When to Use Each Strategy

| Strategy | Result | Use When |
|----------|--------|----------|
| Merge | Merge commit | Preserve full history |
| Squash | Single commit | Clean history, feature branches |
| Rebase | Linear history | Avoiding merge commits |

---

## Step 5: Code Search Deep Dive (10 minutes)

### The Challenge

- 200M repositories
- 1B+ files
- Multiple languages with different syntax
- Need symbol-aware search (find function definitions)

### Indexing Pipeline

```
Push Event → Parse Files → Extract Symbols → Index to Elasticsearch
                │
                ├── Language detection (by extension, shebang)
                ├── Tokenization (language-aware)
                └── Symbol extraction (functions, classes, methods)
```

### Elasticsearch Index Mapping

```json
{
  "mappings": {
    "properties": {
      "repo_id": { "type": "keyword" },
      "path": { "type": "keyword" },
      "language": { "type": "keyword" },
      "content": {
        "type": "text",
        "analyzer": "code_analyzer"
      },
      "symbols": {
        "type": "nested",
        "properties": {
          "name": { "type": "keyword" },
          "kind": { "type": "keyword" },  // function, class, method
          "line": { "type": "integer" }
        }
      }
    }
  },
  "settings": {
    "analysis": {
      "analyzer": {
        "code_analyzer": {
          "type": "custom",
          "tokenizer": "code_tokenizer",
          "filter": ["lowercase", "camelcase_split"]
        }
      },
      "tokenizer": {
        "code_tokenizer": {
          "type": "pattern",
          "pattern": "[^a-zA-Z0-9_]+"
        }
      },
      "filter": {
        "camelcase_split": {
          "type": "word_delimiter",
          "split_on_case_change": true
        }
      }
    }
  }
}
```

### Search Query

```javascript
async function searchCode(query, filters) {
  const body = {
    query: {
      bool: {
        must: [
          { match: { content: query } }
        ],
        filter: [
          filters.language && { term: { language: filters.language } },
          filters.repo && { term: { repo_id: filters.repo } },
          filters.path && { wildcard: { path: `*${filters.path}*` } }
        ].filter(Boolean)
      }
    },
    highlight: {
      fields: {
        content: {
          fragment_size: 150,
          number_of_fragments: 3
        }
      }
    },
    size: 20
  }

  // Symbol search (e.g., "function:calculateTotal")
  if (query.startsWith('symbol:')) {
    body.query = {
      nested: {
        path: 'symbols',
        query: {
          term: { 'symbols.name': query.replace('symbol:', '') }
        }
      }
    }
  }

  return await es.search({ index: 'code', body })
}
```

### Incremental Indexing

```javascript
// On every push, update only changed files
async function handlePush(repoId, beforeSha, afterSha) {
  // Get changed files
  const changes = await git.diff(beforeSha, afterSha, { nameOnly: true })

  for (const file of changes.added) {
    const content = await git.getFileContent(afterSha, file.path)
    await indexFile(repoId, file.path, content)
  }

  for (const file of changes.modified) {
    const content = await git.getFileContent(afterSha, file.path)
    await updateIndex(repoId, file.path, content)
  }

  for (const file of changes.deleted) {
    await removeFromIndex(repoId, file.path)
  }
}
```

---

## Step 6: Webhook Delivery (7 minutes)

Webhooks power the entire GitHub ecosystem (CI, bots, integrations).

### Reliable Delivery Architecture

```
Event → Queue → Worker → Delivery → Retry on Failure
         │
         ├── delivery_1 (pending)
         ├── delivery_2 (succeeded)
         └── delivery_3 (retrying)
```

### Webhook Processing

```javascript
async function deliverWebhook(webhookId, event, payload) {
  const webhook = await db('webhooks').where({ id: webhookId }).first()

  // Queue for delivery
  await webhookQueue.add({
    webhookId,
    url: webhook.url,
    event,
    payload,
    secret: webhook.secret,
    attempt: 1,
    scheduledAt: Date.now()
  })
}

// Worker processes queue
async function processWebhookJob(job) {
  const { webhookId, url, payload, secret, attempt } = job

  // Create signature for verification
  const signature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex')

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': job.event,
        'X-Hub-Signature-256': `sha256=${signature}`,
        'X-GitHub-Delivery': job.deliveryId
      },
      body: JSON.stringify(payload),
      timeout: 30000  // 30 second timeout
    })

    // Log delivery
    await logDelivery(webhookId, {
      status: response.status,
      duration: response.timing,
      attempt
    })

    if (!response.ok && attempt < 10) {
      // Retry with exponential backoff
      const delay = Math.pow(2, attempt) * 1000  // 2s, 4s, 8s, 16s...
      await webhookQueue.add({
        ...job,
        attempt: attempt + 1,
        scheduledAt: Date.now() + delay
      })
    }

  } catch (error) {
    await logDelivery(webhookId, {
      status: 'error',
      error: error.message,
      attempt
    })

    if (attempt < 10) {
      await webhookQueue.add({
        ...job,
        attempt: attempt + 1,
        scheduledAt: Date.now() + Math.pow(2, attempt) * 1000
      })
    }
  }
}
```

### Webhook Retry Schedule

| Attempt | Delay | Total Time |
|---------|-------|------------|
| 1 | 0 | 0 |
| 2 | 2s | 2s |
| 3 | 4s | 6s |
| 4 | 8s | 14s |
| 5 | 16s | 30s |
| ... | ... | ... |
| 10 | 512s | ~17 min |

---

## Step 7: Database Schema (3 minutes)

```sql
-- Repositories
CREATE TABLE repositories (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_private BOOLEAN DEFAULT FALSE,
  default_branch VARCHAR(100) DEFAULT 'main',
  storage_path VARCHAR(500),  -- Path to Git objects
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(owner_id, name)
);

-- Pull Requests
CREATE TABLE pull_requests (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id),
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  state VARCHAR(20) DEFAULT 'open',
  head_branch VARCHAR(100),
  head_sha VARCHAR(40),
  base_branch VARCHAR(100),
  base_sha VARCHAR(40),
  author_id INTEGER REFERENCES users(id),
  merged_by INTEGER REFERENCES users(id),
  merged_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repo_id, number)
);

-- Reviews
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER REFERENCES pull_requests(id),
  reviewer_id INTEGER REFERENCES users(id),
  state VARCHAR(20), -- approved, changes_requested, commented
  body TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Webhooks
CREATE TABLE webhooks (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id),
  url VARCHAR(500) NOT NULL,
  secret VARCHAR(100),
  events TEXT[],  -- ['push', 'pull_request', 'issues']
  is_active BOOLEAN DEFAULT TRUE
);
```

---

## Step 8: Key Design Decisions & Trade-offs (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Git storage | Object store | Database | Immutable, content-addressed, dedup |
| Code search | Elasticsearch | PostgreSQL FTS | Scale (1B files), features |
| Webhooks | Queue-based | Synchronous | Reliability, non-blocking |
| PRs | Single table | Event-sourced | Simplicity, query efficiency |

### Why Object Store for Git?

- **Immutable**: Git objects never change, perfect for object storage
- **Content-addressed**: Same content = same hash = automatic dedup
- **Horizontal scaling**: Object stores scale infinitely
- **Cost**: Object storage cheaper than database at this scale

### Trade-off: Eventual Consistency in Search

Code search index updates asynchronously:
- Push completes immediately
- Search index updates within seconds
- Acceptable because:
  - Users expect slight delay for search
  - Git operations are source of truth
  - Can always browse files directly

---

## Closing Summary

I've designed a code hosting platform with four core systems:

1. **Git Storage**: Object store for content-addressed Git objects with pack files for compression and deduplication across repositories

2. **Pull Request Workflow**: Full PR lifecycle with merge strategies (merge, squash, rebase), reviews, and status checks

3. **Code Search**: Elasticsearch-powered indexing with language-aware tokenization and symbol extraction, updated incrementally on pushes

4. **Webhook Delivery**: Queue-based reliable delivery with exponential backoff retries and cryptographic signature verification

**Key trade-offs:**
- Object store over database (scale vs. query flexibility)
- Elasticsearch over PostgreSQL FTS (scale vs. operational simplicity)
- Async webhooks over sync (reliability vs. guaranteed ordering)

**What would I add with more time?**
- GitHub Actions (CI/CD) with containerized runners
- Dependabot for dependency updates
- Code scanning for security vulnerabilities
