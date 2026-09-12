# DoorDash: architecture and implementation

## System Overview

Design a food-delivery marketplace in which customers place orders, restaurants prepare them, and drivers complete delivery. The central problem is coordinating scarce driver capacity and authoritative order state while tracking positions that may already be stale. This document proposes a production architecture, reproduces the actual local schema, and closes with source-verified implementation notes. Production components and targets are proposals, not claims about DoorDash's internal systems or this demo's measured performance.

## Requirements

### Functional requirements — proposed production scope

- Discover open restaurants and available menus in a service area; retain a single-restaurant cart.
- Quote a delivery total, get customer agreement, and create one durable order for one checkout operation.
- Let authorized restaurants confirm, prepare, and mark orders ready; assign one active order per driver initially.
- Deliver expiring offers to eligible drivers, accept them online, and enforce pickup/delivery transitions.
- Show order status, last known driver position, freshness, and an ETA range to authorized participants.
- Support cancellation according to explicit state/actor policy and keep an attributable history for support.

Payments, refunds, and driver payouts require a separate provider workflow if added. This design concentrates on ordering and dispatch; a stored total or fee statistic does not represent money movement. Multi-order batching, chat, recommendations, and global dispatch optimization are outside the initial scope.

### Non-functional requirements — proposed targets

| Requirement | Target and boundary |
|-------------|---------------------|
| Availability | 99.9% monthly for regional order reads/writes, excluding an external payment workflow |
| Checkout | p95 under 500 ms for the local order transaction after an accepted quote |
| Order visibility | p95 committed changes visible within 2 s to connected, authorized clients |
| Location intake | p95 under 200 ms; nominal 10 s cadence while tracking is active |
| Freshness | Exclude positions older than 30 s from dispatch; display observation age to clients |
| Correctness | One receipt per checkout operation; one live assignment per order and driver; authorized, serialized state changes |
| Recovery | Durable order/outbox records survive process loss; stale location can be discarded |

A ten-second GPS interval is an initial load/battery assumption, not an accuracy guarantee. Mobile background delivery needs a suitable native client and permissions; the local browser app cannot promise continuous tracking with its screen off.

## Capacity Estimation

Assume one million orders per day, 100,000 simultaneously reporting drivers at the busiest time, and 200,000 WebSocket connections across the three personas. These figures describe a hypothetical fleet spread across markets, not one local database.

| Workload | Calculation | Consequence |
|----------|-------------|-------------|
| Checkout | 1,000,000 / 86,400 ≈ 11.6/s average; budget 10× peak ≈ 116/s | Transactions are modest compared with telemetry; meal peaks concentrate by market |
| Location ingress | 100,000 / 10 s = 10,000 updates/s at peak | Keep telemetry off the transactional order write path |
| Durable lifecycle events | Assume 6/order = 6 million/day ≈ 69/s average | Includes a simplified mix of creation, transitions, and dispatch; real counts vary |
| Core order data | Assume 2 KiB/order including lines = 1.9 GiB/day, 696 GiB/year | Excludes indexes, replicas, backups, images, receipts, and audit overhead |
| Lifecycle event payloads | 6 million × 1 KiB ≈ 5.7 GiB/day | Set retention and replication explicitly |
| Location retention upper bound | 10,000/s sustained × 200 bytes × 86,400 ≈ 161 GiB/day | A constant-peak bound, not a daily forecast; sample history and expire it |
| Position fan-out | At most 2 viewers/update in this model ≈ 20,000 deliveries/s at peak | Subscription count and slow clients matter as much as input throughput |

A latest-position record of 200 bytes for 100,000 drivers is about 19 MiB of payload; Redis object, index, and replication overhead must be measured separately. Location publications add up to 10,000 events/s if all are retained, so Kafka traffic cannot be estimated from lifecycle events alone.

### Local Development Scale

The seed contains four users, five restaurants, 25 menu items, one driver, and one sample order. Compose starts four infrastructure containers; one API and one Vite process run on the host. No benchmark or demonstrated memory ceiling accompanies the project. Start one application instance for the ordinary demo.

## High-Level Architecture

Proposed production layout; each market has an authoritative order/assignment database:

```
┌─────────────────────┐    ┌─────────────────────┐
│ Three client apps   │───▶│ CDN + API gateway   │
└─────────────────────┘    └──────────┬──────────┘
                                     │
           ┌─────────────────────────┼──────────────────────┐
           ▼                         ▼                      ▼
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────┐
│ Catalog + orders    │  │ Dispatch + ETA      │  │ Location intake │
└──────────┬──────────┘  └──────────┬──────────┘  └────────┬────────┘
           │                       │                      │
           ▼                       ▼                      ▼
┌───────────────────────────────────────┐       ┌─────────────────┐
│ Market SQL: orders, claims, outbox    │       │ Fresh geo index │
└───────────────────┬───────────────────┘       └────────┬────────┘
                    ▼                                    │
          ┌───────────────────┐                          │
          │ Outbox → event bus│                          │
          └─────────┬─────────┘                          │
                    ▼                                    ▼
          ┌────────────────────────────────────────────────┐
          │ Authorized socket gateways + notification jobs │
          └────────────────────────────────────────────────┘
```

Dispatch reads fresh geo candidates and writes assignment claims in the same market database as orders. Telemetry feeds a coalescing fan-out path; committed lifecycle events take the durable outbox path. Notification jobs must recheck whether an action is still relevant before sending an old offer. Each socket gateway needs events for its connected subscribers; a single consumer group that distributes events arbitrarily across gateways is insufficient without another routing layer.

## Core Components / Request Flows

### Catalog, quote, and checkout

Discovery can use cached public restaurant/menu data. In production, a spatial index narrows the service area before sorting and pagination. At checkout, the server checks opening status, item availability, quantity bounds, delivery coverage, and money in integer minor units or an exact decimal representation. A quote binds item revisions, delivery address, fees, currency, expiry, and total; changed terms require customer agreement.

The accepted checkout operation is scoped to the actor and quote. In one database transaction, claim its unique operation ID, validate the agreed revisions, insert the order and line snapshots, save the result receipt, and append an outbox event. If validation fails, return an explicit changed-quote response rather than silently charging a new amount. A lost response can be recovered using the same operation ID. Payments, if added, need a durable provider operation and reconciliation; do not hold this SQL transaction across a provider request.

Locally, the cart persists complete menu objects. Creation rereads prices and checks item membership/availability and the restaurant minimum, but does not check opening status or quote agreement. Order and line inserts are separate autocommits; no money is charged.

### Restaurant workflow and driver dispatch

A restaurant confirmation transaction verifies ownership and the current state, records the transition, and writes a dispatch event. A worker finds geographically nearby candidates, rejects expired/offline/busy records, and ranks by estimated pickup suitability. Start with a simple score and measure pickup delay and driver distribution before adding optimization.

To offer a job, atomically reserve the order and driver in the market database with an expiring claim ID. Serialize assignment, acceptance, timeout, cancellation, and delivery against those same records in a consistent locking order. Enforce uniqueness of live driver/order claims; a worker that loses a claim retries a different candidate. Acceptance checks the exact claim and deadline. A timeout releases only its matching claim, so a delayed worker cannot release a replacement assignment.

The local matcher automatically assigns one candidate without offers or a claim transaction. It runs once on confirmation, uses a fixed 5 km radius, and does not expand or retry if no driver is found.

### Order lifecycle

The intended local transition vocabulary is:

| Current state | Allowed next state | Intended actor |
|---------------|--------------------|----------------|
| `PLACED` | `CONFIRMED`, `CANCELLED` | Restaurant/admin; customer may cancel their own placed order |
| `CONFIRMED` | `PREPARING`, `CANCELLED` | Restaurant/admin |
| `PREPARING` | `READY_FOR_PICKUP` | Restaurant/admin |
| `READY_FOR_PICKUP` | `PICKED_UP` | Assigned driver/admin |
| `PICKED_UP` | `DELIVERED` | Assigned driver/admin |
| `DELIVERED` | `COMPLETED` | System |
| `COMPLETED`, `CANCELLED` | None | Terminal |

In production, one transition service enforces actor, expected version, assignment identity, state update, audit entry, and outbox write in a short transaction. Repeated delivery operations return their original receipt instead of incrementing counters twice. Cancellation also releases an associated claim. `COMPLETED` is an internal closeout step, not evidence of settled payment.

The local CHECK constraint limits status values only. Handlers validate a prior read and later update by ID alone. They neither serialize competing transitions nor enforce the system-only completion actor; the separate driver endpoints have different side effects.

### Position intake and tracking

A proposed position report includes driver identity from the session, tracking-session ID, sequence, observation time, receipt time, accuracy, and coordinates. Reject malformed/out-of-range points and obsolete sequences. A freshness threshold excludes silent drivers even when a geo member remains. Update the index and freshness metadata consistently; cleanup is an efficiency measure, while the query-time age check is the correctness boundary.

Keep only the newest pending point for a slow consumer. A newer authoritative order revision can terminate tracking independently of any GPS message. On reconnect, fetch a current authorized snapshot and reconcile revisions; location sequence and order version are different counters. Display data age even when the socket is connected.

Locally, every location report first updates SQL synchronously, then Redis GEO, then a metadata hash with a 300 s TTL. Only the hash expires. It publishes to Kafka and pushes positions to process-local order channels; no freshness or sequence check exists.

### ETA

Before pickup, travel to the restaurant and food preparation overlap. An illustrative estimate is the larger of those remaining durations, plus restaurant-to-customer travel and handoff buffers. After pickup, use the driver's current location to the customer, remove completed pickup work, and show a confidence range. Dispatch delay must be included before an assignment exists. Traffic and kitchen uncertainty should be observable inputs, not invented explanations for every delay.

The local formula uses straight-line distance, fixed vehicle speeds, clock-based multipliers, and a five-minute combined buffer. It does not call a road-routing service or train a model. Its exact limitations are listed below.

## Database Schema

The following SQL is the **actual local schema** from [backend/src/db/init.sql](./backend/src/db/init.sql), including its existing indexes and constraints. It is not a production migration and does not implement the proposed claims/receipts/outbox. In particular, there is no PostGIS column, version field, positive-quantity check, location-history table, or uniqueness constraint preventing multiple active orders per driver.

```sql
-- DoorDash Database Schema
-- Initialize the database with all required tables

-- Users table (customers, restaurant owners, drivers)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(20),
  role VARCHAR(20) DEFAULT 'customer' CHECK (role IN ('customer', 'restaurant_owner', 'driver', 'admin')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Restaurants
CREATE TABLE restaurants (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  address VARCHAR(500) NOT NULL,
  lat DECIMAL(10, 8) NOT NULL,
  lon DECIMAL(11, 8) NOT NULL,
  cuisine_type VARCHAR(50),
  rating DECIMAL(2, 1) DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  prep_time_minutes INTEGER DEFAULT 20,
  is_open BOOLEAN DEFAULT TRUE,
  image_url VARCHAR(500),
  delivery_fee DECIMAL(10, 2) DEFAULT 2.99,
  min_order DECIMAL(10, 2) DEFAULT 10.00,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Menu Items
CREATE TABLE menu_items (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  category VARCHAR(50),
  image_url VARCHAR(500),
  is_available BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Drivers
CREATE TABLE drivers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  vehicle_type VARCHAR(50) DEFAULT 'car' CHECK (vehicle_type IN ('car', 'bike', 'scooter', 'walk')),
  license_plate VARCHAR(20),
  is_active BOOLEAN DEFAULT FALSE,
  is_available BOOLEAN DEFAULT TRUE,
  current_lat DECIMAL(10, 8),
  current_lon DECIMAL(11, 8),
  rating DECIMAL(2, 1) DEFAULT 5.0,
  rating_count INTEGER DEFAULT 0,
  total_deliveries INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Orders
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE SET NULL,
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  status VARCHAR(30) DEFAULT 'PLACED' CHECK (status IN (
    'PLACED', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP',
    'PICKED_UP', 'DELIVERED', 'COMPLETED', 'CANCELLED'
  )),
  subtotal DECIMAL(10, 2) NOT NULL,
  delivery_fee DECIMAL(10, 2) NOT NULL,
  tax DECIMAL(10, 2) NOT NULL,
  tip DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL,
  delivery_address JSONB NOT NULL,
  delivery_instructions TEXT,
  estimated_delivery_at TIMESTAMP,
  placed_at TIMESTAMP DEFAULT NOW(),
  confirmed_at TIMESTAMP,
  preparing_at TIMESTAMP,
  ready_at TIMESTAMP,
  picked_up_at TIMESTAMP,
  delivered_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  cancel_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Order Items
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  special_instructions TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Reviews
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE UNIQUE,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  restaurant_rating INTEGER CHECK (restaurant_rating >= 1 AND restaurant_rating <= 5),
  restaurant_comment TEXT,
  driver_rating INTEGER CHECK (driver_rating >= 1 AND driver_rating <= 5),
  driver_comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Sessions (for auth)
CREATE TABLE sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit logs for tracking critical business events
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('customer', 'driver', 'restaurant', 'admin', 'system')),
  actor_id INTEGER,
  changes JSONB,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_restaurants_location ON restaurants(lat, lon);
CREATE INDEX idx_restaurants_cuisine ON restaurants(cuisine_type);
CREATE INDEX idx_restaurants_is_open ON restaurants(is_open);
CREATE INDEX idx_menu_items_restaurant ON menu_items(restaurant_id);
CREATE INDEX idx_menu_items_category ON menu_items(category);
CREATE INDEX idx_drivers_location ON drivers(current_lat, current_lon);
CREATE INDEX idx_drivers_active_available ON drivers(is_active, is_available);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX idx_orders_driver ON orders(driver_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_actor ON audit_logs(actor_type, actor_id);

-- Seed data is in db-seed/seed.sql
```

For the production design, add scoped operation receipts, order versions, quote revisions, durable dispatch claims with uniqueness for live claims, and an outbox with stable event IDs and per-order versions. Add explicit nonnegative monetary/positive quantity checks and a validated address/coordinate contract. Store instants with timezone semantics. Introduce spatial indexes for bounded discovery and retention partitions for optional telemetry history; these are proposed changes, not present tables.

Nullable foreign keys use `SET NULL` for several order relationships, but existing inner joins can then hide an order whose customer or restaurant was deleted. A production retention/deletion policy needs immutable order snapshots and queries that remain valid after identity removal. Audit rows are ordinary mutable records, not a tamper-proof ledger.

## API Design

### Existing HTTP surface

All paths below are local APIs. Authentication uses the `session` cookie; there is no bearer-token requirement.

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | Account/session lifecycle |
| GET | `/api/auth/me` | Current user; driver profile included only for role `driver` |
| POST | `/api/auth/become-driver` | Create a driver profile; does not change user role |
| GET | `/api/restaurants` | Open restaurants; optional cuisine/search/lat/lon/radius |
| GET | `/api/restaurants/meta/cuisines` | Cached cuisine list |
| GET | `/api/restaurants/owner/my-restaurants` | Restaurants owned by this user, including for admins |
| GET | `/api/restaurants/:id` | Restaurant and available menu grouped by category |
| POST, PUT | `/api/restaurants`, `/api/restaurants/:id` | Create/update restaurant with owner/admin checks |
| POST | `/api/restaurants/:id/menu` | Add menu item |
| PUT, DELETE | `/api/restaurants/:id/menu/:itemId` | Update/remove menu item |
| POST | `/api/orders` | Create order; requires `X-Idempotency-Key` |
| GET | `/api/orders` | Current user's orders; optional status/limit/offset, default 20 |
| GET | `/api/orders/:id` | Full order for participant/admin |
| GET | `/api/orders/restaurant/:restaurantId` | Restaurant order queue; default limit 50 |
| PATCH | `/api/orders/:id/status` | Request a status transition |
| POST | `/api/drivers/status`, `/api/drivers/location` | Availability and position for current user's driver profile |
| GET | `/api/drivers/orders`, `/api/drivers/stats` | Assigned order list and profile/daily statistics |
| POST | `/api/drivers/orders/:orderId/pickup`, `/api/drivers/orders/:orderId/deliver` | Dedicated driver actions |

A local creation request:

```json
{
  "restaurantId": 1,
  "items": [{ "menuItemId": 1, "quantity": 1 }],
  "deliveryAddress": { "address": "Demo address", "lat": 37.7849, "lon": -122.4094 },
  "deliveryInstructions": "Ring the bell",
  "tip": 3
}
```

The response is `{ "order": ... }` with HTTP 201; totals come from SQL prices, restaurant fee, a flat demo tax of 8.75%, and tip. SQL numeric fields usually arrive as strings. Create-time item objects use camelCase without database item IDs; later reads use stored snake_case rows. TypeScript interfaces do not normalize this difference or validate incoming JSON.

A local status request is `{ "status": "PREPARING" }`, not an action name or versioned command. A restaurant open-state edit expects `{ "isOpen": false }`. No quote endpoint, operation lookup, offer acceptance, location-history API, or payment endpoint is implemented.

### Existing WebSocket surface

`/ws` accepts messages such as `{ "type": "subscribe", "channel": "order:123" }`. Current channel names are `order:<orderId>`, `customer:<userId>:orders`, `restaurant:<restaurantId>:orders`, and `driver:<userId>:orders`. Driver channels use the **user ID**, not the driver-table ID.

Events include `new_order`, `order_assigned`, `order_status_update`, and `driver_location`; there is a client-requested ping/pong response but no server heartbeat loop. The server does not authenticate connections or authorize channel ownership. The production protocol needs both, plus versioned snapshots, bounded subscription counts, payload validation, backpressure, and a documented reconnect contract.

## Key Design Decisions

### Durable order commits versus a cache-only retry marker

Choose a unique operation receipt in the same database transaction as order lines and an outbox entry. Checkout changes durable commercial intent; a retry after a lost response must locate that intent even after a Redis restart. Redis NX is useful for suppressing concurrent work, but its lease can expire while SQL is still running, and a cached response written after commit can be lost in a process crash. It cannot by itself prove whether an order exists.

The cost of the SQL choice is a write per operation, retention rules, and a short contention point for repeated IDs. Scope keys by user and operation, bind them to the agreed payload, and return conflicts for changed payloads. Keep external provider work outside the transaction and reconcile its independent receipt if payments are added.

### Fast candidate discovery versus authoritative assignment

Choose an ephemeral geo index for candidate discovery and SQL claims for exclusivity. A candidate list is necessarily stale: two dispatchers can see the same available driver simultaneously. Updating a Redis availability flag and an order row separately creates an interval where either side can disagree; even a perfect ranking score cannot repair that double booking.

A SQL claim transaction makes the winner explicit. The trade-off is local serialization and additional timeout/acceptance states. Keep a driver's live claims and the order in one market database; route cross-market cases to an explicit handoff instead of pretending a global transaction is free. Measure contention before introducing a more distributed assignment protocol.

### Durable lifecycle events versus replaceable telemetry

Choose durable, versioned events for accepted business actions and latest-value delivery for positions. Losing `DELIVERED` changes what the parties can do; losing one GPS sample can be repaired by the next fresh observation. Putting every sample in every client's reliable queue causes an offline phone to replay a long route before learning where the driver is now.

The cost is two recovery models. Status reconciles against durable snapshots/versions; position reconciles against observation age/session sequence. Sampled telemetry history may help investigate ETA error, but it requires explicit retention and access controls. Neither an open socket nor a Kafka producer's connection flag establishes that the client has the newest relevant state.

## Consistency and Idempotency

Production checkout, assignment, cancellation, acceptance, pickup, and delivery must share the authoritative transition rules. Acquire related records in a consistent order and recheck the actor and expected state while holding the transaction guard. Attach unique event IDs to the resulting outbox records; consumers deduplicate by effect and record completion with their own state changes. This gives recoverable at-least-once processing, not a universal exactly-once guarantee.

The local implementation has a Redis response cache only for checkout. A 60-second NX marker precedes work and responses are cached for 24 hours. Errors are also cached because the middleware wraps every `res.json`; clearing the key in the error branch does not prevent the wrapper from storing the error afterward. Keys are not bound to actor or request body. Redis errors permit processing, and the frontend creates a new UUID on every invocation. No durable receipt resolves an ambiguous checkout result.

## Security / Auth

Production must restrict privileged account provisioning, authorize all HTTP commands and socket subscriptions, validate money/coordinates/quantities, and rate-limit authentication and location ingestion. Use secure cookies and origin/CSRF protections appropriate to the deployment. Minimize delivery address, phone, and precise location data in events; authorization should end when a participant's access ends.

Locally, bcrypt uses cost 10. Sessions are UUIDs stored in PostgreSQL and Redis with a seven-day expiry, plus an HTTP-only SameSite=Lax cookie that is not marked Secure. Authentication checks Redis first and SQL on a miss; a Redis error does not fall back successfully, and the middleware treats the user as unauthenticated. Logout deletes SQL before Redis, so a failed Redis deletion may leave a cached session usable. Registration accepts the supplied role, including `admin`; the UI's limited role buttons are not a server restriction.

## Observability

Proposed service-level indicators are checkout outcome/latency, receipt conflicts, dispatch queue age, offer acceptance/expiry, duplicate-assignment violations, order-event lag, stale driver fraction, and ETA error by delivery stage and market. Use low-cardinality labels and trace IDs spanning HTTP, outbox, workers, and notifications. Reconcile active-order/driver counts from authority rather than trusting accumulated increments forever.

The local entry point exposes `/metrics`, `/health`, `/health/ready`, and `/health/live`. PostgreSQL and Redis determine readiness; Kafka unavailability is informational. Pino request/business logging, HTTP histograms, matching duration, assignment counters, and several gauges are wired, but gauge updates differ across the generic and dedicated driver paths. Values start at zero per process, can become negative, and do not reconcile from SQL. Restaurant-ID metric labels and unmatched raw paths also need cardinality review. Kafka health records connection state without resetting it on every failed send; no consumer-lag metric exists because there are no consumers.

## Failure Handling

| Failure | Proposed production behavior | Current local behavior |
|---------|------------------------------|------------------------|
| Checkout response lost | Retry same operation; return committed receipt | New frontend UUID may create another order |
| Item insert fails | Roll back order, lines, receipt, and outbox | Earlier inserts remain committed |
| Redis unavailable | Suspend fresh matching; serve bounded catalog fallback; explicit auth dependency policy | Cache helpers catch errors; auth fails and startup awaits Redis; matcher can use stale SQL coordinates after a geo error |
| No driver available | Durable dispatch backlog with bounded retries and visible delay | One matching attempt; no rematching worker |
| Matcher times out | Worker relinquishes/renews a fenced claim; reconcile outcome | Opossum returns a queued-shaped fallback without creating a queue job; underlying work can continue |
| Kafka unavailable | Outbox retains work; relay retries with lag monitoring | Producer methods return false/log; request paths do not durably retain events |
| Socket disconnect | Authorized snapshot catch-up and version reconciliation | Client reconnects but has no snapshot catch-up, replay, or polling fallback |
| Cancellation races assignment | Same order/claim transaction determines a winner | Matcher can assign after cancellation; assigned driver is not reliably released |

## Scalability Considerations

First remove SQL writes from the high-frequency location path and add freshness validation; 10,000 GPS writes/s plus per-order lookups are a different workload from roughly 116 peak checkouts/s. Discovery currently fetches all matching rows and computes distances in JavaScript, so move bounding/filtering and pagination into an indexed query. Batch candidate metadata reads instead of issuing per-driver queries.

Partition by market when measured database or dispatch contention warrants it. Keep transactional ownership local, and cache public catalog reads independently. Scale socket gateways with shared event routing, subscription authorization, output bounds, and draining connections on deploy. Redis Pub/Sub alone cannot replay missed events; a snapshot recovery contract remains necessary. Kafka topics require deliberate partitioning, retention, replication, stable event IDs, and consumer operations rather than relying on auto-creation defaults.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Checkout receipt | SQL transaction with order/lines/outbox | Redis response cache only | Recover a committed order after cache/process failure |
| Driver exclusivity | SQL claim, geo index for candidates | Independent availability/order writes | Stale candidates cannot authorize double assignment |
| Tracking transport | Durable status, coalesced position | Reliable queue for every GPS sample | Recover business state without replaying stale movement |
| Dispatch policy | One live order per driver initially | Multi-order batching | Establish assignment correctness before route optimization |
| ETA | Stage-aware formula and uncertainty range | Immediate ML pipeline | Explain baseline error before adding training infrastructure |
| Distribution | Market-local authority | Global writable order state | Limit transaction scope and failure propagation |

## Implementation Notes

### Patterns actually connected

- **Cache-aside:** [shared/cache.ts](./backend/src/shared/cache.ts) serves full restaurant/menu entries for five minutes and cuisine lists for ten. Restaurant/menu updates purge relevant detail keys. Nearby/list helper caches are not used by discovery, and cuisine invalidation is missing. Invalidation also uses `KEYS` for patterns; there is no background refresh or request coalescing.
- **Idempotency marker:** [shared/idempotency.ts](./backend/src/shared/idempotency.ts) uses the following admission pattern. It reduces overlapping requests while the marker exists; it does not make the downstream writes atomic or durable.

```typescript
await redisClient.set(fullKey, JSON.stringify({ inProgress: true }), { NX: true, EX: 60 });
```

- **Circuit breaker:** [shared/circuit-breaker.ts](./backend/src/shared/circuit-breaker.ts) wraps matching with a 10 s timeout, 50% error threshold, 30 s reset, and minimum request volume of five. Its fallback returns `queued: true`, but there is no queue insertion or retry worker. The separate payment breaker wraps an unused simulator; it is not part of checkout. A timeout does not cancel the matching function's later SQL writes.
- **Audit/metrics/logging:** [shared/audit.ts](./backend/src/shared/audit.ts), [shared/metrics.ts](./backend/src/shared/metrics.ts), and [shared/logger.ts](./backend/src/shared/logger.ts) record selected order/assignment events. These help diagnose local behavior, but audit writes occur after effects and swallow errors; they are not transactional, append-only, or guaranteed complete. Some modules still log directly to the console.
- **Producer integration:** [shared/kafka.ts](./backend/src/shared/kafka.ts) produces `order-events`, `location-updates`, and `dispatch-events`, keyed by order or driver. Initialization is optional to app readiness. There is no outbox, consumer, notification service, or analytics materialization; WebSocket broadcasts are separate in-process calls.
- **Health/shutdown:** [index.ts](./backend/src/index.ts) registers probes and handles SIGTERM/SIGINT with a 30 s forced-exit timer. It attempts HTTP/dependency shutdown but does not explicitly drain WebSockets, and probes have no application-level deadline. Global authentication runs before probes, so cookies can introduce session dependency work.

### Correctness and integration limits

**Checkout and retry.** [create.ts](./backend/src/routes/orders/create.ts) does not begin a transaction. A failed later line insert leaves an order and earlier lines. It accepts closed restaurants, rejects valid zero-valued coordinates through truthiness checks, and does not enforce positive integer quantities, nonnegative tips, or geofenced delivery. Current-price validation has no quote/revision agreement; floating-point arithmetic is rounded independently for persisted totals. [api.ts](./frontend/src/services/api.ts) mints a fresh checkout key per call. The Redis cache key has no actor/payload binding, and failure responses can be reused across users sharing a key.

**Transition authority.** [status.ts](./backend/src/routes/orders/status.ts) uses the pattern below after an earlier read. No expected status/version is part of its predicate:

```sql
UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1;
```

An unrelated authenticated user can request `DELIVERED → COMPLETED`: the `system` transition has no actor check. Generic delivery does not perform the dedicated endpoint's driver-release/counter work. [drivers.ts](./backend/src/routes/drivers.ts) separately reads then updates pickup/delivery; concurrent deliveries can increment `total_deliveries` twice. Going online sets `is_available` true even with an assigned order, and cancellation does not consistently free a driver. Fee/tip stats include only `DELIVERED` rows, so `COMPLETED` rows disappear from today's totals; these are not payout records.

**Matching.** [driver-matching.ts](./backend/src/routes/orders/driver-matching.ts) assigns the highest score: `100 − 10 × distanceKm + 5 × rating + min(totalDeliveries / 10, 20)`. There are no percentage weights, active-order penalty, earnings goal, batching, or offer timeout. It updates order assignment and driver availability independently, without rechecking order status or taking an exclusive claim.

The installed node-redis 4.7.1 / client 1.6.1 `geoSearch` emits member IDs; its options transformer ignores `WITHDIST`. This caller casts results to `{member, distance}` objects anyway. Nonempty replies therefore produce an invalid driver ID and normally trigger the SQL fallback; an empty reply simply returns no candidates. The distance-returning API is separate (`geoSearchWith`). The [Redis command reference](https://redis.io/docs/latest/commands/geosearch/) describes how `WITHDIST` changes the wire reply, but passing an unsupported JavaScript option does not send it. Independently, limiting to 20 geo members before filtering availability can miss eligible drivers outside that candidate window.

**Location and ETA.** The 300 s hash TTL does not remove members from `driver_locations`; neither matching path rejects old SQL/Redis coordinates. No timestamp/sequence validation prevents an older request overwriting a newer point. GPS completion can still send after the client stops tracking. The fallback scans all active/available SQL drivers. [geo.ts](./backend/src/utils/geo.ts) uses speeds of 25/15/20/5 km/h for car/bike/scooter/walk, weekday rush/lunch multipliers and a weekend multiplier, all based on server-local time. Matching and dedicated pickup omit vehicle type and default to car. Starting preparation resets the prep reference to `preparing_at`; post-pickup ETA still uses the full restaurant-to-customer leg and all five buffer minutes. Location updates and order reads do not refresh ETA. Pickup saves a new estimate after reading its response object, so the nested order may still contain the previous estimate.

**Subscriptions and recovery.** [websocket.ts](./backend/src/websocket.ts) keeps an unauthenticated map of channels to sockets, accepts arbitrary subscriptions, and sends participant details without membership checks. There is no cross-instance bus, replay, per-socket output bound, or server heartbeat. Generic status/pickup/delivery events reach order/customer/restaurant channels, but not the driver-dashboard channel. The browser [useWebSocket hook](./frontend/src/hooks/useWebSocket.ts) depends on array identity while callers pass new arrays each render; cleanup closes a socket whose `onclose` schedules an uncancelled three-second reconnect. This can churn/leak connections across renders and navigation. No reconnect snapshot restores missed orders.

**Frontend state and contracts.** React route components fetch directly into local state; only auth/cart use persisted Zustand stores. `fetchUser` exists but is not called at startup, so cached identity can outlive the session. Cart/address data persists across logout; merely opening another restaurant replaces the cart restaurant and clears items. There is no quote reconciliation or ambiguous-checkout recovery. The owner toggle sends snake_case to a camelCase API; driver stats have the reverse mismatch. The restaurant dashboard ignores the successful transition response and waits for a socket event. Order-detail events can replace a driver-expanded order with a driver-endpoint response that omits that expansion. Fetches have no abort/generation guard, and connection status/data age are absent. There is no map, native background tracker, audio alert workflow, list virtualization, offline command queue, or user-facing menu editor.

### Local substitutions, omissions, and verification

The single Express process hosts all API/dispatch/WebSocket logic. PostgreSQL is unsharded; Valkey serves sessions, caches, and current geo data; Kafka is a single optional producer destination. Vite proxies host port 3000. Running the alternate API ports adds independent socket maps, not a functioning shared gateway tier. There is no CDN, API gateway/rate limiter, replicated event pipeline, payment provider, PostGIS, trained ETA model, durable dispatch worker, native driver app, or operational admin console.

The SQL seed's sample `PREPARING` order uses an incompatible address shape, inconsistent item totals, and a driver still available despite assignment. It is for screenshots, not an integrity fixture. The Playwright smoke file uses an unseeded `alice@example.com` and broad visibility assertions; screenshot configuration uses the correct persona accounts. Backend/frontend builds and a full stack were not run during this documentation review.

Isolated execution of the actual TypeScript modules with mocked SQL/Redis/transport reproduced cached errors across actors, partial order creation at a closed restaurant, unauthorized completion, assignment of cancelled orders, and assigning the same candidate to two orders. The installed Redis argument transformer and seeded bcrypt password were also checked. These are bounded source checks, not throughput measurements or end-to-end validation. See [README.md](./README.md) for runnable setup and the existing demo constraints.
