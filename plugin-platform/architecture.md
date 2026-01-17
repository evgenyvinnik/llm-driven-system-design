# Design Plugin Platform - Architecture

## System Overview

A web-based extension platform enabling developers to build, publish, and distribute plugins that extend core functionality. Core challenges involve secure sandboxing, API design, marketplace scale, and extension lifecycle management.

**Learning Goals:**
- Design secure plugin sandboxing
- Build versioned extension APIs
- Implement marketplace at scale
- Handle extension lifecycle

---

## Requirements

### Functional Requirements

1. **Install**: Add extensions from marketplace
2. **Run**: Execute extensions in sandboxed environment
3. **Publish**: Developers can submit extensions
4. **Manage**: Enable, disable, update extensions
5. **Discover**: Browse and search marketplace

### Non-Functional Requirements

- **Security**: Extensions cannot access arbitrary user data
- **Performance**: < 500ms extension activation
- **Scale**: 10,000+ extensions, 1M+ users
- **Reliability**: Platform works even if extension crashes

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Web Application                              │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Core App     │  │  Extension    │  │  Extension    │       │
│  │  (Main Thread)│  │  Host         │  │  Manager      │       │
│  │               │  │               │  │               │       │
│  │ - UI          │  │ - API Proxy   │  │ - Install     │       │
│  │ - Commands    │  │ - Messaging   │  │ - Lifecycle   │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
           │                    │
           │               Web Workers (Sandboxed)
           │          ┌────────┴────────┐
           │          ▼                 ▼
           │   ┌───────────────┐ ┌───────────────┐
           │   │ Extension A   │ │ Extension B   │
           │   │ (Isolated)    │ │ (Isolated)    │
           │   └───────────────┘ └───────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Backend Services                             │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Extension    │  │  Marketplace  │  │  User         │       │
│  │  Registry     │  │  Service      │  │  Service      │       │
│  │               │  │               │  │               │       │
│  │ - Metadata    │  │ - Search      │  │ - Auth        │       │
│  │ - Versions    │  │ - Rankings    │  │ - Settings    │       │
│  │ - Downloads   │  │ - Reviews     │  │ - Installs    │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Extension Sandboxing

**Web Worker Isolation:**
```javascript
class ExtensionHost {
  constructor() {
    this.workers = new Map() // extensionId -> Worker
    this.pendingRequests = new Map()
  }

  async loadExtension(extension) {
    // Create isolated Web Worker for extension
    const worker = new Worker('/extension-worker.js', {
      type: 'module',
      name: extension.id
    })

    // Set up message channel
    worker.onmessage = (e) => this.handleMessage(extension.id, e.data)
    worker.onerror = (e) => this.handleError(extension.id, e)

    // Initialize extension with limited API
    worker.postMessage({
      type: 'init',
      extensionId: extension.id,
      manifest: extension.manifest,
      permissions: extension.permissions,
      code: extension.bundleUrl
    })

    this.workers.set(extension.id, worker)
  }

  async callExtensionAPI(extensionId, method, args) {
    const worker = this.workers.get(extensionId)
    if (!worker) throw new Error('Extension not loaded')

    const requestId = uuid()

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject })

      worker.postMessage({
        type: 'api-call',
        requestId,
        method,
        args
      })

      // Timeout for unresponsive extensions
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId)
          reject(new Error('Extension API call timeout'))
        }
      }, 5000)
    })
  }

  handleMessage(extensionId, message) {
    if (message.type === 'api-response') {
      const pending = this.pendingRequests.get(message.requestId)
      if (pending) {
        this.pendingRequests.delete(message.requestId)
        if (message.error) {
          pending.reject(new Error(message.error))
        } else {
          pending.resolve(message.result)
        }
      }
    } else if (message.type === 'platform-api') {
      // Extension calling platform API
      this.handlePlatformAPI(extensionId, message)
    }
  }

  async handlePlatformAPI(extensionId, message) {
    const { requestId, api, method, args } = message
    const worker = this.workers.get(extensionId)

    try {
      // Check permissions before allowing API call
      const hasPermission = await this.checkPermission(extensionId, api, method)
      if (!hasPermission) {
        throw new Error(`Permission denied: ${api}.${method}`)
      }

      const result = await this.platformAPI[api][method](...args)
      worker.postMessage({
        type: 'platform-api-response',
        requestId,
        result
      })
    } catch (error) {
      worker.postMessage({
        type: 'platform-api-response',
        requestId,
        error: error.message
      })
    }
  }
}
```

### 2. Extension API

**Platform API Exposed to Extensions:**
```javascript
// extension-worker.js - Runs inside Web Worker
class ExtensionRuntime {
  constructor() {
    this.extensionId = null
    this.permissions = []
  }

  init(config) {
    this.extensionId = config.extensionId
    this.permissions = config.permissions

    // Dynamically import extension code
    import(config.code).then(module => {
      if (module.activate) {
        module.activate(this.createAPI())
      }
    })
  }

  createAPI() {
    // Create sandboxed API object
    return {
      // UI API
      ui: {
        showMessage: (message, type) =>
          this.callPlatformAPI('ui', 'showMessage', [message, type]),
        createPanel: (options) =>
          this.callPlatformAPI('ui', 'createPanel', [options]),
        registerCommand: (id, handler) =>
          this.registerCommand(id, handler)
      },

      // Storage API
      storage: {
        get: (key) =>
          this.callPlatformAPI('storage', 'get', [this.extensionId, key]),
        set: (key, value) =>
          this.callPlatformAPI('storage', 'set', [this.extensionId, key, value]),
        delete: (key) =>
          this.callPlatformAPI('storage', 'delete', [this.extensionId, key])
      },

      // Network API (requires permission)
      network: {
        fetch: async (url, options) => {
          if (!this.permissions.includes('network')) {
            throw new Error('Network permission required')
          }
          return this.callPlatformAPI('network', 'fetch', [url, options])
        }
      },

      // Events API
      events: {
        on: (event, handler) =>
          this.registerEventHandler(event, handler),
        off: (event, handler) =>
          this.unregisterEventHandler(event, handler)
      }
    }
  }

  async callPlatformAPI(api, method, args) {
    const requestId = uuid()

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject })

      self.postMessage({
        type: 'platform-api',
        requestId,
        api,
        method,
        args
      })
    })
  }
}

// Initialize runtime
const runtime = new ExtensionRuntime()
self.onmessage = (e) => {
  if (e.data.type === 'init') {
    runtime.init(e.data)
  }
  // Handle other messages...
}
```

### 3. Marketplace Service

**Extension Registry:**
```javascript
class MarketplaceService {
  async searchExtensions(query, options = {}) {
    const { category, sortBy = 'popularity', limit = 20, offset = 0 } = options

    // Build Elasticsearch query
    const esQuery = {
      bool: {
        must: [
          { match: { status: 'published' } },
          query ? { multi_match: {
            query,
            fields: ['name^3', 'description', 'tags^2']
          }} : { match_all: {} }
        ]
      }
    }

    if (category) {
      esQuery.bool.must.push({ term: { category } })
    }

    const sortOptions = {
      popularity: [{ install_count: 'desc' }],
      rating: [{ average_rating: 'desc' }],
      recent: [{ published_at: 'desc' }],
      trending: [{ weekly_downloads: 'desc' }]
    }

    const results = await elasticsearch.search({
      index: 'extensions',
      body: {
        query: esQuery,
        sort: sortOptions[sortBy],
        from: offset,
        size: limit
      }
    })

    return {
      extensions: results.hits.hits.map(h => h._source),
      total: results.hits.total.value
    }
  }

  async getExtension(extensionId) {
    const extension = await db.query(`
      SELECT
        e.*,
        u.username as author_name,
        u.avatar_url as author_avatar,
        (SELECT COUNT(*) FROM extension_installs WHERE extension_id = e.id) as install_count,
        (SELECT AVG(rating) FROM extension_reviews WHERE extension_id = e.id) as average_rating
      FROM extensions e
      JOIN users u ON u.id = e.author_id
      WHERE e.id = $1 AND e.status = 'published'
    `, [extensionId])

    if (!extension.rows[0]) return null

    // Get versions
    const versions = await db.query(`
      SELECT version, changelog, published_at, min_platform_version
      FROM extension_versions
      WHERE extension_id = $1
      ORDER BY published_at DESC
      LIMIT 10
    `, [extensionId])

    return {
      ...extension.rows[0],
      versions: versions.rows
    }
  }

  async publishExtension(authorId, manifest, bundle) {
    // Validate manifest
    this.validateManifest(manifest)

    // Security scan
    const scanResult = await this.securityScanner.scan(bundle)
    if (scanResult.hasIssues) {
      throw new Error(`Security issues found: ${scanResult.issues.join(', ')}`)
    }

    // Upload bundle to CDN
    const bundleUrl = await this.cdn.upload(
      `extensions/${manifest.id}/${manifest.version}/bundle.js`,
      bundle
    )

    // Create or update extension
    const extension = await db.query(`
      INSERT INTO extensions (id, author_id, name, description, category, icon_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        name = $3,
        description = $4,
        updated_at = NOW()
      RETURNING *
    `, [
      manifest.id,
      authorId,
      manifest.name,
      manifest.description,
      manifest.category,
      manifest.icon
    ])

    // Add version
    await db.query(`
      INSERT INTO extension_versions
        (extension_id, version, bundle_url, changelog, min_platform_version, permissions)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      manifest.id,
      manifest.version,
      bundleUrl,
      manifest.changelog,
      manifest.minPlatformVersion,
      manifest.permissions
    ])

    // Update search index
    await this.updateSearchIndex(extension.rows[0])

    return extension.rows[0]
  }
}
```

### 4. Installation Manager

**User Extension Management:**
```javascript
class InstallationManager {
  async installExtension(userId, extensionId, version = 'latest') {
    // Get extension version
    const extVersion = version === 'latest'
      ? await this.getLatestVersion(extensionId)
      : await this.getVersion(extensionId, version)

    if (!extVersion) {
      throw new Error('Extension version not found')
    }

    // Check platform compatibility
    if (!this.isCompatible(extVersion.minPlatformVersion)) {
      throw new Error('Extension requires newer platform version')
    }

    // Check permissions (prompt user if needed)
    const approved = await this.requestPermissions(
      userId,
      extensionId,
      extVersion.permissions
    )
    if (!approved) {
      throw new Error('Permissions not approved')
    }

    // Record installation
    await db.query(`
      INSERT INTO user_extensions
        (user_id, extension_id, version, installed_at, enabled)
      VALUES ($1, $2, $3, NOW(), true)
      ON CONFLICT (user_id, extension_id) DO UPDATE SET
        version = $3,
        installed_at = NOW(),
        enabled = true
    `, [userId, extensionId, extVersion.version])

    // Increment install count
    await db.query(`
      UPDATE extensions
      SET install_count = install_count + 1
      WHERE id = $1
    `, [extensionId])

    // Download and cache extension bundle
    const bundle = await this.downloadBundle(extVersion.bundleUrl)

    return {
      extensionId,
      version: extVersion.version,
      bundle
    }
  }

  async getUserExtensions(userId) {
    const extensions = await db.query(`
      SELECT
        ue.extension_id,
        ue.version,
        ue.enabled,
        ue.settings,
        e.name,
        e.icon_url,
        ev.bundle_url,
        ev.permissions
      FROM user_extensions ue
      JOIN extensions e ON e.id = ue.extension_id
      JOIN extension_versions ev ON ev.extension_id = e.id AND ev.version = ue.version
      WHERE ue.user_id = $1
    `, [userId])

    return extensions.rows
  }

  async checkForUpdates(userId) {
    const updates = await db.query(`
      SELECT
        ue.extension_id,
        ue.version as current_version,
        latest.version as latest_version,
        latest.changelog
      FROM user_extensions ue
      JOIN LATERAL (
        SELECT version, changelog
        FROM extension_versions
        WHERE extension_id = ue.extension_id
        ORDER BY published_at DESC
        LIMIT 1
      ) latest ON true
      WHERE ue.user_id = $1 AND ue.version != latest.version
    `, [userId])

    return updates.rows
  }
}
```

---

## Database Schema

```sql
-- Extensions
CREATE TABLE extensions (
  id VARCHAR(100) PRIMARY KEY,
  author_id UUID NOT NULL REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  category VARCHAR(50),
  icon_url VARCHAR(500),
  status VARCHAR(20) DEFAULT 'draft', -- draft, review, published, suspended
  install_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_extensions_status ON extensions(status);
CREATE INDEX idx_extensions_category ON extensions(category);
CREATE INDEX idx_extensions_author ON extensions(author_id);

-- Extension versions
CREATE TABLE extension_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_id VARCHAR(100) REFERENCES extensions(id),
  version VARCHAR(50) NOT NULL,
  bundle_url VARCHAR(500) NOT NULL,
  changelog TEXT,
  min_platform_version VARCHAR(20),
  permissions TEXT[],
  published_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (extension_id, version)
);

CREATE INDEX idx_versions_extension ON extension_versions(extension_id, published_at DESC);

-- User installations
CREATE TABLE user_extensions (
  user_id UUID REFERENCES users(id),
  extension_id VARCHAR(100) REFERENCES extensions(id),
  version VARCHAR(50) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  settings JSONB DEFAULT '{}',
  installed_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, extension_id)
);

-- Reviews
CREATE TABLE extension_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_id VARCHAR(100) REFERENCES extensions(id),
  user_id UUID REFERENCES users(id),
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (extension_id, user_id)
);

CREATE INDEX idx_reviews_extension ON extension_reviews(extension_id);
```

---

## Key Design Decisions

### 1. Web Workers for Sandboxing

**Decision**: Use Web Workers for extension isolation

**Rationale**:
- Separate JavaScript context
- Cannot access DOM directly (controlled via API)
- Can be terminated if unresponsive
- Browser-native security boundaries

### 2. Message-Based API

**Decision**: All extension API calls go through postMessage

**Rationale**:
- Enforces isolation
- Enables permission checking
- Async by design
- Easy to monitor and log

### 3. CDN-Hosted Bundles

**Decision**: Extension code hosted on CDN

**Rationale**:
- Fast global distribution
- Reduces platform load
- Enables caching
- Version immutability

---

## SLO/SLA Targets and Error Budgets

### Service Level Objectives

| Operation | p50 | p95 | p99 | Availability Target |
|-----------|-----|-----|-----|---------------------|
| Extension activation | 100ms | 300ms | 500ms | 99.9% |
| Marketplace search | 50ms | 150ms | 300ms | 99.5% |
| Extension install | 200ms | 800ms | 1500ms | 99.5% |
| API call (extension->platform) | 5ms | 20ms | 50ms | 99.9% |
| Bundle download (CDN) | 100ms | 500ms | 1000ms | 99.9% |

### Error Budgets

**Monthly Error Budget Allocation:**
- Extension Host (sandbox runtime): 0.1% downtime = ~43 minutes/month
- Marketplace Service: 0.5% = ~3.6 hours/month
- Installation Service: 0.5% = ~3.6 hours/month
- CDN/Bundle delivery: 0.1% = ~43 minutes/month

**Budget Burn Rate Alerts (for local dev, simulated):**
```javascript
// Example: Track error budget consumption
const SLO_CONFIG = {
  extensionActivation: {
    p99Target: 500, // ms
    availabilityTarget: 0.999,
    errorBudgetPercent: 0.1
  },
  marketplaceSearch: {
    p99Target: 300,
    availabilityTarget: 0.995,
    errorBudgetPercent: 0.5
  }
};

// Alert when consuming >10% of monthly budget in 1 hour
function checkBurnRate(service, errors, requests, windowMinutes) {
  const errorRate = errors / requests;
  const budgetConsumed = errorRate / (1 - SLO_CONFIG[service].availabilityTarget);
  const monthlyProjection = budgetConsumed * (30 * 24 * 60 / windowMinutes);
  return monthlyProjection > 1.0; // Burning faster than sustainable
}
```

### How SLOs Drive Architecture Choices

**Caching Strategy (driven by latency SLOs):**
- Extension metadata: 5-minute TTL in Valkey (marketplace p95 < 150ms)
- Search results: 1-minute TTL (frequently changing popularity rankings)
- Bundle URLs: 24-hour TTL (immutable once published)

**Replication Strategy (driven by availability SLOs):**
- PostgreSQL: Single instance for local dev; production would use streaming replication
- Elasticsearch: Single node for local dev; production would use 3-node cluster
- Valkey: Single instance for local dev; no replication needed for cache-only use

**Local Development Note:** These SLOs are targets for studying behavior. Use Prometheus histograms to measure actual latencies and compare against targets.

---

## Consistency and Idempotency Semantics

### Consistency Model by Operation

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Extension publish | Strong (serializable) | Version numbers must be unique, no duplicate versions |
| Install/uninstall | Strong (read-your-writes) | User sees immediate confirmation |
| Install count increment | Eventual | Approximate counts acceptable, high write volume |
| Review submission | Strong | User expects to see their review immediately |
| Search index update | Eventual (async) | Brief lag acceptable after publish |
| Extension settings save | Strong | User expects immediate persistence |

### Idempotency Keys and Replay Handling

**Extension Publishing:**
```javascript
// Idempotency key: combination of extension ID + version
// Replaying a publish request for same ID+version is safe
async function publishExtension(manifest, bundle, idempotencyKey) {
  // Check if this exact operation already succeeded
  const existing = await db.query(`
    SELECT id FROM extension_versions
    WHERE extension_id = $1 AND version = $2
  `, [manifest.id, manifest.version]);

  if (existing.rows.length > 0) {
    // Already published - return existing, don't create duplicate
    return { status: 'already_exists', version: manifest.version };
  }

  // Proceed with publish...
  await db.query(`
    INSERT INTO extension_versions (extension_id, version, bundle_url, ...)
    VALUES ($1, $2, $3, ...)
  `, [manifest.id, manifest.version, bundleUrl]);

  return { status: 'created', version: manifest.version };
}
```

**Installation Tracking:**
```javascript
// Idempotency: user_extensions has PRIMARY KEY (user_id, extension_id)
// UPSERT semantics prevent duplicate installations
async function installExtension(userId, extensionId, version) {
  const idempotencyKey = `install:${userId}:${extensionId}`;

  // Use Redis SETNX for distributed lock (10 second TTL)
  const acquired = await redis.set(idempotencyKey, '1', 'NX', 'EX', 10);

  if (!acquired) {
    // Another install in progress - wait for it
    return { status: 'in_progress' };
  }

  try {
    await db.query(`
      INSERT INTO user_extensions (user_id, extension_id, version, ...)
      VALUES ($1, $2, $3, ...)
      ON CONFLICT (user_id, extension_id) DO UPDATE SET
        version = EXCLUDED.version,
        updated_at = NOW()
    `, [userId, extensionId, version]);

    return { status: 'installed' };
  } finally {
    await redis.del(idempotencyKey);
  }
}
```

**Install Count Increment (eventual consistency):**
```javascript
// Problem: High-volume install counts with strong consistency = bottleneck
// Solution: Batch updates with eventual consistency

// Option 1: Increment in Redis, flush to PostgreSQL periodically
async function incrementInstallCount(extensionId) {
  await redis.hincrby('extension:installs', extensionId, 1);
}

// Background job runs every 30 seconds
async function flushInstallCounts() {
  const counts = await redis.hgetall('extension:installs');
  for (const [extensionId, count] of Object.entries(counts)) {
    await db.query(`
      UPDATE extensions SET install_count = install_count + $1
      WHERE id = $2
    `, [parseInt(count), extensionId]);
    await redis.hdel('extension:installs', extensionId);
  }
}
```

### Conflict Resolution

**Review Updates (last-write-wins):**
```sql
-- Users can only have one review per extension
-- Latest review overwrites previous
INSERT INTO extension_reviews (extension_id, user_id, rating, comment)
VALUES ($1, $2, $3, $4)
ON CONFLICT (extension_id, user_id) DO UPDATE SET
  rating = EXCLUDED.rating,
  comment = EXCLUDED.comment,
  created_at = NOW();
```

**Extension Settings (merge with user wins):**
```javascript
// Extension settings use JSON merge with user edits taking precedence
async function updateExtensionSettings(userId, extensionId, newSettings) {
  await db.query(`
    UPDATE user_extensions
    SET settings = settings || $3::jsonb,
        updated_at = NOW()
    WHERE user_id = $1 AND extension_id = $2
  `, [userId, extensionId, JSON.stringify(newSettings)]);
}
```

---

## Async Queue/Stream Architecture

### Queue System Overview

Use RabbitMQ for background jobs and fanout (fits local development pattern, easy Docker setup).

```
┌─────────────────────────────────────────────────────────────────────┐
│                        RabbitMQ Exchanges                           │
│                                                                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ extension.events │  │ background.jobs  │  │ notifications    │  │
│  │ (fanout)         │  │ (direct)         │  │ (topic)          │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│           │                      │                      │           │
│     ┌─────┴─────┐          ┌─────┴─────┐          ┌─────┴─────┐    │
│     ▼           ▼          ▼           ▼          ▼           ▼    │
│ ┌───────┐ ┌───────┐  ┌───────────┐ ┌───────┐  ┌─────────┐ ┌─────┐ │
│ │search │ │stats  │  │security   │ │index  │  │email    │ │push │ │
│ │update │ │agg    │  │scan       │ │build  │  │queue    │ │queue│ │
│ └───────┘ └───────┘  └───────────┘ └───────┘  └─────────┘ └─────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Queue Definitions and Delivery Semantics

```javascript
// queue-config.js
const QUEUE_CONFIG = {
  // Extension events fanout - multiple consumers receive same message
  extensionEvents: {
    exchange: 'extension.events',
    type: 'fanout',
    durable: true,
    queues: [
      { name: 'search-index-update', durable: true },
      { name: 'stats-aggregation', durable: true },
      { name: 'webhook-dispatch', durable: true }
    ]
  },

  // Background jobs - each message processed by exactly one worker
  backgroundJobs: {
    exchange: 'background.jobs',
    type: 'direct',
    durable: true,
    queues: [
      {
        name: 'security-scan',
        routingKey: 'security.scan',
        durable: true,
        prefetch: 1,  // Process one at a time (CPU intensive)
        deadLetterExchange: 'background.jobs.dlx'
      },
      {
        name: 'bundle-validation',
        routingKey: 'bundle.validate',
        durable: true,
        prefetch: 5,
        deadLetterExchange: 'background.jobs.dlx'
      }
    ]
  },

  // Notifications - routed by pattern
  notifications: {
    exchange: 'notifications',
    type: 'topic',
    durable: true,
    queues: [
      { name: 'email-notifications', bindingKey: 'notify.email.*' },
      { name: 'push-notifications', bindingKey: 'notify.push.*' }
    ]
  }
};
```

### Message Types and Handlers

**Extension Published Event:**
```javascript
// Producer: After successful publish
async function onExtensionPublished(extension, version) {
  await channel.publish('extension.events', '', Buffer.from(JSON.stringify({
    type: 'extension.published',
    timestamp: Date.now(),
    data: {
      extensionId: extension.id,
      version: version.version,
      authorId: extension.author_id,
      name: extension.name,
      category: extension.category
    }
  })), { persistent: true });
}

// Consumer 1: Update search index
async function handleSearchIndexUpdate(msg) {
  const event = JSON.parse(msg.content.toString());

  if (event.type === 'extension.published') {
    await elasticsearch.index({
      index: 'extensions',
      id: event.data.extensionId,
      body: {
        name: event.data.name,
        category: event.data.category,
        published_at: new Date(event.timestamp),
        // ... other searchable fields
      }
    });
  }

  channel.ack(msg);
}

// Consumer 2: Aggregate stats
async function handleStatsAggregation(msg) {
  const event = JSON.parse(msg.content.toString());

  if (event.type === 'extension.published') {
    await redis.hincrby('stats:daily:publishes', event.data.category, 1);
    await redis.hincrby('stats:author:publishes', event.data.authorId, 1);
  }

  channel.ack(msg);
}
```

**Security Scan Job (with retry and dead letter):**
```javascript
// Producer: Queue security scan after bundle upload
async function queueSecurityScan(extensionId, version, bundleUrl) {
  await channel.publish('background.jobs', 'security.scan', Buffer.from(JSON.stringify({
    jobId: `scan:${extensionId}:${version}`,
    extensionId,
    version,
    bundleUrl,
    attempt: 1,
    maxAttempts: 3,
    createdAt: Date.now()
  })), {
    persistent: true,
    messageId: `scan:${extensionId}:${version}` // For deduplication
  });
}

// Consumer: Security scanner worker
async function handleSecurityScan(msg) {
  const job = JSON.parse(msg.content.toString());

  try {
    const result = await runSecurityScan(job.bundleUrl);

    // Update extension status based on scan result
    await db.query(`
      UPDATE extension_versions
      SET security_status = $1, security_report = $2
      WHERE extension_id = $3 AND version = $4
    `, [
      result.passed ? 'passed' : 'failed',
      JSON.stringify(result),
      job.extensionId,
      job.version
    ]);

    channel.ack(msg);
  } catch (error) {
    if (job.attempt < job.maxAttempts) {
      // Retry with exponential backoff
      const delay = Math.pow(2, job.attempt) * 1000;

      setTimeout(() => {
        channel.publish('background.jobs', 'security.scan', Buffer.from(JSON.stringify({
          ...job,
          attempt: job.attempt + 1
        })), { persistent: true });
      }, delay);

      channel.ack(msg); // Ack original, retry is a new message
    } else {
      // Max retries exceeded - send to dead letter queue
      channel.nack(msg, false, false);
    }
  }
}
```

### Backpressure Handling

```javascript
// Backpressure via prefetch (consumer-side)
const PREFETCH_LIMITS = {
  'security-scan': 1,     // CPU intensive, one at a time
  'search-index-update': 10,
  'stats-aggregation': 50,
  'bundle-validation': 5
};

async function setupConsumer(queueName, handler) {
  const prefetch = PREFETCH_LIMITS[queueName] || 10;
  await channel.prefetch(prefetch);

  await channel.consume(queueName, async (msg) => {
    if (msg) {
      await handler(msg);
    }
  });
}

// Backpressure monitoring
async function getQueueHealth() {
  const queues = ['security-scan', 'search-index-update', 'bundle-validation'];
  const health = {};

  for (const queue of queues) {
    const info = await channel.checkQueue(queue);
    health[queue] = {
      messageCount: info.messageCount,
      consumerCount: info.consumerCount,
      backlogged: info.messageCount > 100 // Alert threshold
    };
  }

  return health;
}
```

### Docker Compose Addition

```yaml
# Add to docker-compose.yml
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"   # AMQP protocol
      - "15672:15672" # Management UI
    environment:
      RABBITMQ_DEFAULT_USER: plugin_platform
      RABBITMQ_DEFAULT_PASS: local_dev_password
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq

volumes:
  rabbitmq_data:
```

### Connection Configuration

```javascript
// shared/queue.ts
import amqp from 'amqplib';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://plugin_platform:local_dev_password@localhost:5672';

let connection: amqp.Connection | null = null;
let channel: amqp.Channel | null = null;

export async function getChannel(): Promise<amqp.Channel> {
  if (!connection) {
    connection = await amqp.connect(RABBITMQ_URL);
    connection.on('error', (err) => {
      console.error('RabbitMQ connection error:', err);
      connection = null;
      channel = null;
    });
  }

  if (!channel) {
    channel = await connection.createChannel();

    // Declare exchanges
    await channel.assertExchange('extension.events', 'fanout', { durable: true });
    await channel.assertExchange('background.jobs', 'direct', { durable: true });
    await channel.assertExchange('background.jobs.dlx', 'direct', { durable: true });
  }

  return channel;
}
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Sandboxing | Web Workers | iframes | Better isolation |
| Communication | postMessage | Shared memory | Security |
| Bundle hosting | CDN | Platform storage | Performance |
| Search | Elasticsearch | PostgreSQL FTS | Scale, features |
| Queue system | RabbitMQ | Kafka | Simpler for job semantics, easier local setup |
| Install count consistency | Eventual (batched) | Strong (per-request) | High volume writes, approximate ok |
| Idempotency | Application-level keys | Database constraints | Flexibility for distributed retry |
