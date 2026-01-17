# System Design: Plug-and-Play Web Platform (VS Code-like Extension System)

## Overview

Design a web-based platform with a rich extension ecosystem, similar to VS Code's extension model, where developers can build, publish, and distribute plugins that extend the core functionality. Users can discover, install, and manage extensions through a marketplace, while the platform ensures security, performance, and compatibility.

## Functional Requirements

### Core Platform Features

1. **Extension API**
   - Well-defined JavaScript API that extensions can use
   - Access to platform features (UI, storage, commands, events)
   - Versioned API (extensions declare API version compatibility)
   - Permissions system (extensions request capabilities)

2. **Extension Lifecycle**
   - Install extension from marketplace
   - Enable/disable extensions
   - Automatic updates (with user consent)
   - Uninstall and cleanup
   - Activation events (when to load an extension)

3. **Sandboxed Execution**
   - Extensions run in isolated environment (cannot access user data unless permitted)
   - Resource limits (CPU, memory, network)
   - Security boundaries (extensions cannot interfere with each other)

4. **Extension Marketplace**
   - Browse and search extensions
   - Install extensions with one click
   - User reviews and ratings
   - Download statistics and popularity metrics
   - Categories and tags (productivity, themes, language support)

5. **Developer Experience**
   - CLI tool to create, test, and publish extensions
   - Extension development documentation
   - Hot reload during development
   - Debugging tools (inspect extension state, logs)

### User Personas

#### End User (Platform User)
- Browse marketplace to discover extensions
- Install extensions to enhance productivity
- Configure extension settings
- Report broken or malicious extensions
- View extension permissions before installing

#### Extension Developer
- Develop extensions using platform API
- Test extensions locally
- Publish extensions to marketplace
- View download stats and user feedback
- Update extensions to fix bugs or add features

#### Platform Admin/Moderator
- Review extension submissions (security, quality)
- Monitor marketplace for malicious extensions
- Remove violating extensions
- View platform health metrics (extension crashes, performance)
- Manage featured extensions and categories

## Non-Functional Requirements

### Scale
- **Users:** 1 million active users
- **Extensions:** 10,000 published extensions
- **Installs:** 10 million total installations
- **Concurrent Users:** 100k users online simultaneously

### Performance
- **Extension Load Time:** < 500ms to activate an extension
- **Marketplace Search:** < 200ms to search and return results
- **API Response Time:** < 100ms for extension API calls
- **UI Responsiveness:** Extensions should not block main thread

### Security
- **Sandboxing:** Extensions cannot access arbitrary user data
- **Permissions:** Explicit user consent for sensitive operations
- **Code Review:** Extensions undergo basic security scan before approval
- **Isolation:** One extension's crash doesn't affect others

### Reliability
- **Availability:** 99.9% uptime for marketplace and extension API
- **Fault Tolerance:** Platform remains functional even if an extension crashes
- **Data Integrity:** User settings and extension data are durable

## Key Technical Challenges

1. **Secure Sandboxing**
   - How to run untrusted JavaScript code safely in the browser?
   - How to prevent extensions from accessing sensitive data (localStorage, cookies)?
   - How to limit resource usage (prevent infinite loops, memory leaks)?

2. **Extension API Design**
   - What APIs should be exposed to extensions?
   - How to version the API (backwards compatibility)?
   - How to handle breaking changes?

3. **Permission System**
   - What permissions should exist (storage, network, clipboard)?
   - How to present permissions to users clearly?
   - How to enforce permissions at runtime?

4. **Extension Discovery & Distribution**
   - How to package and distribute extensions?
   - How to handle versioning and updates?
   - How to ensure extensions are compatible with platform version?

5. **Performance & Resource Management**
   - How to prevent one extension from slowing down the entire platform?
   - How to lazy-load extensions (only load when needed)?
   - How to monitor extension performance (CPU, memory)?

## Architecture Approaches

### Approach 1: Iframe-Based Sandboxing (Simple)

**How it works:**
- Extensions run in sandboxed iframes (`sandbox` attribute)
- Message passing (postMessage) for communication
- Extensions have no direct access to parent page DOM

**Pros:**
- Built-in browser sandboxing (strong security)
- Easy to implement
- Good isolation (extension crash doesn't affect main app)

**Cons:**
- Limited API surface (can't directly manipulate main page DOM)
- Performance overhead (postMessage serialization)
- Complex communication pattern (async messages only)

**When to use:**
- High security requirements
- Extensions need limited access
- Learning sandbox concepts

### Approach 2: Web Workers + Proxy API (Intermediate)

**How it works:**
- Extensions run in Web Workers (separate thread)
- Proxy API in main thread handles DOM manipulation
- Extensions call API via message passing
- Main thread validates permissions and executes actions

**Pros:**
- Strong isolation (separate thread, no DOM access)
- Better performance (extensions don't block main thread)
- Flexible API design (proxy can expose any capability)

**Cons:**
- No direct DOM access (must use API)
- Async-only API (all calls are message-based)
- Complex debugging (Worker code is separate)

**When to use:**
- Performance-critical platform
- Extensions need background processing
- Production-ready security

### Approach 3: VM-Based Execution (Advanced)

**How it works:**
- Extensions run in isolated JavaScript VM (e.g., QuickJS, isolated-vm)
- Platform provides API through injected globals
- Fine-grained permission control (intercept all API calls)

**Pros:**
- Maximum flexibility (can expose synchronous APIs)
- Strong isolation (VM enforces boundaries)
- Resource limits (CPU, memory) enforced by VM

**Cons:**
- Requires native VM (Node.js addon or WASM)
- Complex implementation
- Performance overhead (VM initialization)

**When to use:**
- Need synchronous APIs
- Very large extension ecosystem
- Advanced isolation requirements

### Approach 4: Service Worker + Shared Worker (Modern Web)

**How it works:**
- Extensions are Service Workers (run in background)
- Shared Worker for inter-extension communication
- Extensions intercept network requests, handle events

**Pros:**
- Persistent background processing
- Network interception (powerful for proxy-like extensions)
- Native browser APIs

**Cons:**
- Complex lifecycle (Service Workers have their own lifecycle)
- Limited browser support (older browsers)
- Harder to debug

**When to use:**
- Extensions need background tasks
- Network interception required
- Progressive Web App (PWA) platform

## Recommended Approach: Web Workers + Proxy API (Approach 2)

**Rationale:**
- Balances security, performance, and developer experience
- Runs in all modern browsers (no native dependencies)
- Extensions can't block main thread (better UX)
- Can implement rich API surface via proxy pattern

**Trade-offs:**
- Extensions can't directly manipulate DOM (must use API)
- All API calls are async (may be unfamiliar to developers)
- Message passing overhead (but acceptable for most use cases)

## Technology Stack

### Core Stack (following CLAUDE.md defaults)
- **Frontend:** TypeScript + Vite + React 19 + Tanstack Router + Zustand + Tailwind
- **Backend:** Node.js + Express
- **Database:** PostgreSQL (extensions, users, reviews)
- **Storage:** S3 or file system for extension packages (.zip files)
- **Cache:** Redis (extension metadata, download counts)
- **Search:** Elasticsearch (marketplace search)

### Extension System
- **Sandbox:** Web Workers for extension execution
- **API:** Proxy pattern (main thread exposes API to workers)
- **Package Format:** ZIP file with manifest.json
- **Module Loading:** Dynamic import() for extension code

### Why Web Workers?

**Pros:**
- Runs JavaScript in separate thread (no main thread blocking)
- Strong isolation (no DOM access, limited APIs)
- Good browser support
- Can enforce resource limits (timeout workers)

**Cons:**
- Async communication only (postMessage)
- Cannot directly manipulate DOM

**Decision:** Web Workers + Proxy API provides the best balance of security, performance, and developer experience for a web-based extension platform.

## Detailed Design

### Extension Manifest

Every extension has a `manifest.json` file:

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "displayName": "My Awesome Extension",
  "description": "Does something cool",
  "author": "John Doe",
  "license": "MIT",

  "main": "extension.js",
  "icon": "icon.png",

  "engines": {
    "platform": "^1.0.0"
  },

  "activationEvents": [
    "onStartup",
    "onCommand:myExtension.doSomething"
  ],

  "permissions": [
    "storage",
    "network",
    "clipboard"
  ],

  "contributes": {
    "commands": [
      {
        "id": "myExtension.doSomething",
        "title": "Do Something Cool"
      }
    ],
    "settings": [
      {
        "key": "myExtension.apiKey",
        "type": "string",
        "default": "",
        "description": "API key for external service"
      }
    ]
  }
}
```

### Extension Package Structure

```
my-extension.zip
├── manifest.json          # Extension metadata
├── extension.js           # Main extension code
├── icon.png               # Extension icon (128x128)
├── README.md              # Documentation
└── lib/                   # Optional libraries
    └── helper.js
```

### Extension API Design

**Core API Modules:**

```typescript
// Exposed to extensions via Worker
interface PlatformAPI {
  // Storage API (scoped to extension)
  storage: {
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<void>;
    delete(key: string): Promise<void>;
  };

  // UI API
  ui: {
    showNotification(message: string, type: 'info' | 'warning' | 'error'): void;
    showModal(title: string, content: string): Promise<boolean>;
    registerPanel(id: string, title: string, render: () => void): void;
  };

  // Commands API
  commands: {
    registerCommand(id: string, handler: () => void): void;
    executeCommand(id: string): Promise<void>;
  };

  // Events API
  events: {
    on(event: string, handler: (data: any) => void): void;
    emit(event: string, data: any): void;
  };

  // Network API (if permission granted)
  network: {
    fetch(url: string, options?: RequestInit): Promise<Response>;
  };

  // Clipboard API (if permission granted)
  clipboard: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
  };
}
```

**Example Extension:**

```typescript
// extension.js (runs in Web Worker)

// Activate function (called when extension loads)
export function activate(api: PlatformAPI) {
  console.log('My extension activated!');

  // Register a command
  api.commands.registerCommand('myExtension.doSomething', async () => {
    // Get data from storage
    const count = await api.storage.get('clickCount') || 0;

    // Update count
    await api.storage.set('clickCount', count + 1);

    // Show notification
    api.ui.showNotification(`Button clicked ${count + 1} times!`, 'info');
  });

  // Listen for events
  api.events.on('platform:ready', () => {
    console.log('Platform is ready!');
  });
}

// Deactivate function (called when extension unloads)
export function deactivate() {
  console.log('My extension deactivated!');
}
```

### Extension Execution (Web Worker)

**Main Thread (Host Application):**

```typescript
class ExtensionHost {
  private workers: Map<string, Worker> = new Map();
  private apiHandlers: Map<string, Function> = new Map();

  async loadExtension(extensionId: string) {
    // 1. Fetch extension code
    const code = await this.fetchExtensionCode(extensionId);

    // 2. Create Web Worker
    const workerBlob = new Blob([code], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(workerBlob);
    const worker = new Worker(workerUrl);

    // 3. Setup message handler
    worker.onmessage = (event) => {
      this.handleWorkerMessage(extensionId, event.data);
    };

    worker.onerror = (error) => {
      console.error(`Extension ${extensionId} error:`, error);
      this.unloadExtension(extensionId);
    };

    // 4. Inject API bootstrap code
    worker.postMessage({
      type: 'init',
      api: this.generateAPIStubs()
    });

    // 5. Store worker
    this.workers.set(extensionId, worker);

    // 6. Call activate()
    worker.postMessage({ type: 'activate' });
  }

  private handleWorkerMessage(extensionId: string, message: any) {
    const { type, method, args, callId } = message;

    if (type === 'api-call') {
      // Extension is calling a platform API
      this.executeAPICall(extensionId, method, args).then(result => {
        // Send result back to worker
        const worker = this.workers.get(extensionId);
        worker?.postMessage({
          type: 'api-response',
          callId,
          result
        });
      });
    }
  }

  private async executeAPICall(extensionId: string, method: string, args: any[]) {
    // Check permissions
    if (!this.hasPermission(extensionId, method)) {
      throw new Error(`Extension ${extensionId} does not have permission for ${method}`);
    }

    // Execute API method
    switch (method) {
      case 'storage.get':
        return await this.storageGet(extensionId, args[0]);

      case 'storage.set':
        return await this.storageSet(extensionId, args[0], args[1]);

      case 'ui.showNotification':
        return this.uiShowNotification(args[0], args[1]);

      // ... other API methods
    }
  }

  private async storageGet(extensionId: string, key: string): Promise<any> {
    // Storage is scoped to extension
    const fullKey = `ext:${extensionId}:${key}`;
    const value = localStorage.getItem(fullKey);
    return value ? JSON.parse(value) : null;
  }

  private async storageSet(extensionId: string, key: string, value: any): Promise<void> {
    const fullKey = `ext:${extensionId}:${key}`;
    localStorage.setItem(fullKey, JSON.stringify(value));
  }

  private uiShowNotification(message: string, type: string) {
    // Show toast notification in main UI
    toast(message, { type });
  }

  unloadExtension(extensionId: string) {
    const worker = this.workers.get(extensionId);
    if (worker) {
      worker.postMessage({ type: 'deactivate' });
      worker.terminate();
      this.workers.delete(extensionId);
    }
  }
}
```

**Worker Thread (Extension Code):**

```typescript
// This code runs inside the Web Worker

// API stub that sends messages to main thread
const api = {
  storage: {
    get(key: string): Promise<any> {
      return callAPI('storage.get', [key]);
    },
    set(key: string, value: any): Promise<void> {
      return callAPI('storage.set', [key, value]);
    }
  },
  ui: {
    showNotification(message: string, type: string) {
      return callAPI('ui.showNotification', [message, type]);
    }
  }
  // ... other API modules
};

// Message passing helper
let callIdCounter = 0;
const pendingCalls = new Map<number, { resolve: Function, reject: Function }>();

function callAPI(method: string, args: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const callId = callIdCounter++;
    pendingCalls.set(callId, { resolve, reject });

    // Send message to main thread
    self.postMessage({
      type: 'api-call',
      method,
      args,
      callId
    });
  });
}

// Listen for responses from main thread
self.onmessage = (event) => {
  const { type, callId, result } = event.data;

  if (type === 'api-response') {
    const pending = pendingCalls.get(callId);
    if (pending) {
      pending.resolve(result);
      pendingCalls.delete(callId);
    }
  }

  if (type === 'activate') {
    // Call extension's activate function
    activate(api);
  }

  if (type === 'deactivate') {
    // Call extension's deactivate function
    deactivate?.();
  }
};

// Extension code (provided by developer)
function activate(api: PlatformAPI) {
  // Extension logic here
}
```

### Permission System

**Permission Types:**

```typescript
type Permission =
  | 'storage'        // Access to persistent storage
  | 'network'        // Fetch external resources
  | 'clipboard'      // Read/write clipboard
  | 'notifications'  // Show notifications
  | 'filesystem'     // Access to virtual file system
  | 'camera'         // Access webcam
  | 'microphone';    // Access microphone

// Stored in database
interface ExtensionPermissions {
  extensionId: string;
  requestedPermissions: Permission[];
  grantedPermissions: Permission[];  // Subset of requested (user may deny some)
}
```

**Permission Granting Flow:**

```typescript
async function installExtension(extensionId: string) {
  // 1. Fetch extension manifest
  const manifest = await fetchManifest(extensionId);

  // 2. Show permission dialog to user
  const requestedPermissions = manifest.permissions;
  const granted = await showPermissionDialog(requestedPermissions);

  if (!granted) {
    throw new Error('User denied permissions');
  }

  // 3. Store granted permissions
  await db.query(
    'INSERT INTO extension_permissions (extension_id, granted_permissions) VALUES ($1, $2)',
    [extensionId, requestedPermissions]
  );

  // 4. Download and install extension
  await downloadExtension(extensionId);
}

// Permission check at runtime
function hasPermission(extensionId: string, permission: Permission): boolean {
  const permissions = getGrantedPermissions(extensionId);
  return permissions.includes(permission);
}
```

**Permission Dialog (React Component):**

```typescript
function PermissionDialog({ extensionName, permissions, onGrant, onDeny }) {
  return (
    <div className="modal">
      <h2>Install {extensionName}?</h2>
      <p>This extension requests the following permissions:</p>
      <ul>
        {permissions.map(perm => (
          <li key={perm}>
            <strong>{perm}</strong>: {getPermissionDescription(perm)}
          </li>
        ))}
      </ul>
      <div className="actions">
        <button onClick={onGrant}>Install</button>
        <button onClick={onDeny}>Cancel</button>
      </div>
    </div>
  );
}

function getPermissionDescription(permission: Permission): string {
  const descriptions = {
    storage: 'Store data locally',
    network: 'Access external websites and APIs',
    clipboard: 'Read and write clipboard content',
    notifications: 'Show notifications',
    filesystem: 'Access files (with your permission)',
    camera: 'Access your camera',
    microphone: 'Access your microphone'
  };
  return descriptions[permission] || 'Unknown permission';
}
```

### Extension Marketplace

**Database Schema:**

```sql
-- Extensions
CREATE TABLE extensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,  -- e.g., "my-extension"
  display_name VARCHAR(200) NOT NULL,  -- e.g., "My Awesome Extension"
  description TEXT,
  author_id UUID NOT NULL REFERENCES users(id),
  version VARCHAR(20) NOT NULL,  -- e.g., "1.2.3"
  icon_url VARCHAR(500),

  category VARCHAR(50),  -- productivity, themes, language-support
  tags TEXT[],           -- ['javascript', 'linting', 'code-quality']

  status VARCHAR(20) DEFAULT 'pending',  -- pending, approved, rejected, banned
  published_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  INDEX idx_category (category),
  INDEX idx_status (status),
  INDEX idx_published (published_at DESC)
);

-- Extension Versions (support multiple versions)
CREATE TABLE extension_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_id UUID NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  version VARCHAR(20) NOT NULL,
  package_url VARCHAR(500) NOT NULL,  -- S3 URL to .zip file
  manifest JSONB NOT NULL,            -- Full manifest.json
  changelog TEXT,
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE (extension_id, version)
);

-- Installations (track who installed what)
CREATE TABLE extension_installations (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extension_id UUID NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  version VARCHAR(20) NOT NULL,
  installed_at TIMESTAMP DEFAULT NOW(),

  PRIMARY KEY (user_id, extension_id)
);

-- Reviews and Ratings
CREATE TABLE extension_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_id UUID NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INT CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE (extension_id, user_id)
);

-- Download stats (aggregated)
CREATE TABLE extension_stats (
  extension_id UUID NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  downloads INT DEFAULT 0,
  active_installs INT DEFAULT 0,

  PRIMARY KEY (extension_id, date)
);
```

**Marketplace API Endpoints:**

```typescript
// Browse extensions
app.get('/api/marketplace/extensions', async (req, res) => {
  const { category, search, sort, page = 1, limit = 20 } = req.query;

  let query = 'SELECT * FROM extensions WHERE status = $1';
  const params = ['approved'];

  if (category) {
    query += ' AND category = $2';
    params.push(category);
  }

  if (search) {
    // Full-text search via Elasticsearch
    const results = await elasticsearch.search({
      index: 'extensions',
      body: {
        query: {
          multi_match: {
            query: search,
            fields: ['display_name', 'description', 'tags']
          }
        }
      }
    });

    const extensionIds = results.hits.hits.map(hit => hit._source.id);
    query += ` AND id = ANY($${params.length + 1})`;
    params.push(extensionIds);
  }

  // Sorting
  if (sort === 'popular') {
    query += ' ORDER BY (SELECT COUNT(*) FROM extension_installations WHERE extension_id = extensions.id) DESC';
  } else if (sort === 'recent') {
    query += ' ORDER BY published_at DESC';
  } else {
    query += ' ORDER BY display_name ASC';
  }

  query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, (page - 1) * limit);

  const extensions = await db.query(query, params);

  res.json({ extensions: extensions.rows });
});

// Get extension details
app.get('/api/marketplace/extensions/:id', async (req, res) => {
  const { id } = req.params;

  const extension = await db.query('SELECT * FROM extensions WHERE id = $1', [id]);

  if (extension.rows.length === 0) {
    return res.status(404).json({ error: 'Extension not found' });
  }

  // Get latest version
  const version = await db.query(
    'SELECT * FROM extension_versions WHERE extension_id = $1 ORDER BY created_at DESC LIMIT 1',
    [id]
  );

  // Get stats
  const stats = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM extension_installations WHERE extension_id = $1) as installs,
       (SELECT AVG(rating) FROM extension_reviews WHERE extension_id = $1) as avg_rating,
       (SELECT COUNT(*) FROM extension_reviews WHERE extension_id = $1) as review_count`,
    [id]
  );

  res.json({
    extension: extension.rows[0],
    latestVersion: version.rows[0],
    stats: stats.rows[0]
  });
});

// Install extension
app.post('/api/marketplace/extensions/:id/install', authenticate, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  // Get latest version
  const version = await db.query(
    'SELECT * FROM extension_versions WHERE extension_id = $1 ORDER BY created_at DESC LIMIT 1',
    [id]
  );

  if (version.rows.length === 0) {
    return res.status(404).json({ error: 'Extension not found' });
  }

  // Record installation
  await db.query(
    `INSERT INTO extension_installations (user_id, extension_id, version)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, extension_id) DO UPDATE SET version = $3`,
    [userId, id, version.rows[0].version]
  );

  // Increment download count
  await db.query(
    `INSERT INTO extension_stats (extension_id, date, downloads)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (extension_id, date) DO UPDATE SET downloads = extension_stats.downloads + 1`,
    [id]
  );

  res.json({ installed: true, version: version.rows[0] });
});
```

### Extension Publishing (Developer Workflow)

**CLI Tool:**

```bash
# Install CLI
npm install -g @platform/extension-cli

# Create new extension
platform-ext create my-extension
cd my-extension

# Develop locally (hot reload)
platform-ext dev

# Package extension
platform-ext package
# Creates: my-extension-1.0.0.zip

# Publish to marketplace
platform-ext publish --api-key YOUR_API_KEY
```

**Publish API:**

```typescript
// POST /api/marketplace/extensions/publish
app.post('/api/marketplace/extensions/publish', authenticate, upload.single('package'), async (req, res) => {
  const userId = req.user.id;
  const packageFile = req.file; // .zip file

  // 1. Extract and validate manifest
  const manifest = await extractManifest(packageFile.path);

  if (!isValidManifest(manifest)) {
    return res.status(400).json({ error: 'Invalid manifest' });
  }

  // 2. Security scan (basic checks)
  const securityIssues = await scanExtension(packageFile.path);
  if (securityIssues.length > 0) {
    return res.status(400).json({ error: 'Security issues found', issues: securityIssues });
  }

  // 3. Upload package to S3
  const packageUrl = await uploadToS3(packageFile.path, `extensions/${manifest.name}/${manifest.version}.zip`);

  // 4. Create or update extension
  await db.query(
    `INSERT INTO extensions (name, display_name, description, author_id, version, category, tags, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     ON CONFLICT (name) DO UPDATE SET
       version = $5,
       description = $3,
       updated_at = NOW()`,
    [
      manifest.name,
      manifest.displayName,
      manifest.description,
      userId,
      manifest.version,
      manifest.category,
      manifest.tags
    ]
  );

  // 5. Create version entry
  await db.query(
    'INSERT INTO extension_versions (extension_id, version, package_url, manifest) VALUES ((SELECT id FROM extensions WHERE name = $1), $2, $3, $4)',
    [manifest.name, manifest.version, packageUrl, JSON.stringify(manifest)]
  );

  res.json({ success: true, message: 'Extension submitted for review' });
});
```

## Admin Dashboard

### Extension Review Queue

**API: GET /api/admin/extensions/pending**

```typescript
app.get('/api/admin/extensions/pending', authenticate, requireRole('admin'), async (req, res) => {
  const pending = await db.query(`
    SELECT e.*, u.username as author_name, ev.manifest
    FROM extensions e
    JOIN users u ON e.author_id = u.id
    JOIN extension_versions ev ON e.id = ev.extension_id
    WHERE e.status = 'pending'
    ORDER BY e.created_at ASC
  `);

  res.json({ extensions: pending.rows });
});
```

**Security Scan Results:**

```typescript
async function scanExtension(packagePath: string): Promise<string[]> {
  const issues: string[] = [];

  // Extract code
  const code = await extractExtensionCode(packagePath);

  // Check for suspicious patterns
  if (code.includes('eval(')) {
    issues.push('Uses eval() which is a security risk');
  }

  if (code.includes('document.cookie')) {
    issues.push('Attempts to access cookies');
  }

  if (/fetch\s*\(\s*['"`][^'"`]*password[^'"`]*['"`]\s*\)/.test(code)) {
    issues.push('May be sending passwords to external server');
  }

  // Check for obfuscated code
  const obfuscationScore = detectObfuscation(code);
  if (obfuscationScore > 0.7) {
    issues.push('Code appears to be heavily obfuscated');
  }

  return issues;
}
```

**Approval/Rejection:**

```typescript
app.post('/api/admin/extensions/:id/approve', authenticate, requireRole('admin'), async (req, res) => {
  const { id } = req.params;

  await db.query(
    'UPDATE extensions SET status = $1, published_at = NOW() WHERE id = $2',
    ['approved', id]
  );

  // Index in Elasticsearch for search
  await indexExtensionInElasticsearch(id);

  res.json({ success: true });
});

app.post('/api/admin/extensions/:id/reject', authenticate, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  await db.query(
    'UPDATE extensions SET status = $1 WHERE id = $2',
    ['rejected', id]
  );

  // Notify author
  await sendEmailToAuthor(id, `Your extension was rejected: ${reason}`);

  res.json({ success: true });
});
```

### Platform Health Metrics

**Extension Crash Tracking:**

```typescript
// Frontend: Report extension errors
window.addEventListener('error', (event) => {
  if (event.filename?.includes('/extensions/')) {
    // Extension error
    reportExtensionError({
      extensionId: getCurrentExtensionId(event.filename),
      error: event.message,
      stack: event.error?.stack
    });
  }
});

// Backend: Track errors
app.post('/api/telemetry/extension-error', async (req, res) => {
  const { extensionId, error, stack } = req.body;

  await db.query(
    'INSERT INTO extension_errors (extension_id, error_message, stack_trace, occurred_at) VALUES ($1, $2, $3, NOW())',
    [extensionId, error, stack]
  );

  // Check if error rate is high
  const recentErrors = await db.query(
    'SELECT COUNT(*) FROM extension_errors WHERE extension_id = $1 AND occurred_at > NOW() - INTERVAL \'1 hour\'',
    [extensionId]
  );

  if (recentErrors.rows[0].count > 100) {
    // High error rate, flag for review
    await db.query('UPDATE extensions SET status = $1 WHERE id = $2', ['flagged', extensionId]);
  }

  res.json({ success: true });
});
```

## Implementation Phases

### Phase 1: Core Extension System
**Goal:** Load and execute basic extensions

**Tasks:**
1. Implement Web Worker-based extension host
2. Define basic Extension API (storage, ui.showNotification)
3. Implement message passing between worker and main thread
4. Load sample extension from file system
5. Test extension lifecycle (activate, deactivate)

**Success Criteria:**
- Can load a simple extension
- Extension can call API methods
- Extension can store/retrieve data

### Phase 2: Permission System
**Goal:** Secure extension execution with permissions

**Tasks:**
1. Define permission types
2. Implement permission checking at runtime
3. Build permission request UI
4. Store granted permissions in database
5. Test with extension requesting multiple permissions

**Success Criteria:**
- Extensions cannot call APIs without permission
- User can grant/deny permissions
- Permissions persist across sessions

### Phase 3: Marketplace (Backend)
**Goal:** Publish and discover extensions

**Tasks:**
1. Implement database schema (extensions, versions, reviews)
2. Build marketplace API (browse, search, install)
3. Implement extension packaging (ZIP format)
4. Create extension publishing API
5. Test publishing and installing extensions

**Success Criteria:**
- Developers can publish extensions
- Users can browse and install extensions
- Versioning works (multiple versions supported)

### Phase 4: Marketplace (Frontend)
**Goal:** User-friendly marketplace UI

**Tasks:**
1. Build marketplace browser (React components)
2. Implement search (Elasticsearch integration)
3. Extension detail page (description, reviews, install button)
4. My Extensions page (manage installed extensions)
5. Test UI flows

**Success Criteria:**
- Users can search and find extensions
- One-click install works
- Users can enable/disable installed extensions

### Phase 5: Developer Tools
**Goal:** Make extension development easy

**Tasks:**
1. Create CLI tool (create, package, publish)
2. Implement hot reload for local development
3. Build extension debugging tools (logs, state inspector)
4. Write developer documentation
5. Create example extensions

**Success Criteria:**
- Developers can scaffold new extensions with CLI
- Hot reload works (edit code, see changes immediately)
- Debugging tools help troubleshoot issues

### Phase 6: Admin & Security
**Goal:** Moderation and security

**Tasks:**
1. Build admin review queue
2. Implement basic security scanning
3. Track extension errors and crashes
4. Build admin dashboard (stats, health metrics)
5. Test malicious extension detection

**Success Criteria:**
- Admins can approve/reject extensions
- Security scan catches obvious issues
- Crash tracking works

## Distributed System Challenges

### Challenge 1: Extension Updates

**Problem:** User has version 1.0.0 installed. Developer publishes 1.1.0. How to update?

**Solutions:**

**Option A: Manual Update (User-initiated)**
- Show "Update available" notification
- User clicks to update
- Simple, predictable

**Option B: Automatic Update (Background)**
- Periodically check for updates
- Auto-download and install (with user consent)
- Better UX, but can break if new version has bugs

**Option C: Automatic with Rollback**
- Auto-update in background
- If extension crashes after update, auto-rollback to previous version
- Best UX, more complex

**Recommendation:** Option B (auto-update with consent) for most extensions. Critical extensions (e.g., security) use Option C.

### Challenge 2: Extension Performance Monitoring

**Problem:** How to detect if an extension is slow or using too much memory?

**Solutions:**

**Option A: Resource Limits in Worker**
```typescript
// Terminate worker if it takes too long
const worker = new Worker(workerUrl);
const timeout = setTimeout(() => {
  console.warn(`Extension ${extensionId} timed out`);
  worker.terminate();
}, 10000); // 10 second timeout

worker.onmessage = () => {
  clearTimeout(timeout);
};
```

**Option B: Performance Monitoring**
```typescript
// Track API call latency
const startTime = performance.now();
await executeAPICall(extensionId, method, args);
const duration = performance.now() - startTime;

if (duration > 1000) {
  // API call took over 1 second
  await reportSlowExtension(extensionId, method, duration);
}
```

**Recommendation:** Combine both. Use timeouts to prevent infinite loops, and monitor performance to flag slow extensions for review.

### Challenge 3: Extension Compatibility

**Problem:** Platform API changes. Old extensions break.

**Solutions:**

**Option A: API Versioning**
```typescript
// Extension declares API version in manifest
{
  "engines": {
    "platform": "^1.0.0"  // Supports 1.x.x
  }
}

// Platform provides compatibility shims
if (manifest.engines.platform === '^1.0.0') {
  // Use API v1 wrapper
  api = new APIv1Wrapper(coreAPI);
} else {
  // Use API v2
  api = coreAPI;
}
```

**Option B: Deprecation Warnings**
- Mark old APIs as deprecated
- Show warnings in developer tools
- Give developers 6 months to migrate

**Recommendation:** API versioning (Option A) with deprecation warnings (Option B) for smooth migrations.

## Learning Outcomes

By implementing this platform, you will learn:

1. **Plugin Architecture**
   - Designing extensible systems
   - API design for third-party developers
   - Versioning and backwards compatibility

2. **Web Security**
   - Sandboxing untrusted code
   - Permission systems
   - Security scanning and code review

3. **Web Workers**
   - Multi-threaded JavaScript
   - Message passing patterns
   - Performance optimization

4. **Marketplace Dynamics**
   - Extension discovery and search
   - Review and rating systems
   - Developer experience

5. **Distributed Systems**
   - Extension updates and versioning
   - Performance monitoring
   - Fault tolerance (extension crashes)

## Next Steps / Extensions

1. **Advanced Sandboxing**
   - Use iframe + CSP for stronger isolation
   - Run extensions in separate origin (cross-origin isolation)

2. **Extension Themes**
   - Allow extensions to provide custom themes
   - Theme marketplace

3. **Extension Dependencies**
   - Extensions can depend on other extensions
   - Automatic dependency resolution

4. **Extension Collaboration**
   - Extensions can expose APIs to other extensions
   - Build complex workflows by chaining extensions

5. **Mobile Support**
   - Extension system for mobile apps
   - Lightweight extensions for performance

## References

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Chrome Extension Architecture](https://developer.chrome.com/docs/extensions/mv3/architecture-overview/)
- [Web Workers Specification](https://html.spec.whatwg.org/multipage/workers.html)
- [Browser Extension Security](https://www.usenix.org/system/files/conference/usenixsecurity12/sec12-final228.pdf)
- [Figma Plugin API](https://www.figma.com/plugin-docs/)
- [Notion API](https://developers.notion.com/)
