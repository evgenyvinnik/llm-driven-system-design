# GitHub - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

---

## 1. Requirements Clarification (2 min)

### Functional Requirements
- Create, clone, push, pull Git repositories
- Create, review, and merge pull requests
- Search code across millions of repositories
- Webhooks for external system integration

### Non-Functional Requirements
- 99.99% availability for Git operations
- < 100ms latency for API requests
- Zero data loss (code is irreplaceable)
- Scale to 200M repositories, 1B files indexed

### Scale Estimates

| Metric | Estimate |
|--------|----------|
| Repositories | 200M |
| Daily Git Operations | 100M |
| Daily Pushes | 10M |
| Files Indexed | 1B |
| Webhooks/Day | 100M |

---

## 2. High-Level Architecture (3 min)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│  Web UI  |  Git CLI  |  GitHub CLI  |  IDE Extensions          │
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

## 3. Deep Dive: Git Object Storage (10 min)

### Understanding Git Objects

Git has four object types, all content-addressed by SHA-1 hash:

| Type | Contains | Example |
|------|----------|---------|
| **Blob** | File contents | `function hello() {...}` |
| **Tree** | Directory structure | `src/` -> blob, blob, tree |
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

```typescript
// backend/src/shared/git-storage.ts
import { createHash } from 'crypto';
import { deflate, inflate } from 'zlib';
import { objectStore } from './storage.js';

interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  content: Buffer;
}

export async function storeObject(obj: GitObject): Promise<string> {
  // Git hash format: "{type} {length}\0{content}"
  const header = Buffer.from(`${obj.type} ${obj.content.length}\0`);
  const data = Buffer.concat([header, obj.content]);

  // SHA-1 hash for content addressing
  const hash = createHash('sha1').update(data).digest('hex');

  // Check if already exists (deduplication)
  const exists = await objectStore.exists(`objects/${hash.slice(0, 2)}/${hash.slice(2)}`);

  if (!exists) {
    // Compress with zlib and store
    const compressed = await deflateAsync(data);
    await objectStore.put(
      `objects/${hash.slice(0, 2)}/${hash.slice(2)}`,
      compressed
    );
  }

  return hash;
}

export async function getObject(hash: string): Promise<GitObject> {
  const compressed = await objectStore.get(
    `objects/${hash.slice(0, 2)}/${hash.slice(2)}`
  );

  const data = await inflateAsync(compressed);

  // Parse header
  const nullIndex = data.indexOf(0);
  const header = data.slice(0, nullIndex).toString();
  const [type, sizeStr] = header.split(' ');
  const content = data.slice(nullIndex + 1);

  return {
    type: type as GitObject['type'],
    content,
  };
}
```

### Pack Files for Efficiency

```typescript
// backend/src/shared/pack-file.ts
import { createReadStream } from 'fs';

interface PackIndex {
  fanout: number[];
  hashes: string[];
  offsets: number[];
}

export class PackFile {
  private index: PackIndex;
  private packPath: string;

  constructor(packPath: string) {
    this.packPath = packPath;
    this.index = this.loadIndex(packPath.replace('.pack', '.idx'));
  }

  private loadIndex(idxPath: string): PackIndex {
    // Pack index format:
    // - 256-entry fanout table for binary search
    // - Sorted SHA-1 hashes
    // - Offsets into pack file
    const data = readFileSync(idxPath);

    const fanout: number[] = [];
    for (let i = 0; i < 256; i++) {
      fanout.push(data.readUInt32BE(8 + i * 4));
    }

    const objectCount = fanout[255];
    const hashStart = 8 + 256 * 4;
    const hashes: string[] = [];

    for (let i = 0; i < objectCount; i++) {
      hashes.push(data.slice(hashStart + i * 20, hashStart + (i + 1) * 20).toString('hex'));
    }

    // CRC32 and offsets follow
    const offsetStart = hashStart + objectCount * 20 + objectCount * 4;
    const offsets: number[] = [];

    for (let i = 0; i < objectCount; i++) {
      offsets.push(data.readUInt32BE(offsetStart + i * 4));
    }

    return { fanout, hashes, offsets };
  }

  async getObject(hash: string): Promise<Buffer | null> {
    // Binary search using fanout table
    const firstByte = parseInt(hash.slice(0, 2), 16);
    const start = firstByte === 0 ? 0 : this.index.fanout[firstByte - 1];
    const end = this.index.fanout[firstByte];

    // Search for hash in range
    let found = -1;
    for (let i = start; i < end; i++) {
      if (this.index.hashes[i] === hash) {
        found = i;
        break;
      }
    }

    if (found === -1) return null;

    // Read object from pack at offset
    const offset = this.index.offsets[found];
    return this.readObjectAt(offset);
  }

  private async readObjectAt(offset: number): Promise<Buffer> {
    // Read object header and decompress
    // Handles both base objects and deltas
    const fd = await fs.open(this.packPath, 'r');
    const header = Buffer.alloc(32);
    await fd.read(header, 0, 32, offset);

    // Parse variable-length header
    const type = (header[0] >> 4) & 0x7;
    let size = header[0] & 0x0f;
    let shift = 4;
    let i = 0;

    while (header[i] & 0x80) {
      i++;
      size |= (header[i] & 0x7f) << shift;
      shift += 7;
    }

    // Read and decompress content
    const compressedData = Buffer.alloc(size * 2);
    await fd.read(compressedData, 0, compressedData.length, offset + i + 1);
    await fd.close();

    return inflate(compressedData);
  }
}
```

### Delta Compression for Similar Objects

```typescript
// backend/src/shared/delta.ts

// Pack files use delta compression:
// Store base object, then only differences for similar objects
// This is why editing one line in a file is efficient

interface DeltaInstruction {
  type: 'copy' | 'insert';
  offset?: number;  // For copy: source offset
  size: number;     // For copy: bytes to copy; For insert: bytes of new data
  data?: Buffer;    // For insert: new data
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;

  // Read base size (variable-length encoding)
  let baseSize = 0;
  let shift = 0;
  while (delta[pos] & 0x80) {
    baseSize |= (delta[pos++] & 0x7f) << shift;
    shift += 7;
  }
  baseSize |= delta[pos++] << shift;

  // Read result size
  let resultSize = 0;
  shift = 0;
  while (delta[pos] & 0x80) {
    resultSize |= (delta[pos++] & 0x7f) << shift;
    shift += 7;
  }
  resultSize |= delta[pos++] << shift;

  const result = Buffer.alloc(resultSize);
  let resultPos = 0;

  while (pos < delta.length) {
    const cmd = delta[pos++];

    if (cmd & 0x80) {
      // Copy from base
      let copyOffset = 0;
      let copySize = 0;

      if (cmd & 0x01) copyOffset = delta[pos++];
      if (cmd & 0x02) copyOffset |= delta[pos++] << 8;
      if (cmd & 0x04) copyOffset |= delta[pos++] << 16;
      if (cmd & 0x08) copyOffset |= delta[pos++] << 24;

      if (cmd & 0x10) copySize = delta[pos++];
      if (cmd & 0x20) copySize |= delta[pos++] << 8;
      if (cmd & 0x40) copySize |= delta[pos++] << 16;

      if (copySize === 0) copySize = 0x10000;

      base.copy(result, resultPos, copyOffset, copyOffset + copySize);
      resultPos += copySize;
    } else if (cmd) {
      // Insert new data
      delta.copy(result, resultPos, pos, pos + cmd);
      pos += cmd;
      resultPos += cmd;
    }
  }

  return result;
}
```

---

## 4. Deep Dive: Pull Request Workflow (8 min)

### Database Schema

```sql
-- Pull Requests table
CREATE TABLE pull_requests (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  state VARCHAR(20) DEFAULT 'open',  -- 'open', 'closed', 'merged'
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
  UNIQUE(repo_id, number)
);

-- Reviews table
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  reviewer_id INTEGER REFERENCES users(id),
  state VARCHAR(20),  -- 'approved', 'changes_requested', 'commented', 'pending'
  body TEXT,
  commit_sha VARCHAR(40),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Review comments (inline code comments)
CREATE TABLE review_comments (
  id SERIAL PRIMARY KEY,
  review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  path VARCHAR(500),
  line INTEGER,
  side VARCHAR(10),  -- 'LEFT' or 'RIGHT'
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_prs_repo ON pull_requests(repo_id);
CREATE INDEX idx_prs_author ON pull_requests(author_id);
CREATE INDEX idx_prs_state ON pull_requests(repo_id, state);
CREATE INDEX idx_reviews_pr ON reviews(pr_id);
```

### PR Creation with Diff Stats

```typescript
// backend/src/api/routes/pull-requests.ts
import { Router } from 'express';
import { pool } from '../../shared/db.js';
import { gitService } from '../../shared/git.js';
import { emitWebhook } from '../../shared/webhooks.js';

const router = Router();

interface CreatePRBody {
  title: string;
  body?: string;
  headBranch: string;
  baseBranch: string;
}

router.post('/:owner/:repo/pulls', async (req, res) => {
  const { owner, repo } = req.params;
  const { title, body, headBranch, baseBranch } = req.body as CreatePRBody;
  const authorId = req.user!.id;

  // Get repository
  const repoResult = await pool.query(
    `SELECT r.id, r.storage_path FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoResult.rows[0].id;
  const storagePath = repoResult.rows[0].storage_path;

  // Validate branches exist
  const headRef = await gitService.getRef(storagePath, `refs/heads/${headBranch}`);
  const baseRef = await gitService.getRef(storagePath, `refs/heads/${baseBranch}`);

  if (!headRef || !baseRef) {
    return res.status(400).json({ error: 'Branch not found' });
  }

  // Compute diff statistics
  const diffStats = await gitService.diffStats(storagePath, baseRef, headRef);

  // Get next PR number
  const numberResult = await pool.query(
    `SELECT COALESCE(MAX(number), 0) + 1 as next_number
     FROM pull_requests WHERE repo_id = $1`,
    [repoId]
  );
  const prNumber = numberResult.rows[0].next_number;

  // Create PR
  const prResult = await pool.query(
    `INSERT INTO pull_requests
     (repo_id, number, title, body, head_branch, head_sha, base_branch, base_sha,
      author_id, additions, deletions, changed_files)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      repoId, prNumber, title, body, headBranch, headRef, baseBranch, baseRef,
      authorId, diffStats.additions, diffStats.deletions, diffStats.files.length
    ]
  );

  const pr = prResult.rows[0];

  // Emit webhook
  await emitWebhook(repoId, 'pull_request.opened', {
    action: 'opened',
    number: prNumber,
    pull_request: pr,
  });

  res.status(201).json(pr);
});

export default router;
```

### Merge Strategies Implementation

```typescript
// backend/src/shared/merge.ts
import { gitService } from './git.js';
import { pool } from './db.js';
import { emitWebhook } from './webhooks.js';

type MergeStrategy = 'merge' | 'squash' | 'rebase';

interface MergeResult {
  success: boolean;
  sha?: string;
  error?: string;
}

export async function mergePullRequest(
  prId: number,
  strategy: MergeStrategy,
  userId: number
): Promise<MergeResult> {
  // Get PR details
  const prResult = await pool.query(
    `SELECT pr.*, r.storage_path
     FROM pull_requests pr
     JOIN repositories r ON pr.repo_id = r.id
     WHERE pr.id = $1`,
    [prId]
  );

  if (prResult.rows.length === 0) {
    return { success: false, error: 'PR not found' };
  }

  const pr = prResult.rows[0];

  // Check if mergeable
  const mergeCheck = await checkMergeability(pr);
  if (!mergeCheck.mergeable) {
    return { success: false, error: `Merge conflicts in: ${mergeCheck.conflicts.join(', ')}` };
  }

  let resultSha: string;

  switch (strategy) {
    case 'merge':
      resultSha = await performMergeCommit(pr);
      break;
    case 'squash':
      resultSha = await performSquashMerge(pr);
      break;
    case 'rebase':
      resultSha = await performRebaseMerge(pr);
      break;
  }

  // Update PR state
  await pool.query(
    `UPDATE pull_requests
     SET state = 'merged', merged_by = $1, merged_at = NOW()
     WHERE id = $2`,
    [userId, prId]
  );

  // Emit webhook
  await emitWebhook(pr.repo_id, 'pull_request.merged', {
    action: 'merged',
    number: pr.number,
    pull_request: pr,
    merge_commit_sha: resultSha,
  });

  return { success: true, sha: resultSha };
}

async function performMergeCommit(pr: any): Promise<string> {
  // Create merge commit with two parents
  return gitService.merge(pr.storage_path, pr.head_sha, pr.base_branch, {
    message: `Merge pull request #${pr.number} from ${pr.head_branch}\n\n${pr.title}`,
  });
}

async function performSquashMerge(pr: any): Promise<string> {
  // Get all commits in the PR
  const commits = await gitService.log(pr.storage_path, pr.base_sha, pr.head_sha);

  // Combine commit messages
  const combinedMessage = [
    `${pr.title} (#${pr.number})`,
    '',
    pr.body || '',
    '',
    '---',
    '',
    ...commits.map((c: any) => `* ${c.message}`),
  ].join('\n');

  // Create single commit with all changes
  return gitService.squashMerge(pr.storage_path, pr.base_branch, pr.head_sha, {
    message: combinedMessage,
  });
}

async function performRebaseMerge(pr: any): Promise<string> {
  // Replay commits on top of base
  const commits = await gitService.log(pr.storage_path, pr.base_sha, pr.head_sha);

  // Rebase each commit onto base
  let currentBase = pr.base_sha;
  for (const commit of commits) {
    currentBase = await gitService.cherryPick(pr.storage_path, commit.sha, currentBase);
  }

  // Fast-forward base branch
  await gitService.updateRef(pr.storage_path, `refs/heads/${pr.base_branch}`, currentBase);

  return currentBase;
}

async function checkMergeability(pr: any): Promise<{ mergeable: boolean; conflicts: string[] }> {
  try {
    await gitService.testMerge(pr.storage_path, pr.base_sha, pr.head_sha);
    return { mergeable: true, conflicts: [] };
  } catch (error: any) {
    const conflicts = parseConflictFiles(error.message);
    return { mergeable: false, conflicts };
  }
}

function parseConflictFiles(errorMessage: string): string[] {
  // Parse git merge error to extract conflicting files
  const matches = errorMessage.match(/CONFLICT \(content\): Merge conflict in (.+)/g);
  return matches?.map((m) => m.replace(/CONFLICT \(content\): Merge conflict in /, '')) || [];
}
```

---

## 5. Deep Dive: Code Search with Elasticsearch (8 min)

### Elasticsearch Index Mapping

```json
{
  "mappings": {
    "properties": {
      "repo_id": { "type": "keyword" },
      "repo_name": { "type": "keyword" },
      "owner": { "type": "keyword" },
      "path": { "type": "keyword" },
      "filename": { "type": "keyword" },
      "extension": { "type": "keyword" },
      "language": { "type": "keyword" },
      "content": {
        "type": "text",
        "analyzer": "code_analyzer"
      },
      "symbols": {
        "type": "nested",
        "properties": {
          "name": { "type": "keyword" },
          "kind": { "type": "keyword" },
          "line": { "type": "integer" }
        }
      },
      "commit_sha": { "type": "keyword" },
      "indexed_at": { "type": "date" }
    }
  },
  "settings": {
    "analysis": {
      "analyzer": {
        "code_analyzer": {
          "type": "custom",
          "tokenizer": "code_tokenizer",
          "filter": ["lowercase", "camelcase_split", "underscore_split"]
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
          "type": "word_delimiter_graph",
          "split_on_case_change": true,
          "preserve_original": true
        },
        "underscore_split": {
          "type": "word_delimiter_graph",
          "split_on_numerics": false,
          "preserve_original": true
        }
      }
    }
  }
}
```

### Indexing Pipeline

```typescript
// backend/src/worker/indexer.ts
import { Client } from '@elastic/elasticsearch';
import { gitService } from '../shared/git.js';
import { pool } from '../shared/db.js';
import { extractSymbols } from './symbol-extractor.js';
import { detectLanguage } from './language-detector.js';

const es = new Client({ node: process.env.ELASTICSEARCH_URL });

interface FileToIndex {
  repoId: number;
  repoName: string;
  owner: string;
  storagePath: string;
  path: string;
  sha: string;
}

export async function indexFile(file: FileToIndex): Promise<void> {
  // Get file content
  const content = await gitService.getFileContent(file.storagePath, file.sha, file.path);

  // Skip binary files
  if (isBinary(content)) return;

  // Skip files over 1MB
  if (content.length > 1024 * 1024) return;

  const extension = file.path.split('.').pop() || '';
  const filename = file.path.split('/').pop() || '';
  const language = detectLanguage(extension, content);

  // Extract symbols (functions, classes, methods)
  const symbols = extractSymbols(content, language);

  // Index document
  await es.index({
    index: 'code',
    id: `${file.repoId}:${file.path}:${file.sha}`,
    document: {
      repo_id: file.repoId,
      repo_name: file.repoName,
      owner: file.owner,
      path: file.path,
      filename,
      extension,
      language,
      content,
      symbols,
      commit_sha: file.sha,
      indexed_at: new Date(),
    },
  });
}

// Handle push events - incremental indexing
export async function handlePushEvent(
  repoId: number,
  storagePath: string,
  beforeSha: string,
  afterSha: string
): Promise<void> {
  // Get changed files
  const changes = await gitService.diffNameStatus(storagePath, beforeSha, afterSha);

  const repoResult = await pool.query(
    `SELECT r.name, u.username FROM repositories r
     JOIN users u ON r.owner_id = u.id WHERE r.id = $1`,
    [repoId]
  );
  const { name: repoName, username: owner } = repoResult.rows[0];

  // Process added/modified files
  for (const change of changes) {
    if (change.status === 'D') {
      // Delete from index
      await es.deleteByQuery({
        index: 'code',
        query: {
          bool: {
            must: [
              { term: { repo_id: repoId } },
              { term: { path: change.path } },
            ],
          },
        },
      });
    } else {
      // Index new/modified file
      await indexFile({
        repoId,
        repoName,
        owner,
        storagePath,
        path: change.path,
        sha: afterSha,
      });
    }
  }
}
```

### Search Query Implementation

```typescript
// backend/src/api/routes/search.ts
import { Router } from 'express';
import { Client } from '@elastic/elasticsearch';

const router = Router();
const es = new Client({ node: process.env.ELASTICSEARCH_URL });

interface SearchQuery {
  q: string;
  language?: string;
  repo?: string;
  owner?: string;
  path?: string;
  symbol?: string;
  page?: number;
  perPage?: number;
}

router.get('/code', async (req, res) => {
  const {
    q,
    language,
    repo,
    owner,
    path,
    symbol,
    page = 1,
    perPage = 20,
  } = req.query as unknown as SearchQuery;

  const must: any[] = [];
  const filter: any[] = [];

  // Symbol search (e.g., "def:calculateTotal" or "func:handleClick")
  if (symbol) {
    must.push({
      nested: {
        path: 'symbols',
        query: {
          bool: {
            must: [
              { match: { 'symbols.name': symbol } },
            ],
          },
        },
      },
    });
  } else {
    // Full-text code search
    must.push({ match: { content: q } });
  }

  // Filters
  if (language) filter.push({ term: { language } });
  if (repo) filter.push({ term: { repo_name: repo } });
  if (owner) filter.push({ term: { owner } });
  if (path) filter.push({ wildcard: { path: `*${path}*` } });

  const result = await es.search({
    index: 'code',
    from: (page - 1) * perPage,
    size: perPage,
    query: {
      bool: {
        must,
        filter,
      },
    },
    highlight: {
      fields: {
        content: {
          fragment_size: 150,
          number_of_fragments: 3,
          pre_tags: ['<mark>'],
          post_tags: ['</mark>'],
        },
      },
    },
    _source: ['repo_id', 'repo_name', 'owner', 'path', 'language', 'symbols'],
  });

  const hits = result.hits.hits.map((hit: any) => ({
    repo: `${hit._source.owner}/${hit._source.repo_name}`,
    path: hit._source.path,
    language: hit._source.language,
    highlights: hit.highlight?.content || [],
    symbols: hit._source.symbols,
  }));

  res.json({
    total: (result.hits.total as any).value,
    items: hits,
    page,
    perPage,
  });
});

export default router;
```

---

## 6. Deep Dive: Webhook Delivery System (8 min)

### Reliable Delivery with Retry Queue

```typescript
// backend/src/shared/webhooks.ts
import { createHmac } from 'crypto';
import { pool } from './db.js';
import { webhookQueue } from './queue.js';

interface WebhookPayload {
  action: string;
  [key: string]: any;
}

export async function emitWebhook(
  repoId: number,
  event: string,
  payload: WebhookPayload
): Promise<void> {
  // Get all active webhooks for this repo subscribed to this event
  const webhooksResult = await pool.query(
    `SELECT id, url, secret, events FROM webhooks
     WHERE repo_id = $1 AND is_active = true AND $2 = ANY(events)`,
    [repoId, event]
  );

  for (const webhook of webhooksResult.rows) {
    const deliveryId = crypto.randomUUID();

    // Queue for delivery
    await webhookQueue.add('deliver', {
      deliveryId,
      webhookId: webhook.id,
      url: webhook.url,
      secret: webhook.secret,
      event,
      payload,
      attempt: 1,
      scheduledAt: Date.now(),
    });
  }
}
```

### Webhook Worker with Exponential Backoff

```typescript
// backend/src/worker/webhook-worker.ts
import { createHmac } from 'crypto';
import { pool } from '../shared/db.js';
import { webhookQueue } from '../shared/queue.js';

interface WebhookJob {
  deliveryId: string;
  webhookId: number;
  url: string;
  secret: string;
  event: string;
  payload: any;
  attempt: number;
  scheduledAt: number;
}

const MAX_RETRIES = 10;
const TIMEOUT_MS = 30000;

webhookQueue.process('deliver', async (job) => {
  const data = job.data as WebhookJob;
  const startTime = Date.now();

  // Create HMAC signature
  const body = JSON.stringify(data.payload);
  const signature = createHmac('sha256', data.secret)
    .update(body)
    .digest('hex');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(data.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': data.event,
        'X-GitHub-Delivery': data.deliveryId,
        'X-Hub-Signature-256': `sha256=${signature}`,
        'User-Agent': 'GitHub-Hookshot/local',
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const duration = Date.now() - startTime;

    // Log delivery
    await logDelivery(data, {
      status: response.status,
      duration,
      responseBody: await response.text().catch(() => ''),
    });

    // Retry on 5xx errors
    if (response.status >= 500 && data.attempt < MAX_RETRIES) {
      await scheduleRetry(data);
    }
  } catch (error: any) {
    const duration = Date.now() - startTime;

    await logDelivery(data, {
      status: 0,
      duration,
      error: error.message,
    });

    if (data.attempt < MAX_RETRIES) {
      await scheduleRetry(data);
    }
  }
});

async function scheduleRetry(data: WebhookJob): Promise<void> {
  // Exponential backoff: 2^attempt seconds
  const delayMs = Math.pow(2, data.attempt) * 1000;

  await webhookQueue.add('deliver', {
    ...data,
    attempt: data.attempt + 1,
    scheduledAt: Date.now() + delayMs,
  }, {
    delay: delayMs,
  });
}

async function logDelivery(
  data: WebhookJob,
  result: { status: number; duration: number; responseBody?: string; error?: string }
): Promise<void> {
  await pool.query(
    `INSERT INTO webhook_deliveries
     (webhook_id, event, payload, response_status, response_body, duration_ms, attempt)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      data.webhookId,
      data.event,
      data.payload,
      result.status,
      result.responseBody || result.error,
      result.duration,
      data.attempt,
    ]
  );
}
```

### Retry Schedule

| Attempt | Delay | Cumulative Time |
|---------|-------|-----------------|
| 1 | Immediate | 0 |
| 2 | 2s | 2s |
| 3 | 4s | 6s |
| 4 | 8s | 14s |
| 5 | 16s | 30s |
| 6 | 32s | ~1 min |
| 7 | 64s | ~2 min |
| 8 | 128s | ~4 min |
| 9 | 256s | ~8 min |
| 10 | 512s | ~17 min |

---

## 7. Caching Strategy (3 min)

### Multi-Layer Cache

```typescript
// backend/src/shared/cache.ts
import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL });

const CACHE_TTL = {
  REPO_METADATA: 300,      // 5 minutes
  FILE_CONTENT: 3600,      // 1 hour (blobs are immutable)
  PR_DIFF: 600,            // 10 minutes
  BRANCH_LIST: 60,         // 1 minute
  COMMIT_HISTORY: 300,     // 5 minutes
};

export async function cacheGet<T>(key: string): Promise<T | null> {
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached);
  }
  return null;
}

export async function cacheSet<T>(key: string, value: T, ttl?: number): Promise<void> {
  await redis.setEx(key, ttl || 300, JSON.stringify(value));
}

// Invalidate on push
export async function invalidateRepoCache(repoId: number): Promise<void> {
  const pattern = `repo:${repoId}:*`;

  // Use SCAN instead of KEYS in production
  let cursor = 0;
  do {
    const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = result.cursor;
    if (result.keys.length > 0) {
      await redis.del(result.keys);
    }
  } while (cursor !== 0);
}
```

---

## 8. Trade-offs and Decisions

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Git storage | Object store | Database | Immutable, content-addressed, dedup |
| Code search | Elasticsearch | PostgreSQL FTS | Scale (1B files), tokenization |
| Webhooks | Queue-based | Synchronous | Reliability, non-blocking |
| Pack files | On-disk | Database | Git-native, compression |
| Merge strategies | 3 options | Single merge | Developer choice, clean history |

---

## 9. Summary

### Key Backend Decisions

1. **Content-addressed storage** for Git objects with automatic deduplication
2. **Pack files with delta compression** for storage efficiency
3. **Elasticsearch with custom code analyzer** for billion-file search
4. **Queue-based webhook delivery** with exponential backoff retries
5. **Redis caching** with event-driven invalidation

### Future Enhancements

- Large File Storage (LFS) for binary assets
- Partial clone for monorepo performance
- GitHub Actions CI/CD runner
- Dependabot dependency updates
- Code scanning for security vulnerabilities
