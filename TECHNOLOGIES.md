# Technology Stack Reference

This document provides a comprehensive overview of all technologies and packages used across the system design projects in this repository. Each technology is explained with its purpose, where it's used, and what alternatives exist.

---

## Table of Contents

1. [Frontend Technologies](#frontend-technologies)
2. [Backend Technologies](#backend-technologies)
3. [Database Technologies](#database-technologies)
4. [Message Queues & Event Streaming](#message-queues--event-streaming)
5. [Development Tools](#development-tools)
6. [Infrastructure & Deployment](#infrastructure--deployment)
7. [Monitoring & Observability](#monitoring--observability)

---

## Frontend Technologies

### Core Framework

#### React (v18/v19)
**What it is:** A JavaScript library for building user interfaces using a component-based architecture.

**Why we use it:**
- Declarative UI makes code predictable and easier to debug
- Component reusability across projects
- Rich ecosystem with extensive community support
- Virtual DOM for efficient updates
- React 19 introduces new features like Server Components and improved Suspense

**Where it's used:** All frontend projects (figma, discord, google-docs, twitter, airbnb, etc.)

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Vue.js** | Simpler learning curve, less ecosystem depth |
| **Svelte** | Compiles to vanilla JS (smaller bundle), smaller ecosystem |
| **SolidJS** | Better performance, React-like syntax, smaller community |
| **Angular** | Full framework (opinionated), steeper learning curve |

---

### Build Tools

#### Vite (v6)
**What it is:** A next-generation frontend build tool that leverages native ES modules for fast development.

**Why we use it:**
- Instant dev server startup (uses native ESM, no bundling in dev)
- Fast Hot Module Replacement (HMR)
- Optimized production builds with Rollup
- First-class TypeScript support
- Simple configuration

**Where it's used:** All frontend projects

**How it works:**
```
Development: Browser requests ES modules → Vite serves source files directly
Production:  Vite bundles with Rollup → Optimized static assets
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Webpack** | More mature, more configuration, slower dev startup |
| **Parcel** | Zero-config, less flexibility |
| **esbuild** | Extremely fast, less plugin ecosystem |
| **Turbopack** | Next.js focused, still maturing |

---

### Routing

#### TanStack Router (v1)
**What it is:** A fully type-safe router for React with file-based routing support.

**Why we use it:**
- Full TypeScript type safety for routes and params
- File-based routing option reduces boilerplate
- Built-in data loading with loaders
- Devtools for debugging
- Modern API design

**Where it's used:** discord, web-crawler, fb-post-search, airbnb, and most newer projects

**Example route tree:**
```
src/routes/
├── __root.tsx      # Root layout
├── index.tsx       # / route
├── about.tsx       # /about route
└── users/
    ├── $userId.tsx # /users/:userId route
    └── index.tsx   # /users route
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **React Router v6** | More mature, less type-safe, larger ecosystem |
| **Wouter** | Minimal, less features, ~1KB |
| **Next.js App Router** | Full framework required, server-focused |

#### React Router DOM (v6)
**What it is:** The standard routing library for React applications.

**Why it's used:** Some older projects use React Router before TanStack Router adoption.

**Where it's used:** google-docs, some older projects

---

### State Management

#### Zustand (v4/v5)
**What it is:** A small, fast, and scalable state management solution for React.

**Why we use it:**
- Minimal boilerplate (no actions, reducers, providers)
- TypeScript-first design
- Hooks-based API
- Built-in persistence middleware
- No context providers needed (direct store access)
- Tiny bundle size (~1KB)

**Where it's used:** All projects with frontend state (figma, discord, twitter, etc.)

**Example usage:**
```typescript
// Define store
const useStore = create<State>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
}));

// Use in component
const count = useStore((state) => state.count);
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Redux Toolkit** | More structure, middleware ecosystem, more boilerplate |
| **Jotai** | Atomic state model, bottom-up approach |
| **Recoil** | Facebook-backed, graph-based state |
| **MobX** | Observable-based, more magic, larger bundle |
| **Context API** | Built-in, causes re-renders, no devtools |

---

### Styling

#### Tailwind CSS (v3)
**What it is:** A utility-first CSS framework that provides low-level utility classes.

**Why we use it:**
- Rapid UI development with utility classes
- Consistent design system via configuration
- Purges unused CSS in production (tiny bundles)
- Works well with component-based architectures
- Responsive design utilities built-in
- No CSS file management

**Where it's used:** All frontend projects

**Example:**
```jsx
// Traditional CSS
<div className="card">...</div>
// Tailwind
<div className="rounded-lg shadow-md p-4 bg-white">...</div>
```

**Supporting packages:**
- `autoprefixer`: Adds vendor prefixes for browser compatibility
- `postcss`: CSS transformation pipeline

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **CSS Modules** | Scoped CSS, more traditional, more files |
| **Styled Components** | CSS-in-JS, runtime cost, dynamic styling |
| **Emotion** | Similar to styled-components, better performance |
| **Sass/SCSS** | Preprocessing, traditional approach |
| **UnoCSS** | On-demand atomic CSS, faster than Tailwind |

---

### Rich Text Editing

#### TipTap (v2)
**What it is:** A headless, framework-agnostic rich text editor built on ProseMirror.

**Why we use it:**
- Highly extensible via extensions
- Built-in collaboration support
- Headless (bring your own UI)
- TypeScript support
- Active development and community

**Where it's used:** google-docs (collaborative document editing)

**Extensions used:**
| Extension | Purpose |
|-----------|---------|
| `@tiptap/starter-kit` | Basic formatting (bold, italic, headings, lists) |
| `@tiptap/extension-collaboration` | Real-time collaborative editing |
| `@tiptap/extension-collaboration-cursor` | Show other users' cursors |
| `@tiptap/extension-color` | Text color support |
| `@tiptap/extension-highlight` | Text highlighting |
| `@tiptap/extension-placeholder` | Placeholder text |
| `@tiptap/extension-underline` | Underline formatting |

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Quill** | Simpler, less extensible, larger community |
| **Slate.js** | Fully customizable, steeper learning curve |
| **Draft.js** | Facebook-made, larger bundle, less active |
| **Lexical** | Facebook's new editor, smaller, still maturing |
| **CKEditor** | Commercial, full-featured, heavy |

---

### WebGL Rendering

#### PixiJS (v8)
**What it is:** A fast 2D rendering engine that uses WebGL with Canvas fallback.

**Why we use it:**
- Hardware-accelerated 2D rendering via WebGL
- Excellent performance for graphics-heavy applications
- Rich API for sprites, text, graphics, filters
- Handles complex scenes with thousands of objects
- Canvas fallback for older browsers

**Where it's used:** figma (design canvas rendering)

**Key concepts:**
```typescript
// Application - manages the renderer
const app = new PIXI.Application();

// Container - hierarchical grouping
const container = new PIXI.Container();

// Graphics - vector drawing
const graphics = new PIXI.Graphics();
graphics.rect(0, 0, 100, 100);
graphics.fill(0xFF0000);

// Text - text rendering
const text = new PIXI.Text({ text: 'Hello', style: { fontSize: 24 } });
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Canvas 2D API** | Simpler, no WebGL benefits, slower for complex scenes |
| **Three.js** | 3D-focused, overkill for 2D |
| **Fabric.js** | Canvas-based, object model, slower than WebGL |
| **Konva.js** | React integration, Canvas-based |

---

## Backend Technologies

### Runtime & Framework

#### Node.js
**What it is:** JavaScript runtime built on Chrome's V8 engine, enabling server-side JavaScript.

**Why we use it:**
- Single language for frontend and backend
- Non-blocking I/O model (great for I/O-bound workloads)
- Large npm ecosystem
- Fast prototyping
- Good for real-time applications (WebSocket, SSE)

**Concurrency model:**
```
Single-threaded event loop
│
├── I/O operations → Delegated to OS/libuv thread pool
├── Callbacks queued → Executed when I/O completes
└── CPU-bound work → Blocks event loop (avoid!)
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Go** | Better concurrency, faster, steeper learning curve |
| **Rust** | Fastest, memory-safe, hardest learning curve |
| **Python** | Easier, slower, GIL limits concurrency |
| **Deno** | Modern Node alternative, smaller ecosystem |
| **Bun** | Faster, newer, less mature |

#### Express.js (v4/v5)
**What it is:** Minimal and flexible Node.js web framework.

**Why we use it:**
- Industry standard for Node.js APIs
- Simple middleware architecture
- Extensive ecosystem
- Easy to learn and use
- Flexible (no opinions on structure)

**Where it's used:** All backend projects

**Middleware pattern:**
```javascript
app.use(cors());                    // CORS headers
app.use(express.json());            // Parse JSON bodies
app.use(session({ store: redisStore }));  // Sessions
app.use('/api', apiRoutes);         // Route mounting
app.use(errorHandler);              // Error handling
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Fastify** | Faster, schema validation, less ecosystem |
| **Koa** | Modern, async/await native, smaller ecosystem |
| **Hono** | Edge-first, extremely fast, newer |
| **NestJS** | Full framework, TypeScript-first, Angular-like |

---

### TypeScript Execution

#### tsx (v4)
**What it is:** TypeScript execute - run TypeScript files directly without compilation.

**Why we use it:**
- No build step needed for development
- Watch mode for automatic restarts
- Faster than ts-node
- ESM support
- Just works with TypeScript

**Where it's used:** All TypeScript backend projects

**Usage:**
```bash
# Run TypeScript directly
tsx src/index.ts

# Watch mode
tsx watch src/index.ts
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **ts-node** | More mature, slower, more configuration |
| **nodemon + tsc** | Separate compile step, slower |
| **Bun** | Faster, but different runtime |
| **Node.js native** | Requires --experimental-strip-types flag (Node 22+) |

---

### HTTP Utilities

#### cors
**What it is:** Express middleware for enabling Cross-Origin Resource Sharing.

**Why we use it:**
- Browsers block cross-origin requests by default
- Required when frontend and backend are on different origins
- Configurable allowed origins, methods, headers

**Where it's used:** All backend projects

#### helmet
**What it is:** Security middleware that sets various HTTP headers.

**Why we use it:**
- Sets Content-Security-Policy
- Removes X-Powered-By header
- Sets X-Content-Type-Options
- And other security headers

**Where it's used:** web-crawler and security-conscious projects

#### compression
**What it is:** Response compression middleware (gzip/deflate).

**Why we use it:**
- Reduces response size
- Faster page loads
- Lower bandwidth usage

**Where it's used:** web-crawler

#### morgan
**What it is:** HTTP request logging middleware.

**Why we use it:**
- Logs all incoming requests
- Configurable log formats
- Integration with logging systems

**Where it's used:** web-crawler

---

### Session & Authentication

#### express-session
**What it is:** Session middleware for Express applications.

**Why we use it:**
- Simple session management
- Cookie-based session IDs
- Pluggable session stores

**Where it's used:** Most backend projects requiring authentication

#### connect-redis
**What it is:** Redis session store for express-session.

**Why we use it:**
- Sessions stored in Redis (not in memory)
- Survives server restarts
- Scales across multiple server instances
- Fast session lookups

**Where it's used:** twitter, whatsapp, web-crawler, and most production-ready projects

#### bcrypt / bcryptjs
**What it is:** Password hashing library.

**Why we use it:**
- Industry-standard password hashing
- Configurable work factor (cost)
- Built-in salt generation
- Timing-safe comparison

**Difference:**
- `bcrypt`: Native C++ bindings (faster, requires compilation)
- `bcryptjs`: Pure JavaScript (slower, no compilation needed)

**Where it's used:** Projects with user authentication

---

### Real-Time Communication

#### ws (WebSocket)
**What it is:** Simple, fast WebSocket implementation for Node.js.

**Why we use it:**
- Lightweight (~100KB)
- High performance
- Standards-compliant
- Low-level control

**Where it's used:** figma, google-docs, discord, whatsapp, collaborative-editor, twitch

**Example:**
```typescript
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    // Handle incoming message
  });
  ws.send(JSON.stringify({ type: 'welcome' }));
});
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Socket.io** | Higher-level, fallbacks, larger bundle |
| **µWebSockets.js** | Faster, lower-level, less Node.js-like |

---

### Rate Limiting

#### express-rate-limit
**What it is:** Basic rate limiting middleware for Express.

**Why we use it:**
- Prevents abuse and DoS attacks
- Configurable windows and limits
- Memory or Redis store

**Where it's used:** web-crawler, fb-post-search, whatsapp

#### rate-limit-redis
**What it is:** Redis store for express-rate-limit.

**Why we use it:**
- Rate limits shared across server instances
- Survives server restarts

**Where it's used:** whatsapp

---

### Circuit Breaker

#### opossum
**What it is:** Circuit breaker implementation for Node.js.

**Why we use it:**
- Prevents cascading failures
- Automatic recovery after failures
- Fallback behavior
- Half-open state for recovery testing

**Where it's used:** figma, google-docs, twitter, airbnb, whatsapp, collaborative-editor

**States:**
```
CLOSED → Requests flow normally
OPEN → Requests fail immediately (after threshold)
HALF_OPEN → Test if service recovered
```

#### cockatiel
**What it is:** Resilience library with retry, circuit breaker, timeout policies.

**Why we use it:**
- Composable policies
- TypeScript-first
- More features than opossum

**Where it's used:** web-crawler, fb-post-search

---

### Validation

#### Zod
**What it is:** TypeScript-first schema validation library.

**Why we use it:**
- TypeScript type inference from schemas
- Composable schemas
- Detailed error messages
- No code generation needed

**Where it's used:** fb-post-search, ad-click-aggregator

**Example:**
```typescript
const UserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().positive().optional(),
});

type User = z.infer<typeof UserSchema>; // TypeScript type extracted!
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Yup** | More mature, less TypeScript integration |
| **Joi** | Feature-rich, no TypeScript inference |
| **AJV** | Fastest, JSON Schema based |

---

### HTTP Client

#### Axios
**What it is:** Promise-based HTTP client for Node.js and browsers.

**Why we use it:**
- Automatic JSON parsing
- Request/response interceptors
- Request cancellation
- Timeout handling

**Where it's used:** web-crawler

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **node-fetch** | Native fetch API, minimal |
| **got** | Node-only, more features |
| **undici** | Node.js core HTTP client, fastest |

---

### HTML Parsing

#### cheerio
**What it is:** Fast, flexible HTML parsing library with jQuery-like syntax.

**Why we use it:**
- Familiar jQuery API
- Server-side HTML manipulation
- Efficient parsing

**Where it's used:** web-crawler (link extraction)

**Example:**
```javascript
const $ = cheerio.load(html);
const links = $('a').map((i, el) => $(el).attr('href')).get();
```

---

### robots.txt Parsing

#### robots-parser
**What it is:** Parse robots.txt files for web crawlers.

**Why we use it:**
- Respect website crawling rules
- Check if URLs are allowed
- Get crawl delay settings

**Where it's used:** web-crawler

---

### File Upload

#### multer
**What it is:** Middleware for handling multipart/form-data (file uploads).

**Why we use it:**
- Easy file upload handling
- Memory or disk storage
- File filtering and limits

**Where it's used:** twitter (media uploads), airbnb (property photos)

---

### Scheduled Tasks

#### node-cron
**What it is:** Cron-like job scheduler for Node.js.

**Why we use it:**
- Schedule recurring tasks
- Familiar cron syntax
- Timezone support

**Where it's used:** figma (cleanup tasks)

---

### Unique IDs

#### uuid (v9/v10/v11)
**What it is:** Generate RFC-compliant UUIDs.

**Why we use it:**
- Universally unique identifiers
- Multiple UUID versions (v4 random, v7 time-ordered)
- Standards-compliant

**Where it's used:** All projects

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **nanoid** | Shorter, URL-safe, faster |
| **ulid** | Sortable, shorter than UUID |
| **cuid2** | Collision-resistant, shorter |

---

## Database Technologies

### Relational Database

#### PostgreSQL (v16)
**What it is:** Advanced open-source relational database.

**Why we use it:**
- ACID compliance for data integrity
- Rich feature set (JSONB, arrays, full-text search)
- PostGIS extension for geospatial queries
- Excellent performance
- Strong community

**Where it's used:** All projects requiring persistent storage

**Client library: pg (v8)**
```typescript
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
```

**Key features used:**
| Feature | Project | Purpose |
|---------|---------|---------|
| JSONB | figma | Canvas data storage |
| PostGIS | airbnb | Geographic search |
| Triggers | twitter | Denormalized count updates |
| UPSERT | ad-click-aggregator | Aggregation updates |

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **MySQL** | Simpler, less features, different replication model |
| **SQLite** | Embedded, single-writer, great for small apps |
| **CockroachDB** | Distributed PostgreSQL, more complex |

---

### Caching & In-Memory Store

#### Redis / ioredis / node-redis
**What it is:** In-memory data structure store used for caching, sessions, and pub/sub.

**Why we use it:**
- Sub-millisecond latency
- Rich data structures (strings, hashes, lists, sets, sorted sets)
- Pub/sub for real-time messaging
- Persistence options
- Clustering support

**Where it's used:** Most projects

**Client libraries:**
| Library | Usage |
|---------|-------|
| `ioredis` | Feature-rich, cluster support, pipelining |
| `redis` | Official Node.js client |

**Use cases across projects:**
| Use Case | Data Structure | Example |
|----------|----------------|---------|
| Session storage | Hash | `session:{id}` → user data |
| Caching | String | `cache:user:{id}` → JSON |
| Rate limiting | String + TTL | `ratelimit:{ip}` → count |
| Leaderboards | Sorted Set | `trending` → score → item |
| Pub/sub | Channels | `chat:{room}` → messages |
| Deduplication | Set | `seen:{hour}` → URLs |
| Presence | Hash + Expire | `online:{file}` → users |

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Valkey** | Redis fork (fully open-source), API-compatible |
| **Memcached** | Simpler, string-only, no persistence |
| **KeyDB** | Multi-threaded Redis fork |
| **Dragonfly** | Drop-in replacement, better memory efficiency |

---

### Time-Series Analytics (OLAP)

#### ClickHouse (v23.8)
**What it is:** Open-source columnar database for real-time analytics and OLAP workloads.

**Why we use it:**
- Columnar storage with 10-100x compression
- Blazing fast analytical queries (billions of rows per second)
- Materialized views for automatic aggregation
- MergeTree engine family optimized for time-series data
- TTL for automatic data expiration
- Designed for high-volume ingestion (millions of events per second)

**Where it's used:** ad-click-aggregator (time-series analytics)

**Client library: @clickhouse/client**

**Example:**
```typescript
import { createClient } from '@clickhouse/client';

const client = createClient({
  url: 'http://localhost:8123',
  database: 'adclick',
});

// Insert events (async insert for high throughput)
await client.insert({
  table: 'click_events',
  values: [{ click_id: '...', campaign_id: '...', timestamp: new Date() }],
  format: 'JSONEachRow',
});

// Query aggregates (automatic MV aggregation)
const result = await client.query({
  query: `
    SELECT toStartOfMinute(timestamp) as minute, count() as clicks
    FROM click_events
    WHERE campaign_id = '123'
    GROUP BY minute
    ORDER BY minute DESC
  `,
  format: 'JSONEachRow',
});
```

**Key features used:**
| Feature | Purpose |
|---------|---------|
| MergeTree | Ordered storage with partition pruning |
| SummingMergeTree | Automatic summing on merge |
| Materialized Views | Real-time aggregation on insert |
| LowCardinality | Optimized storage for enum-like columns |
| TTL | Automatic data expiration |
| Async Insert | High-throughput ingestion |

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Apache Druid** | More complex, real-time streaming focus |
| **TimescaleDB** | PostgreSQL extension, easier adoption, less performance |
| **Apache Pinot** | LinkedIn-backed, more complex setup |
| **InfluxDB** | Time-series focused, different query language |
| **QuestDB** | Faster ingestion, smaller ecosystem |

---

### Wide-Column Store

#### Cassandra (v4.1)
**What it is:** A distributed, wide-column NoSQL database designed for high availability and linear scalability.

**Why we use it:**
- Masterless architecture (no single point of failure)
- Linear horizontal scaling
- Optimized for high-write workloads
- TimeUUID support for natural time-ordering
- Partition-based data distribution
- Tunable consistency levels

**Where it's used:** Instagram (Direct Messages), Netflix (Viewing History), WhatsApp (Messages)

**Client library: cassandra-driver**

**Example:**
```javascript
import cassandra from 'cassandra-driver';

const client = new cassandra.Client({
  contactPoints: ['localhost'],
  localDataCenter: 'datacenter1',
  keyspace: 'instagram_dm',
});

// Insert message with TimeUUID for ordering
const messageId = cassandra.types.TimeUuid.now();
await client.execute(
  `INSERT INTO messages_by_conversation
   (conversation_id, message_id, sender_id, content, created_at)
   VALUES (?, ?, ?, ?, ?)`,
  [conversationId, messageId, senderId, content, new Date()],
  { prepare: true }
);

// Query messages (automatically ordered by TimeUUID DESC)
const result = await client.execute(
  'SELECT * FROM messages_by_conversation WHERE conversation_id = ? LIMIT 50',
  [conversationId],
  { prepare: true }
);
```

**Key features used:**
| Feature | Purpose |
|---------|---------|
| TimeUUID | Natural time-ordering for messages |
| Partition key | Conversation-based data distribution |
| Clustering key | Message ordering within partition |
| TTL | Automatic message expiration |
| Prepared statements | Query optimization |

**Data modeling patterns:**
| Pattern | Example |
|---------|---------|
| Query-first design | Design tables for specific access patterns |
| Denormalization | Store user info in conversation table |
| TimeUUID ordering | Messages ordered by creation time |
| Partition sizing | Keep partitions < 100MB |

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **ScyllaDB** | C++ rewrite, faster, API-compatible |
| **DynamoDB** | Managed, simpler, vendor lock-in |
| **HBase** | Hadoop ecosystem, more complex |
| **PostgreSQL** | ACID, but lower write throughput at scale |

---

### Document Database

#### CouchDB (v3.3)
**What it is:** A document-oriented NoSQL database with built-in sync and offline-first capabilities.

**Why we use it:**
- Built-in replication protocol for offline sync
- MVCC (Multi-Version Concurrency Control) for conflict detection
- Change feeds (`_changes` API) for real-time updates
- RESTful HTTP API (no special drivers needed)
- PouchDB integration for browser-based sync
- Document-native JSON storage

**Where it's used:** Google Docs (Document Content & Offline Sync)

**Client library: nano (Node.js)**

**Example:**
```javascript
import Nano from 'nano';

const couch = Nano('http://admin:admin123@localhost:5984');
const documents = couch.db.use('documents');

// Create/update document
const doc = {
  _id: 'doc-uuid',
  title: 'My Document',
  owner_id: 'user-uuid',
  content: { type: 'doc', content: [...] },
  updated_at: new Date().toISOString()
};
const response = await documents.insert(doc);
// Returns: { ok: true, id: 'doc-uuid', rev: '1-abc123' }

// Get document with conflict info
const doc = await documents.get('doc-uuid', { conflicts: true });

// Query using view
const result = await documents.view('docs', 'by_owner', {
  key: 'user-uuid',
  include_docs: true
});

// Subscribe to changes (real-time updates)
const feed = documents.changesReader.start({
  since: 'now',
  live: true,
  include_docs: true
});
feed.on('change', (change) => {
  console.log('Document changed:', change.doc);
});
```

**Offline Sync with PouchDB:**
```javascript
// Browser-side (PouchDB)
import PouchDB from 'pouchdb';

const localDB = new PouchDB('documents');
const remoteDB = new PouchDB('http://localhost:5984/documents');

// Two-way sync with live updates
localDB.sync(remoteDB, {
  live: true,
  retry: true
}).on('change', (info) => {
  console.log('Sync change:', info);
}).on('error', (err) => {
  console.log('Sync error:', err);
});

// Conflict resolution
localDB.get('doc-uuid', { conflicts: true }).then((doc) => {
  if (doc._conflicts) {
    // Merge conflicting revisions
    resolveConflicts(doc, doc._conflicts);
  }
});
```

**Key features used:**
| Feature | Purpose |
|---------|---------|
| `_rev` (revisions) | MVCC for conflict detection |
| Replication | Offline sync between CouchDB/PouchDB |
| Change feeds | Real-time document updates |
| Design documents | MapReduce views for queries |
| Attachments | Binary file storage |

**Data modeling patterns:**
| Pattern | Example |
|---------|---------|
| Type field | `{ type: 'document' }` for filtering |
| Embedded docs | Store related data together |
| Linked docs | Reference by `_id` for normalization |
| Conflict resolution | Merge or last-write-wins strategies |

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **MongoDB** | More query features, no built-in sync |
| **Firebase Firestore** | Managed, real-time sync, vendor lock-in |
| **RxDB** | Browser-first, sync with various backends |
| **PostgreSQL JSONB** | Relational benefits, no offline sync |

---

### Search Engine

#### Elasticsearch (v8)
**What it is:** Distributed search and analytics engine.

**Why we use it:**
- Full-text search with relevance scoring
- Near real-time indexing
- Aggregations for analytics
- Horizontal scalability

**Where it's used:** fb-post-search

**Client library: @elastic/elasticsearch**

**Example:**
```typescript
const result = await client.search({
  index: 'posts',
  query: {
    bool: {
      must: [
        { match: { content: 'hello world' } }
      ],
      filter: [
        { terms: { visibility: ['PUBLIC', 'FRIENDS:user123'] } }
      ]
    }
  }
});
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **OpenSearch** | AWS fork, fully open-source |
| **Meilisearch** | Simpler, faster indexing, less features |
| **Typesense** | Simpler, typo-tolerant by default |
| **PostgreSQL FTS** | Built-in, good enough for smaller scale |

---

## Message Queues & Event Streaming

### RabbitMQ

#### amqplib
**What it is:** AMQP 0-9-1 client for RabbitMQ.

**Why we use it:**
- Reliable message delivery
- Message acknowledgments
- Routing flexibility (direct, topic, fanout)
- Dead letter queues

**Where it's used:** scale-ai, collaborative-editor, airbnb

**Pattern:**
```
Producer → Exchange → Queue → Consumer
                ↓
           Routing Rules
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Apache Kafka** | Higher throughput, log-based, more complex |
| **Amazon SQS** | Managed, simpler, vendor lock-in |
| **Redis Streams** | Simple, less durable than RabbitMQ |
| **BullMQ** | Redis-based, simpler API, less features |

---

## Development Tools

### Language & Type Checking

#### TypeScript (v5)
**What it is:** Typed superset of JavaScript.

**Why we use it:**
- Catch errors at compile time
- Better IDE support (autocomplete, refactoring)
- Self-documenting code
- Safer refactoring

**Where it's used:** All TypeScript projects (most of the repository)

**Configuration highlights:**
```json
{
  "compilerOptions": {
    "strict": true,           // Enable all strict checks
    "module": "ESNext",       // ES modules
    "moduleResolution": "bundler",  // Modern resolution
    "noEmit": true,           // Vite handles transpilation
    "esModuleInterop": true   // CommonJS interop
  }
}
```

---

### Linting & Formatting

#### ESLint (v8/v9)
**What it is:** Pluggable linting utility for JavaScript/TypeScript.

**Why we use it:**
- Catch bugs and anti-patterns
- Enforce code style
- Auto-fixable rules

**Key plugins:**
| Plugin | Purpose |
|--------|---------|
| `@typescript-eslint` | TypeScript-specific rules |
| `eslint-plugin-react-hooks` | React hooks rules |
| `eslint-plugin-react-refresh` | Fast refresh compatibility |
| `eslint-config-prettier` | Disable formatting rules (let Prettier handle) |

#### Prettier
**What it is:** Opinionated code formatter.

**Why we use it:**
- Consistent code style
- No debates about formatting
- Auto-format on save

**Where it's used:** All projects

---

### Testing

#### Vitest (v2)
**What it is:** Fast unit testing framework powered by Vite.

**Why we use it:**
- Uses Vite's transformation pipeline
- Jest-compatible API
- Native TypeScript/ESM support
- Fast watch mode

**Where it's used:** scale-ai, discord, and newer projects

**Example:**
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('MyService', () => {
  it('should return expected value', async () => {
    const result = await myService.getData();
    expect(result).toBe('expected');
  });
});
```

#### Jest
**What it is:** JavaScript testing framework.

**Why it's used:** Established testing framework, used in some projects.

**Where it's used:** twitch

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Mocha** | Flexible, requires separate assertion library |
| **Bun test** | Bun-specific, fast |
| **Node test runner** | Built-in (Node 18+), minimal |

#### Supertest
**What it is:** HTTP assertions library for testing Express apps.

**Why we use it:**
- Test endpoints without starting server
- Chain assertions
- Works with any test framework

**Where it's used:** scale-ai

---

### Process Management

#### nodemon
**What it is:** Development tool that auto-restarts Node.js on file changes.

**Why it's used:** Some JavaScript-only projects.

**Where it's used:** twitter, airbnb, twitch

#### concurrently
**What it is:** Run multiple commands concurrently.

**Why we use it:**
- Run multiple services in development
- Colored output per process
- Kill all on exit

**Where it's used:** scale-ai (run multiple microservices)

---

## Infrastructure & Deployment

### Containerization

#### Docker & Docker Compose
**What it is:** Container platform for building, sharing, and running applications.

**Why we use it:**
- Consistent environments (dev, staging, prod)
- Easy local setup with all dependencies
- Isolated services
- Infrastructure as code

**Common services in docker-compose.yml:**
```yaml
services:
  postgres:
    image: postgres:16-alpine
  redis:
    image: redis:7-alpine
  rabbitmq:
    image: rabbitmq:3-management
  minio:
    image: minio/minio
  elasticsearch:
    image: elasticsearch:8.11.0
```

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Podman** | Daemonless, rootless, Docker-compatible |
| **Native installation** | More complex setup, no isolation |
| **Nix** | Reproducible, steeper learning curve |

---

### Object Storage

#### MinIO / @aws-sdk/client-s3
**What it is:** S3-compatible object storage.

**Why we use it:**
- S3 API compatibility
- Self-hosted for local development
- Same code works with AWS S3

**Where it's used:** scale-ai (drawing storage)

**Client library: minio (v8)**

---

## Monitoring & Observability

### Metrics

#### prom-client
**What it is:** Prometheus client library for Node.js.

**Why we use it:**
- Expose metrics for Prometheus scraping
- Standard metric types (Counter, Gauge, Histogram)
- Default Node.js metrics

**Where it's used:** All backend projects

**Example:**
```typescript
import { Counter, Registry } from 'prom-client';

const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'],
});

httpRequests.inc({ method: 'GET', path: '/api/users', status: 200 });
```

---

### Logging

#### Pino (v10)
**What it is:** Fast, low-overhead JSON logger.

**Why we use it:**
- 5x faster than alternatives
- Structured JSON output
- Low overhead in production
- Child loggers for context

**Where it's used:** All backend projects

**Supporting packages:**
| Package | Purpose |
|---------|---------|
| `pino-http` | Express request logging |
| `pino-pretty` | Human-readable dev output |

**Example:**
```typescript
import pino from 'pino';
const logger = pino({ level: 'info' });

logger.info({ userId: 123 }, 'User logged in');
// {"level":30,"time":1234567890,"userId":123,"msg":"User logged in"}
```

#### Winston
**What it is:** Versatile logging library with transports.

**Why it's used:** Some projects use Winston for its transport flexibility.

**Where it's used:** discord

**Alternatives:**
| Alternative | Trade-offs |
|-------------|------------|
| **Bunyan** | Similar to Pino, older |
| **console.log** | Simple, no structure, no levels |

---

## Summary Table

| Category | Primary Choice | When to Consider Alternatives |
|----------|----------------|-------------------------------|
| **Frontend Framework** | React 19 | Vue for simpler projects |
| **Build Tool** | Vite | Webpack for complex legacy needs |
| **Routing** | TanStack Router | React Router for familiarity |
| **State** | Zustand | Redux for large teams |
| **Styling** | Tailwind CSS | CSS Modules for traditional |
| **Backend Runtime** | Node.js + Express | Go/Rust for performance-critical |
| **TypeScript Execution** | tsx | ts-node for legacy |
| **Relational DB** | PostgreSQL | MySQL for simpler needs |
| **Time-Series/OLAP** | ClickHouse | TimescaleDB for PostgreSQL ecosystem |
| **Cache** | Redis/ioredis | Valkey for open-source purity |
| **Search** | Elasticsearch | PostgreSQL FTS for smaller scale |
| **Message Queue** | RabbitMQ + amqplib | Kafka for event streaming |
| **Testing** | Vitest | Jest for existing Jest codebases |
| **Logging** | Pino | Winston for transport flexibility |
| **Metrics** | prom-client | Statsd for legacy systems |

---

## Version Reference

Key package versions used across projects (as of 2025):

| Package | Version Range | Notes |
|---------|---------------|-------|
| React | 18.x - 19.x | React 19 in newer projects |
| Vite | 6.x | Latest stable |
| TypeScript | 5.x | 5.5+ for best ESM support |
| Express | 4.x - 5.x | Express 5 in newer projects |
| PostgreSQL | 16 | Via Docker |
| ClickHouse | 23.8 | Via Docker, for OLAP analytics |
| Redis | 7 | Via Docker |
| Elasticsearch | 8.x | Via Docker |

---

*This document is maintained alongside the codebase. For project-specific technology decisions, see individual project `CLAUDE.md` files.*
