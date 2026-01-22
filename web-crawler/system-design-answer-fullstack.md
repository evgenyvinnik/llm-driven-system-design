# Web Crawler - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## 📋 Introduction (2 minutes)

"I'll design a distributed web crawler with end-to-end integration. The full-stack challenge is connecting a high-throughput backend crawling system with a reactive monitoring dashboard. This requires:

1. **Backend complexity** - URL frontier, distributed workers, politeness enforcement
2. **Real-time frontend** - Live statistics and management controls
3. **Data contracts** - Type safety across the entire system
4. **Dual-write patterns** - Immediate cache updates with durable storage

Let me clarify requirements first."

---

## 🎯 Requirements Clarification (5 minutes)

### Functional Requirements

"For the distributed crawler with monitoring dashboard:

1. **URL Discovery** - Extract links from pages, queue for crawling
2. **Distributed Crawling** - Workers fetch pages while respecting politeness
3. **Deduplication** - Avoid re-crawling duplicate URLs
4. **Admin Dashboard** - Real-time stats, domain management, seed URL control
5. **Worker Monitoring** - Health status and throughput visualization

I'll focus on end-to-end data flow and technology choices for the integration layer."

### Non-Functional Requirements

| Requirement | Target | Implication |
|-------------|--------|-------------|
| Scale | 10,000 pages/second | Need efficient data propagation |
| Dashboard Latency | < 2 seconds | Real-time protocol required |
| Type Safety | End-to-end | Shared contracts between FE/BE |
| Operator Control | Immediate effect | Dual-write to cache + DB |

---

## 🏗️ High-Level Design (8 minutes)

### End-to-End Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Admin Dashboard (React)                          │
│   Real-time stats │ URL frontier │ Domain mgmt │ Worker monitoring      │
└─────────────────────────────────────────────────────────────────────────┘
                    │                           │
                    │ REST API                  │ WebSocket
                    ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          API Server (Express)                            │
│   Routes: /api/urls, /api/domains, /api/workers, /api/stats             │
│   WebSocket: /ws/stats (real-time updates)                              │
└─────────────────────────────────────────────────────────────────────────┘
                    │                           │
        ┌───────────┴───────────┐               │
        ▼                       ▼               ▼
┌───────────────┐      ┌───────────────┐  ┌──────────────┐
│  Coordinator  │      │    Workers    │  │ Stats Agg    │
│               │◄────►│   (1...N)     │  │              │
│ - Assignment  │      │ - Fetch pages │  │ - Metrics    │
│ - Scheduling  │      │ - Extract     │  │ - Broadcast  │
└───────────────┘      └───────────────┘  └──────────────┘
        │                       │                 │
        └───────────────────────┴─────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│  PostgreSQL   │      │     Redis     │      │ Object Store  │
│ - URL frontier│      │ - Rate limits │      │ - Page content│
│ - Domain meta │      │ - Pub/Sub     │      │ - robots.txt  │
└───────────────┘      └───────────────┘      └───────────────┘
```

---

## 🔍 Deep Dive: Real-Time Protocol Choice (8 minutes)

### Why WebSocket Over SSE?

| Factor | WebSocket | SSE | Winner |
|--------|-----------|-----|--------|
| Direction | Bidirectional | Server → Client only | WebSocket |
| Protocol | Custom frames | HTTP streaming | SSE (simpler) |
| Reconnection | Manual handling | Built-in | SSE |
| Browser support | Universal | Universal | Tie |
| Future extensibility | Can add commands | Read-only | WebSocket |

**Decision: ✅ WebSocket**

"I'm choosing WebSocket because while SSE would work for one-way stats streaming, we'll likely want bidirectional communication later - subscribing to specific domains, pausing workers from dashboard, or filtering stats. WebSocket gives us that flexibility without protocol changes."

### Stats Streaming Architecture

```
Workers                   Redis                    API Server               Dashboard
   │                        │                          │                        │
   │  PUBLISH crawler:stats │                          │                        │
   │────────────────────────►                          │                        │
   │                        │                          │                        │
   │                        │ SUBSCRIBE crawler:stats  │                        │
   │                        │◄─────────────────────────│                        │
   │                        │                          │                        │
   │                        │ Message received         │                        │
   │                        │─────────────────────────►│                        │
   │                        │                          │                        │
   │                        │                          │ ws.send(stats)         │
   │                        │                          │───────────────────────►│
   │                        │                          │                        │
   │                        │                          │ Fallback: poll every   │
   │                        │                          │ 2s if Pub/Sub missed   │
   │                        │                          │───────────────────────►│
```

### Why Redis Pub/Sub for Stats Distribution?

| Approach | Pros | Cons |
|----------|------|------|
| Direct DB polling | Simple | High DB load, latency |
| Message queue (RabbitMQ) | Durable, acknowledgments | Overkill for ephemeral stats |
| Redis Pub/Sub | Low latency, simple | Fire-and-forget, no persistence |
| Kafka | Replay, partitioning | Complex setup for dashboard stats |

**Decision: ✅ Redis Pub/Sub**

"Stats are ephemeral - if a dashboard misses one update, the next one arrives in 2 seconds. We don't need message durability. Redis Pub/Sub gives us sub-millisecond latency with minimal complexity. The API server subscribes once and broadcasts to all WebSocket clients."

---

## 🏗️ Deep Dive: Type Sharing Strategy (6 minutes)

### Why Shared TypeScript Types?

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Shared types folder | Simple, no tooling | Must keep in sync manually |
| OpenAPI + codegen | Auto-generated clients | Build step, version drift |
| GraphQL | Schema is contract | Overhead for REST-like APIs |
| JSON Schema | Language agnostic | Verbose, less TypeScript integration |

**Decision: ✅ Shared types folder**

"For a monorepo with TypeScript on both ends, a shared folder is simplest. Both frontend and backend import from the same source. No code generation, no schema drift. If we had multiple language clients, I'd switch to OpenAPI."

### Type Safety at Boundaries

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│    Frontend     │       │    Shared       │       │    Backend      │
│                 │       │                 │       │                 │
│  API Client     │──────►│  Type Defs      │◄──────│  Route Handlers │
│  uses types     │       │  FrontierURL    │       │  validate with  │
│                 │       │  Domain         │       │  Zod schemas    │
│  Zod for forms  │       │  Worker         │       │                 │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

### Why Zod for Validation?

| Library | Pros | Cons |
|---------|------|------|
| ✅ Zod | Type inference, great DX | Slightly larger bundle |
| io-ts | Functional style, precise | Steeper learning curve |
| Yup | Popular, schema-based | Weaker TypeScript inference |
| class-validator | Decorators, OOP | Class-based, heavier |

**Decision: ✅ Zod**

"Zod gives us runtime validation with automatic TypeScript type inference. Define the schema once, get both validation and types. The DX is excellent - error messages are clear, composition is intuitive."

---

## 📊 Deep Dive: Dual-Write Pattern for Domain Control (8 minutes)

### The Problem

When an operator changes a domain's crawl delay from the dashboard, workers need to see that change immediately. But we also need the change persisted.

### Solution: Write to Both Redis and PostgreSQL

```
Dashboard                API Server               Redis              PostgreSQL
    │                        │                      │                     │
    │  PATCH /domains/foo    │                      │                     │
    │  {crawlDelayMs: 2000}  │                      │                     │
    │───────────────────────►│                      │                     │
    │                        │                      │                     │
    │                        │  SET crawldelay:foo  │                     │
    │                        │───────────────────►  │  (immediate effect) │
    │                        │                      │                     │
    │                        │  UPDATE domains...   │                     │
    │                        │──────────────────────────────────────────► │
    │                        │                      │  (durable storage)  │
    │                        │                      │                     │
    │  200 OK                │                      │                     │
    │◄───────────────────────│                      │                     │
```

### Why Not Just PostgreSQL?

| Approach | Latency | Durability | Worker Complexity |
|----------|---------|------------|-------------------|
| PostgreSQL only | ~5-50ms | ✓ | Query on every URL |
| Redis only | ~1ms | ✗ | Simple key lookup |
| ✅ Both (dual-write) | ~1ms read | ✓ | Simple key lookup |

**Decision: ✅ Dual-write**

"Workers check rate limits on every URL fetch. Hitting PostgreSQL every time would add latency and load. Redis gives us microsecond reads. We write to both - Redis for immediate effect, PostgreSQL for durability across restarts."

### Handling Dual-Write Failures

| Scenario | Handling |
|----------|----------|
| Redis write fails | Return error, don't update PostgreSQL |
| PostgreSQL write fails | Redis already updated, log for reconciliation |
| Both succeed | Ideal path |

"We accept eventual consistency. If PostgreSQL fails after Redis succeeds, the worker has the new rate limit but it won't survive a restart. A background job can reconcile periodically."

---

## ⚠️ Error Handling Philosophy (4 minutes)

### Backend: Typed Error Classes

| Error Type | HTTP Status | When Used |
|------------|-------------|-----------|
| ValidationError | 400 | Invalid input (Zod failure) |
| NotFoundError | 404 | Domain/URL doesn't exist |
| RateLimitError | 429 | Too many requests |
| InternalError | 500 | Unexpected failures |

### Why Custom Classes Over HTTP Problem Details?

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Custom error classes | Simple, TypeScript-native | Non-standard |
| RFC 7807 Problem Details | Standard format | More verbose |
| Plain objects | Flexible | No structure |

**Decision: ✅ Custom classes**

"For an internal API, custom error classes with `code` and `message` fields are simpler. Problem Details adds value for public APIs where clients need standardization."

### Frontend: Layered Error Handling

```
┌─────────────────────────────────────────┐
│         Error Boundary (React)          │  ← Catches render crashes
├─────────────────────────────────────────┤
│         Toast Notifications             │  ← Shows API errors
├─────────────────────────────────────────┤
│         API Client Layer                │  ← Parses error responses
└─────────────────────────────────────────┘
```

"Three layers: Error Boundary catches React crashes, Toasts show API errors to users, API client layer parses and types the errors. Each layer has a specific job."

---

## ⚖️ Trade-offs Summary (2 minutes)

| Decision | Chosen | Rejected | Why |
|----------|--------|----------|-----|
| Real-time protocol | ✅ WebSocket | ❌ SSE | Bidirectional for future features |
| Stats distribution | ✅ Redis Pub/Sub | ❌ Kafka | Ephemeral data, simplicity |
| Type sharing | ✅ Shared folder | ❌ OpenAPI codegen | Monorepo, no build step |
| Validation | ✅ Zod | ❌ io-ts | Better DX, type inference |
| Domain updates | ✅ Dual-write | ❌ PostgreSQL only | Low-latency worker reads |
| Error format | ✅ Custom classes | ❌ Problem Details | Internal API, simplicity |

---

## 🚀 Future Enhancements

With more time:

1. **OpenAPI generation** - If we add non-TypeScript clients
2. **Optimistic updates** - Show changes before server confirms
3. **WebSocket commands** - Subscribe to specific domain stats
4. **Circuit breaker** - Frontend gracefully degrades if backend fails

---

## 📝 Summary

"I've designed a distributed web crawler with full-stack integration focused on:

1. **WebSocket over SSE** - Bidirectional for future extensibility
2. **Redis Pub/Sub** - Low-latency ephemeral stats, no Kafka complexity
3. **Shared TypeScript types** - Simple monorepo approach, no codegen
4. **Dual-write for domain control** - Immediate Redis + durable PostgreSQL
5. **Layered error handling** - Each layer has specific responsibility

The key insight is matching technology to data characteristics - ephemeral stats use Pub/Sub, durable config uses dual-write, and type safety comes from shared code rather than generated clients."
