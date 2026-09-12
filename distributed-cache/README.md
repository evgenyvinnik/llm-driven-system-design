# Distributed Cache

A teaching implementation of a distributed, in-memory key/value cache. Three Node.js cache nodes store separate shards; a coordinator chooses an owner using consistent hashing. A React dashboard lets you inspect the cluster and try cache operations. This project builds the cache itself: it does **not** require Redis, PostgreSQL, or another external datastore.

The useful learning problems are key placement, LRU eviction, expiration, node failure, and moving data while requests continue. This is a prototype with important failure and setup limitations, described below. Production proposals belong in [architecture.md](./architecture.md); the [frontend](./system-design-answer-frontend.md), [backend](./system-design-answer-backend.md), and [fullstack](./system-design-answer-fullstack.md) answers are spoken interview designs.

## What you can explore

| View | Implemented behavior |
|------|----------------------|
| Dashboard `/` | Cluster counters, node health, memory estimates, and active-node badges; refreshes every five seconds by default |
| Keys `/keys` | Pattern search, value/TTL inspection, key deletion, and cluster flush |
| Cluster `/cluster` | Node membership and controls for adding/removing nodes or forcing a probe |
| Test `/test` | SET, GET, DELETE, increment, owner lookup, and 100 sequential test-key writes |

The dashboard uses React 19, TypeScript, Vite, TanStack Router, Zustand, and Tailwind. Backend roles use Express and HTTP/JSON. Nodes use a Map plus a doubly linked list, with periodic JSON snapshots. Pino and prom-client provide logging and metrics. The Opossum helper exists but is **not connected to coordinator requests**.

Cluster controls normally receive **401** because the frontend sends no admin-key header. Cache writes, deletes, browsing, and the effective flush route remain public. There is no sign-in, tenant isolation, replication, quorum configuration, source-of-truth loader, or automatic cache refill.

## Local topology

```
┌─────────────────────┐
│ Dashboard :5173     │
└─────────────────────┘
           │ /api proxy
           ▼
┌─────────────────────┐
│ Coordinator :3000   │
└─────────────────────┘
           │ hash key to one node
           ▼
┌───────────────────────────────────────────────┐
│ Node 1 :3001   Node 2 :3002   Node 3 :3003    │
│ Separate memory and snapshot directories      │
└───────────────────────────────────────────────┘
```

Ports are shared with other learning projects; stop conflicting processes first. Use only disposable local data: the API has no general access control, and moving or restarting nodes can lose entries or reveal stale copies.

## Setup

Run commands from this project directory unless a command explicitly changes directory. Node.js 20+ and npm are the native prerequisites. Configuration is read from the process environment; no dotenv loader is present.

### Option A: Docker Compose (recommended topology; launch files need repair)

The checked-in Compose file describes three cache nodes, one coordinator, and an Nginx frontend. Its current backend images cannot start the TypeScript application:

- Both Dockerfiles launch nonexistent `src/server.js` or `src/coordinator.js`. Actual entry points are `src/server/index.ts` and `src/coordinator/index.ts`.
- Images install production dependencies only, copy no compiled output, and omit `tsx` and the development logger dependency. A repair needs either compiled JavaScript with a production logger configuration or a development image with the required tooling.
- Compose health checks call `curl`, which these Dockerfiles do not install. Its short `depends_on` lists do not wait for healthy services. See [Docker's startup-order documentation](https://docs.docker.com/compose/how-tos/startup-order/).
- No snapshot volumes are configured. Data inside a container's writable layer is lost when that container is removed or replaced.

Inspect the topology now; use the native option to work with the current source. After repairing the image entry points, dependencies, probes, and persistence mounts, the lifecycle commands are:

```bash
docker compose config
docker compose up -d --build
docker compose logs -f coordinator cache-node-1
docker compose down
```

`docker compose down -v` also removes declared volumes if you later add them; it is not a data-preserving reset. Scaling these services with `--scale` is not supported as written because they have fixed container names and host ports.

### Option B: Native installation (no Docker)

There are no database users, buckets, migrations, or external services to create. Install the two applications:

```bash
cd backend
npm install
cd ../frontend
npm install
cd ..
```

Start the backend roles in one terminal:

```bash
cd backend
npm run dev
```

This starts nodes on 3001–3003 and the coordinator on 3000. Its coordinator script enables ten demonstration keys, with one-hour TTLs. Seeding runs once after the initial health pass: nodes that start later do not trigger another seed, so an empty first launch is possible. Restarting that coordinator script can overwrite demo values. The logged seed count counts attempted requests, not verified successful writes.

Start the frontend in another terminal:

```bash
cd frontend
npm run dev
```

Open [the dashboard](http://localhost:5173). Vite forwards `/api/*` to the coordinator, removing `/api`.

For a more deterministic startup, start nodes in separate terminals, wait until their health endpoints respond, then start the coordinator. Run each command from `backend/`:

```bash
npm run dev:server1
```

```bash
npm run dev:server2
```

```bash
npm run dev:server3
```

```bash
npm run coordinator
```

`npm run coordinator` does not enable demo seeding unless you export `SEED_DEMO_KEYS=true`. Stop these processes with Ctrl+C. Nodes attempt a final snapshot; this is best-effort recovery, not a durable-write guarantee.

### Verify the running processes

```bash
curl --fail http://localhost:3001/health
curl --fail http://localhost:3002/health
curl --fail http://localhost:3003/health
curl --fail http://localhost:3000/cluster/info
curl --fail http://localhost:3000/cluster/stats
```

The coordinator's `/health` always responds HTTP 200, including when its body says `degraded`. Check `healthyNodes` and `ring.activeNodes`, not just the HTTP status. A failed probe marks a node unhealthy immediately, while removal from routing waits for three consecutive failed probes.

## Try the HTTP API

Use coordinator URLs for normal operations. Keys in URL paths must be URL-encoded.

```bash
curl --fail -X POST http://localhost:3000/cache/demo:hello \
  -H 'Content-Type: application/json' \
  -d '{"value":{"message":"Hello"},"ttl":60}'
curl --fail http://localhost:3000/cache/demo:hello
curl --fail http://localhost:3000/cluster/locate/demo:hello
curl --fail 'http://localhost:3000/keys?pattern=demo:*'
```

A successful GET returns `key`, `value`, remaining `ttl` in **seconds**, and `_routing.nodeUrl`. Owner lookup reports where a request would route; it does not prove the key exists there. GET and DELETE return 404 for a missing key. POST creates or replaces with status 201; PUT also creates or replaces, with status 200.

With the default `DEFAULT_TTL=0`, SET TTL zero means no expiration. If a node has a positive default, SET with zero or omitted TTL uses that default. GET TTL `-1` means no expiration. The direct node TTL endpoint returns 404 for a missing key; the internal cache uses `-2` for that case.

```bash
curl --fail -X POST http://localhost:3000/cache/demo:counter/incr \
  -H 'Content-Type: application/json' -d '{"delta":1}'
curl --fail -X DELETE http://localhost:3000/cache/demo:hello
```

Increment is synchronous within one node, but a timed-out increment is unsafe to retry blindly. There is no request deduplication. Repeating SET with relative TTL also changes its expiration time and can overwrite a concurrent update.

| Scope | Endpoints |
|-------|-----------|
| Coordinator data | GET/POST/PUT/DELETE `/cache/:key`; POST `/cache/:key/incr`; GET `/keys`; POST `/flush` |
| Coordinator inspection | GET `/health`, `/metrics`, `/cluster/info`, `/cluster/stats`, `/cluster/locate/:key`, `/cluster/hot-keys`; POST `/cluster/distribution` with a `keys` array |
| Coordinator administration | POST/DELETE `/admin/node`; POST `/admin/health-check`, `/admin/rebalance`, `/admin/snapshot`; GET `/admin/rebalance/analyze`, `/admin/circuit-breakers`; POST `/admin/circuit-breakers/reset` |
| Direct node extras | GET `/info`, `/stats`, `/hot-keys`, `/cache/:key/exists`, `/cache/:key/ttl`, `/cache/:key/info`; POST `/cache/:key/expire`, `/mget`, `/mset`, `/snapshot`; GET `/snapshots` |

Node-only extras are not forwarded by the coordinator. There is no `/cache/bulk`, `/cluster/status`, or `/health/ready` endpoint. Both node and coordinator `/keys` truncate results to 1,000; there is no cursor or complete enumeration guarantee.

### Admin requests

The development key is `dev-admin-key`. Set `ADMIN_KEY` in the coordinator's process environment to change it. For example, after the cluster is running:

```bash
curl --fail -X POST http://localhost:3000/admin/health-check \
  -H 'X-Admin-Key: dev-admin-key'
```

The middleware allows ten requests per IP in a one-minute fixed window, counting unsuccessful authentication attempts too. It applies to the protected admin routes, not ordinary cache operations. `/admin/config` is public and reports configuration without disclosing the key.

The coordinator mounts a public `/flush` handler before its later protected handler; the latter is shadowed. Direct nodes also expose flush and snapshots without authentication. This remains an implementation defect, not a recommended deployment policy.

## Configuration and persistence

| Process | Variable | Default / behavior |
|---------|----------|--------------------|
| Node | `PORT`, `NODE_ID` | Bare entry point: 3000 and `node-3000`; provided node scripts set 3001–3003 and `node-1`–`node-3` |
| Node | `MAX_SIZE`, `MAX_MEMORY_MB` | 10,000 entries, 100 MiB estimated payload/key budget; not a process-memory ceiling |
| Node | `DEFAULT_TTL` | 0 seconds |
| Node | `PERSISTENCE_ENABLED` | `true` |
| Node | `SNAPSHOT_INTERVAL_MS`, `SNAPSHOT_DIR`, `MAX_SNAPSHOTS` | 60000, `./data`, 3; directory resolves from the working directory |
| Coordinator | `PORT`, `CACHE_NODES` | 3000; comma-separated `http://localhost:3001,http://localhost:3002,http://localhost:3003` |
| Coordinator | `HEALTH_CHECK_INTERVAL`, `VIRTUAL_NODES` | 5000 ms; 150 per physical node |
| Coordinator | `GRACEFUL_REBALANCE`, `SEED_DEMO_KEYS` | `true`; unset/disabled except in `dev:coordinator` |
| Coordinator | `REBALANCE_BATCH_SIZE`, `REBALANCE_DELAY_MS`, `REBALANCE_TIMEOUT_MS` | 100 keys, 50 ms between batches, 300000 ms checked between batches |
| Coordinator | `ADMIN_KEY`, `ADMIN_KEY_HEADER` | `dev-admin-key`, `x-admin-key` |
| Coordinator | `ADMIN_RATE_LIMIT_WINDOW_MS`, `ADMIN_RATE_LIMIT_MAX` | 60000 ms, 10 requests |
| Both | `LOG_LEVEL`, `NODE_ENV` | `info`, `development`; development uses pino-pretty |

The coordinator hashes **node URLs**, not reported `NODE_ID` values. Changing from native URLs to Docker service URLs changes placement. Give each node a separate snapshot directory/identity. Variables in the unused circuit-breaker helper do not configure the active five-second node-request timeout.

Snapshots are plain JSON under `backend/data/<node-id>/` when launched from `backend/`. The loader tries only the newest filename, skips expired records, and reinserts the remainder. It does not restore exact recency, timestamps, or counters. A corrupt newest file does not fall back to older ones. Failed snapshots, missing disks, or container replacement can lose much more than one minute of cache changes; snapshots can also restore a value deleted after the snapshot.

## Important current limitations

- Node addition changes routing before copying. Migration can overwrite newer target values; removal migrates against the old ring and skips keys still owned by the departing node. Failure-driven removal does not recover that node's data.
- Migration sees at most 1,000 listed keys per source, has no revision checks or resumable job, and can report success with failed or unvisited keys. Analyzing an already-active target can remove it from the live ring.
- Memory accounting is approximate and has defects: replacing an existing value skips eviction, increments do not adjust total bytes, and oversized new entries can be immediately evicted despite a successful SET response.
- The special keys `__HEAD__` and `__TAIL__` are accepted as data keys but can make eviction loop indefinitely. Pattern search passes through regular-expression metacharacters and lacks a scan budget.
- Dashboard aggregates omit unavailable nodes and do not flag incomplete totals. Five-second polling can overlap; key search fires on each edit; there is no request-generation guard, pagination, or virtualization.

See [the implementation notes](./architecture.md#implementation-notes) for the source-backed details and proposed remedies.

## Development and verification

| Directory | Command | Purpose / limit |
|-----------|---------|-----------------|
| `backend/` | `npx tsc --noEmit` | Type-check with the checked-in configuration; no `build` or `type-check` npm script exists |
| `backend/` | `npm run lint`, `npm run format` | ESLint and Prettier |
| `backend/` | `npm test` | Vitest is configured as a command, but no backend test files are checked in |
| `frontend/` | `npm run build`, `npm run lint` | TypeScript + Vite build; ESLint |
| Project root | `npm run test:e2e` | Three Playwright page smoke tests after installing root dependencies and browser binaries |

`npm start` in `backend/` expects `dist/server/index.js`; it does not compile TypeScript. The Playwright configuration can start Vite, but not the backend. The smoke tests check page visibility and absence of two error strings, not cache correctness, migrations, or admin authorization.

This documentation review used source inspection and isolated checks of the cache, hash ring, snapshots, health monitor, and rebalance helpers. It did not launch the stack, build images, or run the application test suites. Backend and frontend lockfile root dependencies match their manifests at review time.

Source map: [cache internals](./backend/src/lib/lru-cache.ts), [hash ring](./backend/src/lib/consistent-hash.ts), [coordinator entry point](./backend/src/coordinator/index.ts), [node entry point](./backend/src/server/index.ts), [dashboard API](./frontend/src/services/api.ts), and [dashboard store](./frontend/src/stores/cache-store.ts).
