# Design GitHub - Architecture

## System Overview

GitHub is a code hosting platform built on Git. Core challenges involve Git storage, code search, and collaborative workflows like pull requests.

**Learning Goals:**
- Understand Git internals and storage
- Build code search systems
- Design collaborative PR workflows
- Implement webhook delivery systems

---

## Requirements

### Functional Requirements

1. **Repos**: Create, clone, push, pull
2. **PRs**: Create, review, merge pull requests
3. **Search**: Find code across repositories
4. **Actions**: Run CI/CD workflows
5. **Webhooks**: Notify external systems of events

### Non-Functional Requirements

- **Availability**: 99.99% for Git operations
- **Latency**: < 100ms for API requests
- **Scale**: 200M repos, 1B files indexed
- **Durability**: No data loss (critical)

---

## High-Level Architecture

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

---

## Core Components

### 1. Git Object Storage

**Git Object Types:**
- **Blob**: File content (compressed)
- **Tree**: Directory structure
- **Commit**: Commit metadata + tree pointer
- **Tag**: Annotated tag

**Storage Strategy:**
```
/repositories
  /{owner}
    /{repo}
      /objects
        /pack
          pack-abc123.pack
          pack-abc123.idx
      /refs
        /heads
          main
          feature-branch
        /tags
          v1.0.0
```

**Object Deduplication:**
```javascript
// Git objects are content-addressed (SHA-1 hash of content)
// Same file in multiple repos = stored once

async function storeObject(content, type) {
  const hash = sha1(`${type} ${content.length}\0${content}`)
  const existing = await objectStore.exists(hash)

  if (!existing) {
    await objectStore.put(hash, compress(content))
  }

  return hash
}
```

### 2. Pull Request Workflow

**PR State Machine:**
```
OPEN → REVIEW_REQUIRED → APPROVED → MERGED
  │         │               │          │
  └─────────┴───────────────┴──────────┘
                  │
              CLOSED (without merge)
```

**Merge Strategies:**
```javascript
async function mergePR(prId, strategy) {
  const pr = await getPR(prId)

  switch (strategy) {
    case 'merge':
      // Create merge commit
      await git.merge(pr.headBranch, pr.baseBranch)
      break

    case 'squash':
      // Combine all commits into one
      const commits = await git.log(pr.baseBranch, pr.headBranch)
      const squashed = squashCommits(commits)
      await git.commit(squashed, pr.baseBranch)
      break

    case 'rebase':
      // Replay commits on top of base
      await git.rebase(pr.headBranch, pr.baseBranch)
      break
  }

  await closePR(prId, 'merged')
  await emitWebhook('pull_request.merged', pr)
}
```

### 3. Code Search

**Indexing Pipeline:**
```
Push Event → Parse Files → Extract Symbols → Index to Elasticsearch
                │
                ├── Language detection
                ├── Tokenization
                └── Symbol extraction (functions, classes)
```

**Elasticsearch Index:**
```json
{
  "mappings": {
    "properties": {
      "repo_id": { "type": "keyword" },
      "path": { "type": "keyword" },
      "content": { "type": "text", "analyzer": "code_analyzer" },
      "language": { "type": "keyword" },
      "symbols": {
        "type": "nested",
        "properties": {
          "name": { "type": "keyword" },
          "kind": { "type": "keyword" },
          "line": { "type": "integer" }
        }
      }
    }
  }
}
```

**Search Query:**
```javascript
async function searchCode(query, { language, repo, path }) {
  return await es.search({
    index: 'code',
    body: {
      query: {
        bool: {
          must: [
            { match: { content: query } }
          ],
          filter: [
            language && { term: { language } },
            repo && { term: { repo_id: repo } },
            path && { wildcard: { path: path } }
          ].filter(Boolean)
        }
      },
      highlight: {
        fields: { content: {} }
      }
    }
  })
}
```

### 4. Webhook Delivery

**Reliable Delivery:**
```javascript
async function deliverWebhook(webhookId, event, payload) {
  const webhook = await getWebhook(webhookId)

  // Queue for delivery
  await webhookQueue.add({
    webhookId,
    event,
    payload,
    attempt: 1,
    scheduledAt: Date.now()
  })
}

// Worker processes queue
async function processWebhookJob(job) {
  const { webhookId, payload, attempt } = job

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': job.event,
        'X-Hub-Signature': sign(payload, webhook.secret)
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok && attempt < 10) {
      // Retry with exponential backoff
      await webhookQueue.add({
        ...job,
        attempt: attempt + 1,
        scheduledAt: Date.now() + Math.pow(2, attempt) * 1000
      })
    }

    await logDelivery(webhookId, response.status, payload)
  } catch (error) {
    await logDelivery(webhookId, 'error', { error: error.message })
  }
}
```

---

## Database Schema

```sql
-- Repositories
CREATE TABLE repositories (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_private BOOLEAN DEFAULT FALSE,
  default_branch VARCHAR(100) DEFAULT 'main',
  storage_path VARCHAR(500),
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
  base_branch VARCHAR(100),
  author_id INTEGER REFERENCES users(id),
  merged_by INTEGER REFERENCES users(id),
  merged_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repo_id, number)
);

-- PR Reviews
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER REFERENCES pull_requests(id),
  reviewer_id INTEGER REFERENCES users(id),
  state VARCHAR(20), -- 'approved', 'changes_requested', 'commented'
  body TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Webhooks
CREATE TABLE webhooks (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id),
  url VARCHAR(500) NOT NULL,
  secret VARCHAR(100),
  events TEXT[],
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Object Store for Git Data

**Decision**: Store Git objects in object storage, not database

**Rationale**:
- Git objects are immutable (content-addressed)
- Object storage optimized for large blobs
- Enables deduplication across repos

### 2. Elasticsearch for Code Search

**Decision**: Separate search index from Git storage

**Rationale**:
- Git objects not optimized for full-text search
- Elasticsearch handles tokenization, ranking
- Async indexing doesn't block pushes

### 3. Queue-Based Webhook Delivery

**Decision**: Async delivery with retry queue

**Rationale**:
- Decouples event creation from delivery
- Handles slow/failing endpoints
- Provides delivery history

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Git storage | Object store | Database | Performance, dedup |
| Code search | Elasticsearch | PostgreSQL FTS | Scale, features |
| Webhooks | Queue-based | Synchronous | Reliability |
| PRs | Single table | Event sourced | Simplicity |
