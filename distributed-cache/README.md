# Distributed Cache

A high-performance distributed caching layer with consistent hashing, LRU eviction, and TTL support.

## Features

- **Consistent Hashing**: Even key distribution with virtual nodes
- **LRU Eviction**: Automatic eviction when memory/size limits are reached
- **TTL Support**: Time-to-live for automatic key expiration
- **Distributed Architecture**: Multiple cache nodes with a coordinator
- **Admin Dashboard**: Real-time monitoring of cluster health and statistics
- **HTTP API**: Simple REST API for cache operations

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend Dashboard                       │
│                    (React + TypeScript)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Coordinator                             │
│                (Consistent Hash Router)                      │
│                     Port: 3000                               │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   Cache Node 1  │  │   Cache Node 2  │  │   Cache Node 3  │
│   Port: 3001    │  │   Port: 3002    │  │   Port: 3003    │
│                 │  │                 │  │                 │
│  ┌───────────┐  │  │  ┌───────────┐  │  │  ┌───────────┐  │
│  │ LRU Cache │  │  │  │ LRU Cache │  │  │  │ LRU Cache │  │
│  │ + TTL     │  │  │  │ + TTL     │  │  │  │ + TTL     │  │
│  └───────────┘  │  │  └───────────┘  │  │  └───────────┘  │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## Quick Start

### Option 1: Docker (Recommended)

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

Services will be available at:
- Frontend Dashboard: http://localhost:5173
- Coordinator API: http://localhost:3000
- Cache Node 1: http://localhost:3001
- Cache Node 2: http://localhost:3002
- Cache Node 3: http://localhost:3003

### Option 2: Native Development

#### Prerequisites

- Node.js 20+
- npm 10+

#### Backend Setup

```bash
cd backend
npm install

# Start cache nodes (in separate terminals)
npm run dev:server1  # Port 3001
npm run dev:server2  # Port 3002
npm run dev:server3  # Port 3003

# Start coordinator
npm run coordinator  # Port 3000
```

#### Frontend Setup

```bash
cd frontend
npm install
npm run dev  # Port 5173
```

## API Documentation

All operations go through the coordinator (port 3000), which routes requests to the appropriate cache node using consistent hashing.

### Cache Operations

#### SET a Key

```bash
curl -X POST http://localhost:3000/cache/mykey \
  -H "Content-Type: application/json" \
  -d '{"value": "Hello World", "ttl": 3600}'
```

**Response:**
```json
{
  "key": "mykey",
  "ttl": 3600,
  "message": "Value set successfully",
  "_routing": { "nodeUrl": "http://localhost:3001" }
}
```

#### GET a Key

```bash
curl http://localhost:3000/cache/mykey
```

**Response:**
```json
{
  "key": "mykey",
  "value": "Hello World",
  "ttl": 3595,
  "_routing": { "nodeUrl": "http://localhost:3001" }
}
```

#### DELETE a Key

```bash
curl -X DELETE http://localhost:3000/cache/mykey
```

#### INCREMENT a Value

```bash
curl -X POST http://localhost:3000/cache/counter/incr \
  -H "Content-Type: application/json" \
  -d '{"delta": 1}'
```

### Key Operations

#### List All Keys

```bash
curl http://localhost:3000/keys
```

#### List Keys by Pattern

```bash
curl "http://localhost:3000/keys?pattern=user:*"
```

#### Locate Key (Find Which Node)

```bash
curl http://localhost:3000/cluster/locate/mykey
```

**Response:**
```json
{
  "key": "mykey",
  "nodeUrl": "http://localhost:3001",
  "allNodes": ["http://localhost:3001", "http://localhost:3002", "http://localhost:3003"]
}
```

#### Flush All Keys

```bash
curl -X POST http://localhost:3000/flush
```

### Cluster Operations

#### Get Cluster Info

```bash
curl http://localhost:3000/cluster/info
```

**Response:**
```json
{
  "coordinator": { "port": 3000, "uptime": 123.45 },
  "ring": { "virtualNodes": 150, "activeNodes": [...] },
  "nodes": [...]
}
```

#### Get Cluster Stats

```bash
curl http://localhost:3000/cluster/stats
```

**Response:**
```json
{
  "totalNodes": 3,
  "totalHits": 1234,
  "totalMisses": 56,
  "totalSize": 5000,
  "totalMemoryMB": "12.34",
  "overallHitRate": "95.65",
  "perNode": [...]
}
```

#### Add a Node

```bash
curl -X POST http://localhost:3000/admin/node \
  -H "Content-Type: application/json" \
  -d '{"url": "http://localhost:3004"}'
```

#### Remove a Node

```bash
curl -X DELETE http://localhost:3000/admin/node \
  -H "Content-Type: application/json" \
  -d '{"url": "http://localhost:3004"}'
```

#### Force Health Check

```bash
curl -X POST http://localhost:3000/admin/health-check
```

### Direct Node Operations

You can also access cache nodes directly (bypassing consistent hashing):

```bash
# Health check
curl http://localhost:3001/health

# Get node info
curl http://localhost:3001/info

# Get node stats
curl http://localhost:3001/stats
```

## Configuration

### Cache Node Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `NODE_ID` | `node-{PORT}` | Unique node identifier |
| `MAX_SIZE` | `10000` | Maximum number of cache entries |
| `MAX_MEMORY_MB` | `100` | Maximum memory usage in MB |
| `DEFAULT_TTL` | `0` | Default TTL in seconds (0 = no expiration) |

### Coordinator Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Coordinator port |
| `CACHE_NODES` | `http://localhost:3001,...` | Comma-separated list of cache node URLs |
| `HEALTH_CHECK_INTERVAL` | `5000` | Health check interval in ms |
| `VIRTUAL_NODES` | `150` | Number of virtual nodes per physical node |

## Running Multiple Instances

### Native

```bash
# Terminal 1: Cache Node 1
PORT=3001 NODE_ID=node-1 node src/server.js

# Terminal 2: Cache Node 2
PORT=3002 NODE_ID=node-2 node src/server.js

# Terminal 3: Cache Node 3
PORT=3003 NODE_ID=node-3 node src/server.js

# Terminal 4: Coordinator
PORT=3000 CACHE_NODES=http://localhost:3001,http://localhost:3002,http://localhost:3003 node src/coordinator.js
```

### Docker

```bash
# Scale cache nodes
docker-compose up -d --scale cache-node-1=1 --scale cache-node-2=1 --scale cache-node-3=1
```

## Key Concepts

### Consistent Hashing

Keys are distributed across nodes using consistent hashing with virtual nodes:

1. Each physical node gets 150 virtual nodes on the hash ring
2. Keys are hashed and assigned to the next clockwise virtual node
3. When a node is added/removed, only ~1/N keys are remapped
4. Virtual nodes ensure even distribution across physical nodes

### LRU Eviction

When the cache reaches its limits (size or memory):

1. Least Recently Used (LRU) entries are evicted first
2. Memory is estimated based on JSON serialization size
3. Eviction happens automatically on SET operations

### TTL Expiration

Keys can be set with a TTL (Time-To-Live):

1. **Lazy expiration**: Keys are checked and deleted on access
2. **Active expiration**: Background process samples and expires keys
3. TTL of 0 means no expiration
4. TTL of -1 (in GET response) means the key has no expiration

## Monitoring

The frontend dashboard provides:

- **Dashboard**: Overview of cluster health and statistics
- **Keys**: Browse, search, and manage cache keys
- **Cluster**: Manage nodes and view hash ring
- **Test**: Interactive testing of cache operations

## Development

### Project Structure

```
distributed-cache/
├── backend/
│   ├── src/
│   │   ├── lib/
│   │   │   ├── consistent-hash.js   # Consistent hashing implementation
│   │   │   └── lru-cache.js         # LRU cache with TTL
│   │   ├── server.js                # Cache node server
│   │   └── coordinator.js           # Request router/coordinator
│   ├── package.json
│   ├── Dockerfile
│   └── Dockerfile.coordinator
├── frontend/
│   ├── src/
│   │   ├── components/              # React components
│   │   ├── routes/                  # TanStack Router routes
│   │   ├── stores/                  # Zustand stores
│   │   ├── services/                # API clients
│   │   └── types/                   # TypeScript types
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml
├── architecture.md
├── system-design-answer.md
└── README.md
```

### Running Tests

```bash
cd backend
npm test
```

## License

MIT
