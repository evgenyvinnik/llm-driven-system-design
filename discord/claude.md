# Baby Discord - Development with Claude

## Project Context

This document tracks the development journey of "Baby Discord" - a simplified, educational chat server that supports **dual protocols** (raw TCP and HTTP) to teach core distributed system concepts.

**Why "Baby" Discord?**
- Focus on **fundamentals** rather than production features
- Simple enough to run locally and understand completely
- Complex enough to demonstrate real distributed system challenges
- Teaches protocol abstraction, state management, caching, and horizontal scaling

---

## Design Philosophy: Learning Through Constraints

This project deliberately introduces constraints to force learning:

1. **Dual Protocols (TCP + HTTP)**: Forces us to think about protocol abstraction
2. **10 Message History Limit**: Teaches bounded buffers and cache invalidation
3. **Local Multi-Instance**: Demonstrates distribution without cloud complexity
4. **No WebSocket (SSE instead)**: Shows when "simpler" is better than "cooler"

---

## Key Challenges to Explore

### 1. Protocol-Agnostic Service Design

**Challenge**: How do we build a chat server that works equally well with netcat (TCP) and browsers (HTTP)?

**Approach**:
- **Adapter Pattern**: TCP and HTTP are thin adapters over shared core logic
- **Normalized Commands**: Both protocols convert input to same command structure
- **Transport Callbacks**: Core doesn't know about sockets or HTTP responses

**Learning Outcome**:
- Understand separation of concerns (transport vs business logic)
- See how Slack/Discord support multiple clients (mobile, desktop, web)

### 2. Stateful vs Stateless Service Design

**Challenge**: Chat is inherently stateful (who's connected, what room are they in?), but HTTP is stateless. How do we reconcile?

**Approaches Considered**:

| Approach              | TCP                        | HTTP                          | Trade-off                       |
|-----------------------|----------------------------|-------------------------------|---------------------------------|
| Full Stateful         | ✅ Socket = session        | ❌ Can't scale (sticky sessions) | Simple, but limits scaling      |
| Full Stateless        | ❌ TCP needs connection    | ✅ Session in DB/Redis         | Complex, but scalable           |
| **Hybrid (Chosen)**   | ✅ Socket = session        | ⚠️ Session ID + SSE connection | Balance simplicity and scaling  |

**Decision**: Use hybrid approach
- TCP: Inherently stateful (socket connection = user session)
- HTTP: Session ID in requests, but SSE maintains connection for messages

**Learning Outcome**:
- Not everything needs to be stateless
- Choose the right model for each protocol's strengths

### 3. Message History: Speed vs Durability

**Challenge**: How do we provide message history efficiently while ensuring persistence?

**Approaches Compared**:

**Approach A: Always Query Database**
```javascript
function getHistory(room) {
  return db.query('SELECT * FROM messages WHERE room = ? ORDER BY time DESC LIMIT 10', room)
}
```
- **Pros**: Simple, always consistent, no cache invalidation
- **Cons**: DB query on every join (~10-50ms latency), high DB load
- **When to use**: Small scale, simplicity prioritized

**Approach B: In-Memory Ring Buffer (Chosen)**
```javascript
class HistoryBuffer {
  buffers: Map<string, Message[]>  // room → last 10 messages

  addMessage(room, msg) {
    buffer.push(msg)
    if (buffer.length > 10) buffer.shift()  // Ring buffer
    db.insert(msg).catch(log)  // Async persist
  }
}
```
- **Pros**: Fast (~0.01ms), teaches caching patterns
- **Cons**: Messages lost if crash before DB persist
- **When to use**: Learning caching, acceptable data loss

**Approach C: Write-Ahead Log (WAL)**
```javascript
function addMessage(room, msg) {
  fs.appendFile('wal.log', JSON.stringify(msg))  // Sync write
  buffer.push(msg)
  db.insert(msg).catch(log)  // Async persist
}
```
- **Pros**: Guaranteed durability, fast reads
- **Cons**: Complex recovery logic, disk I/O overhead
- **When to use**: Production systems, zero data loss requirement

**Decision**: Approach B (Ring Buffer)

**Rationale**:
- Primary goal is **learning caching patterns**
- Demonstrates trade-off: speed (1000x faster than DB) vs durability
- Acceptable risk for educational project (losing <10 messages on crash)

**Learning Outcome**:
- Understand caching strategies
- See why production systems use WAL (Redis AOF, PostgreSQL WAL)
- Practice making engineering trade-offs

### 4. Real-Time Updates: SSE vs WebSocket

**Challenge**: How do we push messages from server to browser?

**Options Compared**:

| Feature                  | Server-Sent Events (SSE) | WebSocket            | Long Polling         |
|--------------------------|--------------------------|----------------------|----------------------|
| Directionality           | Server → Client only     | Bidirectional        | Client initiates     |
| Protocol                 | HTTP (text/event-stream) | WS (upgrade)         | HTTP (GET/POST)      |
| Browser API              | EventSource (native)     | WebSocket (native)   | fetch() in loop      |
| Auto Reconnection        | ✅ Built-in              | ❌ Manual            | ❌ Manual            |
| Complexity               | Low (HTTP)               | Medium (handshake)   | Low (just HTTP)      |
| Latency                  | ~50-100ms                | ~10-50ms             | ~500-1000ms          |
| Use case fit             | ✅ Perfect (broadcast)   | ⚠️ Overkill          | ⚠️ Inefficient       |

**Decision**: SSE (Server-Sent Events)

**Rationale**:
1. **One-directional is sufficient**: Messages flow server → client; commands use POST
2. **Simpler debugging**: Plain HTTP, can inspect with curl/browser DevTools
3. **Auto-reconnect**: Browser handles reconnection automatically
4. **Native API**: EventSource is built into browsers

**When WebSocket is better**:
- Real-time gaming (need <10ms latency, bidirectional)
- Binary data (video/audio streams)
- Complex protocols (chat + screen sharing + calls)

**Learning Outcome**:
- Don't over-engineer: Use simplest solution that works
- Understand trade-offs between technologies
- Know when to use WebSocket (and when not to)

### 5. Horizontal Scaling: How Do Multiple Instances Communicate?

**Challenge**: If we run 3 instances on different ports, users on different instances can't chat. How do we solve this?

**Options Compared**:

**Option A: Database Polling**
```javascript
setInterval(() => {
  const newMessages = db.query('SELECT * FROM messages WHERE created_at > ?', lastCheck)
  newMessages.forEach(msg => broadcast(msg))
}, 100)  // Poll every 100ms
```
- **Pros**: Simple, no new infrastructure
- **Cons**: High DB load, 100ms latency, inefficient
- **When to use**: < 3 instances, simple deployment

**Option B: Pub/Sub (Valkey/Redis) - Chosen**
```javascript
// On startup
redis.subscribe('room:general')

// When user sends message
redis.publish('room:general', JSON.stringify(message))

// All instances receive
redis.on('message', (channel, data) => {
  broadcastToLocalClients(data)
})
```
- **Pros**: Low latency (~1-5ms), efficient, scales to 100+ instances
- **Cons**: Adds dependency (Valkey/Redis)
- **When to use**: > 3 instances, production scale

**Option C: Gossip Protocol (Instance-to-Instance)**
```javascript
// Each instance tracks other instances
instances = ['http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003']

// Broadcast message to all peers
function sendMessage(msg) {
  instances.forEach(url => {
    fetch(`${url}/peer/message`, { method: 'POST', body: msg })
  })
}
```
- **Pros**: No external dependency, educational (learn distributed systems)
- **Cons**: Complex (handle failures, discovery), O(N²) network calls
- **When to use**: Learning project, < 10 instances

**Decision**: Start with Option A (polling), migrate to Option B (pub/sub)

**Rationale**:
- **Phase 1**: Database polling teaches the problem (high latency, inefficiency)
- **Phase 2**: Pub/sub demonstrates solution (low latency, scalable)
- **Educational**: See the evolution of architectural complexity

**Learning Outcome**:
- Understand why pub/sub exists (fan-out messaging)
- See performance difference (100ms → 1ms)
- Learn when to add infrastructure (Valkey/Redis)

### 6. Node.js vs Other Languages

**Challenge**: Why Node.js instead of Go/Rust for a chat server?

**Comparison**:

| Language  | Concurrency Model       | Typical Latency | Memory per Connection | Learning Curve |
|-----------|-------------------------|-----------------|----------------------|----------------|
| Node.js   | Event loop (async I/O)  | 10-50ms         | ~10 KB               | Low            |
| Go        | Goroutines (CSP)        | 1-10ms          | ~2 KB                | Medium         |
| Rust      | Tokio (async runtime)   | 1-5ms           | ~2 KB                | High           |
| Python    | asyncio (or threads)    | 50-200ms        | ~50 KB               | Low            |

**Decision**: Node.js (for this educational project)

**Rationale**:
1. **I/O-Bound Workload**: Chat is network-bound (DB queries, message routing), not CPU-bound
2. **Single Language**: TypeScript for TCP server, HTTP server, and frontend
3. **Familiarity**: Most developers know JavaScript/TypeScript
4. **Fast Iteration**: npm ecosystem, hot reload, quick prototyping

**Trade-offs Acknowledged**:
- **Performance**: Go/Rust would handle 10x more connections (~100K vs ~10K)
- **Latency**: Go/Rust would have lower p99 latency (~1ms vs ~10ms)
- **Memory**: Go/Rust more efficient (~2KB vs ~10KB per connection)

**When to reconsider**:
- If profiling shows CPU bottleneck (e.g., heavy message parsing)
- If targeting >50K concurrent connections per instance
- If latency requirement <5ms

**Learning Outcome**:
- Understand that "best" depends on context (educational vs production)
- See how language choice affects architecture
- Know when performance matters (and when it doesn't)

---

## Development Phases

### Phase 1: Requirements and Design ✅

**Goal**: Define clear requirements and architectural approach

**Questions Explored**:
- What features make this "Baby" Discord (vs full Discord)?
- Why both TCP and HTTP (educational value)?
- What scale are we targeting (local testing)?
- What are acceptable trade-offs (data loss, latency)?

**Outcomes**:
- Scoped to 4 core features (slash commands, rooms, history, persistence)
- Justified dual protocol (teaches abstraction)
- Defined local scale (10-20 concurrent users, 3 instances)
- Accepted trade-offs (10-message history, no auth, async persist)

**Key Decisions**:
1. Use Node.js + Express (familiarity, I/O-bound workload)
2. Use PostgreSQL (relational data, ACID)
3. Use SSE over WebSocket (simpler, sufficient)
4. Use in-memory ring buffer (teach caching)
5. Support local multi-instance (teach distribution)

### Phase 2: Initial Implementation
**Status**: *Not started*

**Focus Areas**:
1. **TCP Server** (`src/adapters/tcp-server.ts`)
   - Accept socket connections
   - Parse line-based commands
   - Send responses to socket

2. **HTTP Server** (`src/adapters/http-server.ts`)
   - REST endpoints (POST /connect, POST /command, POST /message)
   - SSE endpoint (GET /messages/:room)

3. **Chat Core** (`src/core/`)
   - ConnectionManager: Track sessions
   - RoomManager: Create/join/leave rooms
   - CommandParser: Parse slash commands
   - MessageRouter: Route messages to room members
   - HistoryBuffer: Ring buffer for last 10 messages

4. **Database Layer** (`src/db/`)
   - PostgreSQL client setup
   - Schema migrations (users, rooms, room_members, messages)
   - CRUD operations

5. **Integration**:
   - Wire TCP server → Chat Core
   - Wire HTTP server → Chat Core
   - Test end-to-end (netcat client + browser client)

**Success Criteria**:
- [ ] Can connect via `nc localhost 9001`
- [ ] Can connect via browser `http://localhost:3001`
- [ ] Both clients can join same room and chat
- [ ] Message history shows last 10 messages
- [ ] Data persists across server restart

### Phase 3: Scaling and Optimization
**Status**: *Not started*

**Focus Areas**:

1. **Multi-Instance Support**
   - Add configuration (instance ID, ports)
   - Implement database polling for cross-instance messages
   - Test 3 instances locally (different ports)

2. **Migrate to Pub/Sub**
   - Add Valkey/Redis
   - Replace polling with pub/sub
   - Measure latency improvement (100ms → 1ms)

3. **Load Testing**
   - Spawn 50 concurrent netcat clients
   - Measure messages/sec, latency, memory usage
   - Identify bottlenecks (DB connection pool, etc.)

4. **Monitoring**
   - Add logging (Winston or Pino)
   - Track metrics (connections, messages, latency)
   - Optional: Prometheus + Grafana

**Success Criteria**:
- [ ] 3 instances running locally
- [ ] Users on different instances can chat
- [ ] Latency < 10ms (with pub/sub)
- [ ] Can handle 50 concurrent connections
- [ ] Graceful degradation on failures

### Phase 4: Polish and Documentation
**Status**: *Not started*

**Focus Areas**:
1. Unit tests (ConnectionManager, RoomManager, CommandParser)
2. Integration tests (TCP flow, HTTP flow)
3. README with setup instructions
4. Architecture diagram (draw.io or Mermaid)
5. Code cleanup and comments

**Success Criteria**:
- [ ] 80%+ test coverage
- [ ] Clear setup instructions (< 5 minutes to run)
- [ ] Documented design decisions
- [ ] Clean, readable code

---

## Design Decisions Log

### Decision 1: Dual Protocol (TCP + HTTP)
**Date**: Initial design
**Context**: Need to teach protocol abstraction
**Options**: HTTP only, TCP only, or both
**Decision**: Both
**Rationale**: Educational value of seeing how different protocols solve same problem
**Trade-off**: More code complexity, but teaches adapter pattern

### Decision 2: SSE Instead of WebSocket
**Date**: Initial design
**Context**: Need real-time browser updates
**Options**: SSE, WebSocket, Long Polling
**Decision**: SSE
**Rationale**: Simpler, unidirectional sufficient, auto-reconnect
**Trade-off**: Can't push client→server (but we use POST anyway)

### Decision 3: Ring Buffer for Message History
**Date**: Initial design
**Context**: Need last 10 messages per room
**Options**: Always DB query, in-memory cache, WAL
**Decision**: In-memory ring buffer with async persist
**Rationale**: Teach caching patterns, 1000x faster reads
**Trade-off**: Risk losing <10 messages on crash (acceptable for learning)

### Decision 4: PostgreSQL Over NoSQL
**Date**: Initial design
**Context**: Need to persist users, rooms, messages
**Options**: PostgreSQL, CouchDB, Cassandra, Redis
**Decision**: PostgreSQL
**Rationale**: Relational data (users ↔ rooms), ACID, familiar
**Trade-off**: Less scalable than Cassandra, but suitable for scale

### Decision 5: Valkey Pub/Sub for Multi-Instance
**Date**: Initial design
**Context**: Need to route messages across instances
**Options**: DB polling, Valkey pub/sub, gossip protocol
**Decision**: Start with polling, migrate to Valkey pub/sub
**Rationale**: Show evolution (inefficient → efficient)
**Trade-off**: Adds dependency, but enables low-latency distribution

### Decision 6: Node.js Over Go/Rust
**Date**: Initial design
**Context**: Need to choose backend language
**Options**: Node.js, Go, Rust, Python
**Decision**: Node.js
**Rationale**: I/O-bound workload, familiarity, fast iteration
**Trade-off**: Lower max concurrency than Go/Rust, but sufficient

---

## Iterations and Learnings

### Iteration 1: Initial Design
**What we learned**:
- Dual protocols force clean separation of concerns
- Educational projects should embrace trade-offs (speed vs durability)
- Starting simple (single instance) then scaling teaches evolution

**What surprised us**:
- SSE is often overlooked but perfect for simple real-time updates
- Ring buffers are both simple and educational (caching + bounded resources)
- Local multi-instance testing is powerful for learning distribution

**What we'd do differently**:
- Could consider WebSocket for future phase (after mastering SSE)
- Might add rate limiting earlier (teaches backpressure)

---

## Questions and Discussions

### Q1: Why not use Redis instead of Valkey?
**Answer**: Valkey is fully open-source (forked from Redis after licensing change). For educational projects, we prefer truly free software. Valkey is API-compatible, so knowledge transfers directly.

### Q2: Why PostgreSQL instead of SQLite for simplicity?
**Answer**: SQLite doesn't handle concurrent writes well (chat is write-heavy). PostgreSQL teaches production patterns (connection pooling, transactions). Plus, we want to practice Docker Compose.

### Q3: Why not use WebSocket everywhere?
**Answer**: Educational goal is to show different approaches. TCP teaches low-level sockets, SSE teaches when "simpler" wins. WebSocket would be great Phase 5 (after mastering both).

### Q4: Is 10-message history too limiting?
**Answer**: It's deliberately constrained to teach bounded buffers and cache eviction. Real Discord keeps way more, but that's not the learning goal. We can always query DB for older messages.

### Q5: Why no authentication?
**Answer**: Scope control. This project teaches distributed systems, not auth. Adding auth would obscure the core lessons. Easy to add later (bcrypt, JWTs).

### Q6: How would this change at production scale (1M users)?
**Answers**:
- **Language**: Might switch to Go/Rust for better concurrency
- **Database**: Shard PostgreSQL, or use Cassandra for messages
- **Message History**: Use Kafka (persistent message queue)
- **Distribution**: Add load balancers, service mesh (Istio)
- **Caching**: Add Valkey cluster for session state
- **Monitoring**: Full observability (Prometheus, Grafana, Jaeger)

---

## Resources and References

### Similar Systems (Inspiration)
- **IRC**: Classic chat protocol (RFC 1459) - TCP-based, room channels
- **Slack**: Modern chat with HTTP API and WebSocket
- **Discord**: Gaming chat with voice/video (WebRTC)

### Technical References
- [Node.js Net Module](https://nodejs.org/api/net.html) - TCP server
- [Express.js SSE Example](https://masteringjs.io/tutorials/express/server-sent-events)
- [PostgreSQL Many-to-Many](https://www.postgresqltutorial.com/postgresql-tutorial/postgresql-many-to-many-relationship/)
- [Redis Pub/Sub](https://redis.io/docs/manual/pubsub/) - Also applies to Valkey
- [Ring Buffer Explained](https://en.wikipedia.org/wiki/Circular_buffer)

### Learning Resources
- [Designing Data-Intensive Applications](https://dataintensive.net/) - Chapters on replication, partitioning
- [System Design Primer](https://github.com/donnemartin/system-design-primer) - Chat system section
- [Node.js Scaling](https://nodejs.org/en/docs/guides/dont-block-the-event-loop/) - Event loop best practices

---

## Next Steps

### Immediate (Phase 2)
- [ ] Set up project structure (`src/adapters`, `src/core`, `src/db`)
- [ ] Initialize npm project with TypeScript
- [ ] Set up PostgreSQL via Docker Compose
- [ ] Implement CommandParser (TDD - tests first)
- [ ] Implement ConnectionManager
- [ ] Implement RoomManager
- [ ] Build TCP server (basic echo first, then integrate)
- [ ] Build HTTP server (REST API first, then SSE)
- [ ] End-to-end test (netcat + browser)

### Medium-Term (Phase 3)
- [ ] Add Valkey via Docker Compose
- [ ] Implement pub/sub message routing
- [ ] Configure multi-instance setup (3 instances)
- [ ] Load test with 50 concurrent clients
- [ ] Add logging and basic metrics

### Long-Term (Phase 4)
- [ ] Write comprehensive tests (unit + integration)
- [ ] Create architecture diagram (Mermaid)
- [ ] Document setup process (README)
- [ ] Record demo video (netcat + browser)
- [ ] Reflect on learnings (update this doc)

---

## Reflection Questions (To Answer After Completion)

1. **What was the hardest design decision?**
   - *To be answered after implementation*

2. **What would break first under load?**
   - *To be answered after load testing*

3. **What did we over-engineer?**
   - *To be answered after reflection*

4. **What did we under-engineer?**
   - *To be answered after finding edge cases*

5. **What would we do differently next time?**
   - *To be answered at project end*

6. **What was the most valuable learning?**
   - *To be answered after completion*

---

## Collaboration Notes

### Working with Claude
**What works well**:
- Asking "why" for every decision (forces justification)
- Comparing multiple approaches (trade-off analysis)
- Starting with constraints (10 messages, local-only, dual protocol)
- Incremental phases (single instance → multi-instance)

**What to improve**:
- Ask Claude to challenge decisions more aggressively
- Request performance analysis (benchmarks, profiling)
- Demand production migration path (what changes at 1M users?)

### Design Discussion Patterns
1. **State the problem** (e.g., "How to share state across instances?")
2. **List 3+ approaches** (polling, pub/sub, gossip)
3. **Compare trade-offs** (latency, complexity, cost)
4. **Choose one** with justification
5. **Document "when to reconsider"** (at what scale does choice break?)

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings. The goal is to document not just **what** we built, but **why** we made each decision and **what alternatives** we considered.*
