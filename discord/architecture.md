# Baby Discord architecture

## System Overview

Baby Discord studies a shared text-chat core exposed through raw TCP and browser HTTP/SSE adapters. Its most useful design questions concern the boundary between persistence and delivery, the relationship between history and a live stream, and the difference between a user, a connection, and room membership.

This document distinguishes a **proposed production text-chat system** from the **current local implementation**. Production targets and mechanisms are design proposals, not descriptions of the real Discord service or measured capabilities of this repository. The Database Schema and current API sections describe existing code; the final Implementation Notes trace its behavior and defects.

## Requirements

### Functional requirements — proposed production system

- Authenticate a user independently of a display nickname and authorize channel access.
- Create and join text rooms, send messages, and read paginated history.
- Support terminal and browser adapters without changing domain rules.
- Reconcile retries against stable send identity and return a durable acceptance result.
- Stream newly committed messages with recoverable room-scoped cursors.
- Distinguish pending, accepted, failed, and unknown send outcomes in the browser.
- Support private direct conversations through the same durable message model when enabled.
- Present approximate connection presence separately from durable membership.

The first design focuses on text rooms and message recovery. Guild categories, complex role overrides, bots, search, attachments, reactions, threads, and voice/video are extensions. Voice media would require a separate media/signaling design; it is not carried by SSE or supplied by the local TCP adapter.

### Non-functional requirements — proposed targets

| Concern | Target or contract |
|---------|--------------------|
| Connections | 100,000 concurrent clients across gateway processes |
| Message workload | Approximately 2,300 accepted messages/second at peak |
| Delivery | Regional p95 <200 ms and p99 <500 ms under a bounded healthy fan-out workload |
| History | p95 <500 ms for a bounded recent page |
| Availability | 99.9% command and history service availability |
| Acceptance | Success follows a committed message, receipt, and delivery obligation |
| Ordering | One authoritative committed sequence per room; no global conversation order |
| Recovery | Replay within declared retention, with explicit reset when a cursor is too old |
| Resource limits | Bounded message size, connections, send rate, history pages, and slow-client queues |

Write availability can decrease during loss of the authoritative room owner or database quorum. The service must not trade away the meaning of an accepted message to keep returning successful responses. Delivery latency targets also require limits on room fan-out and output buffers; they are not promises for an arbitrarily large broadcast.

## Capacity Estimation

Assume one million daily users sending twenty messages each: twenty million messages/day, about 231/second on average and roughly 2,300/second at a tenfold peak. At an illustrative 500 bytes per message plus compact metadata, the logical payload is about 10 GB/day or 3.65 TB/year. Indexes, receipts, outbox records, replicas, backups, and storage overhead increase physical requirements.

Suppose a connection consumes 30 KiB of application/kernel/TLS state under a measured configuration. At 100,000 connections that is about 2.9 GiB across the gateway fleet before room subscriptions and queued output. Treat the per-connection figure as a sizing assumption to measure; there is no universal 100K-connections-per-process guarantee.

Fan-out can dominate insertion. A room sending 100 messages/second to 10,000 connected readers generates one million deliveries/second. At 500 bytes each that is about 500 MB/second of payload, before framing and transport overhead. Sharding the message table alone does not solve that egress load.

Use bounded history pages, such as fifty messages, and indexes matching room/sequence access. Retention is a product contract. A ten-message teaching buffer is not sufficient replay storage for a sleeping laptop or a busy-room deployment.

### Local Development Scale

One to three API processes share PostgreSQL and Valkey on one machine. Each process listens on TCP and HTTP ports and holds its own sessions, room cache, membership map, and ten-message buffers. The optional seed creates eight users, four valid rooms, sixteen memberships, forty valid room messages, and thirteen null-room messages caused by stale seed assumptions.

No application load test was run during this documentation audit. The code has correctness defects in remote delivery and browser stream handling before production scaling can be assessed.

## High-Level Architecture

### Proposed production text-chat system

```text
┌────────────────────────┐       ┌──────────────────────────────┐
│ Browser / TCP client   │──────▶│ Protocol gateways            │
└────────────────────────┘       │ Auth / bounded connections   │
                                 └───────────────┬──────────────┘
                                                 │
                                                 ▼
                                 ┌──────────────────────────────┐
                                 │ Room command authority       │
                                 │ Order / permission / retry   │
                                 └───────────────┬──────────────┘
                                                 │
                                                 ▼
                                 ┌──────────────────────────────┐
                                 │ PostgreSQL                   │
                                 │ Messages / receipts / outbox │
                                 └───────────────┬──────────────┘
                                                 │
                                                 ▼
                                 ┌──────────────────────────────┐
                                 │ Outbox publisher             │
                                 │ Fan-out notification bus     │
                                 └───────────────┬──────────────┘
                                                 │
                                                 ▼
                                 ┌──────────────────────────────┐
                                 │ Gateway delivery + replay    │
                                 │ Read committed room log      │
                                 └──────────────────────────────┘
```

The gateway owns sockets and stream framing; the room authority owns accepted order and permission decisions. PostgreSQL is the initial durable source for configuration and messages. The outbox couples a committed message to an obligation to notify delivery gateways. The notification bus accelerates delivery, while ordered durable history is the source for catch-up.

A CDN serves browser assets. Shared session validation allows requests to reach different gateways, but socket state still lives on the gateway holding the connection. Presence uses per-connection leases and derives whether any authorized connection remains live. These supporting responsibilities are separate from durable room membership.

At larger measured storage volume, route rooms to independently owned database partitions or introduce a dedicated append store. Preserve the acceptance/receipt/order boundary during that change. A wide-column database or durable broker is an option with explicit partition and recovery costs, not an automatic performance multiplier.

## Core Components / Request Flows

### Accept and deliver a message

1. The client creates a stable operation ID and retains the message draft or pending item.
2. An adapter validates framing and bounded payload, then passes authenticated user, explicit room ID, content, and operation ID to the domain layer.
3. The room authority checks current send permission and serializes acceptance for that room.
4. One transaction writes the message, increments a transactional room sequence, stores the operation receipt/digest, and adds an outbox record.
5. Commit establishes acceptance. The response returns the same message ID/sequence on retry of the same operation and payload.
6. The outbox publisher emits an identifiable notification; gateways fetch and distribute committed room events in sequence.
7. Clients merge acknowledgement and stream delivery by stable identity, preserving pending/unknown states until resolved.

If the connection fails during commit, retry or query the same operation identity. Do not create a new ID merely because the result is unknown. A changed payload under an existing ID is a conflict. Receipt retention must cover supported client retry and replay windows.

The room sequence is allocated within the serialized transaction, not inferred from wall-clock timestamps or a global PostgreSQL sequence. A unique ID identifies a message; it does not establish that all earlier messages have committed. Independent room ordering avoids a global serialization bottleneck.

### Join history to the live stream

The history API returns a bounded recent page and an authoritative room high-water mark. The mark describes the synchronization boundary, not a claim that the client downloaded every earlier message. Older history remains separately pageable.

The stream endpoint accepts an authorized room cursor. It establishes notification coverage, captures the committed head, replays the retained interval after the cursor, then continues reading newly committed events. Gateways use notifications as wakeups and perform bounded catch-up checks so a missed notification cannot permanently conceal a committed event. Shared per-room work avoids one database poll per socket.

Clients deduplicate overlap, validate sequence continuity, and advance their application cursor only after accepting valid events. A cursor older than retained replay data triggers an explicit reset and fresh snapshot. A new EventSource can pass an initial cursor through the API's URL contract; native EventSource does not accept arbitrary request headers. Its automatic `Last-Event-ID` behavior belongs to reconnection of an existing stream and does not implement server replay. [HTML SSE standard](https://html.spec.whatwg.org/multipage/server-sent-events.html)

History-first without replay has a gap. Stream-first buffering can also work, but only after server subscription is established, with stable identities, bounded buffering, and an authoritative history boundary. Simply constructing an EventSource before fetching history does not prove that the server is already delivering events.

### Separate user, session, subscription, and membership

A durable user can have several device sessions; each session can have one or more gateway connections. A subscription identifies the room and connection generation receiving events. Durable room membership expresses permission, while presence is an approximate claim that a connection lease remains valid.

Closing one tab removes that connection and its subscriptions, not another device's membership. Permission revocation invalidates or rejects further reads/sends even if the gateway has cached metadata. A session identifier must not become a substitute for authenticating the claimed nickname.

For direct messages, use a conversation record and authorized participants with the same durable send/replay semantics. The current direct-message command instead searches only local sessions and sends an unpersisted string.

### Browser interaction

The route selects an explicit room context; a coordinator owns session validation, join generation, stream lifetime, history merge, and pending sends. Store ownership alone does not serialize async operations. Every completion checks its session/room generation before updating visible state.

The composer retains failed or unknown sends and exposes retry using the same operation ID. Acknowledgement can arrive before or after the stream echo; both update one identified item. A route change cannot redirect an already-submitted message to a different room because the send request carries its intended room explicitly.

Keep one normalized event contract across history, live streams, and acknowledgement. Runtime validation distinguishes an incompatible event from a system notification. Render a bounded timeline, preserve the scroll anchor when reading older messages, and provide a jump-to-latest action rather than always pulling the reader to the bottom.

## Database Schema

### Current local schema

The following is [backend/src/db/init.sql](./backend/src/db/init.sql), reproduced exactly. It contains four tables and a cleanup function. There are no account credentials, roles, session rows, message receipts, room sequences, outbox records, or DM tables.

```sql
-- Baby Discord Database Schema
-- This file is executed on database initialization

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    nickname VARCHAR(50) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Rooms table
CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Room membership (many-to-many)
CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for efficient message retrieval by room and time
CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at DESC);

-- Index for user nickname lookup
CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);

-- Index for room name lookup
CREATE INDEX IF NOT EXISTS idx_rooms_name ON rooms(name);

-- Function to cleanup old messages (keep only last 10 per room)
CREATE OR REPLACE FUNCTION cleanup_old_messages() RETURNS void AS $$
BEGIN
    DELETE FROM messages m
    WHERE m.id NOT IN (
        SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at DESC) as rn
            FROM messages
        ) ranked
        WHERE rn <= 10
    );
END;
$$ LANGUAGE plpgsql;

-- Seed data is in db-seed/seed.sql
```

Message room/user foreign keys and timestamps are nullable; content is required but has no application-aligned size constraint. Room/user names are unique, with redundant explicit indexes in addition to the unique indexes. Recent reads and retention order only by timestamp, without a deterministic ID tie-breaker.

### Proposed production additions

| Record / constraint | Purpose |
|---------------------|---------|
| Authenticated users and revocable sessions | Separate identity from a claimed display name |
| Room policy and durable membership | Authorize reads, subscriptions, and sends |
| Transactional room head with ownership generation | Establish committed order and reject obsolete owners |
| Message ID and unique room sequence | Stable identity and ordered history |
| Scoped operation receipt and payload digest | Resolve duplicate/unknown send outcomes |
| Outbox event and delivery state | Repair the commit-to-notification gap |
| Connection/subscription generations and leases | Isolate reconnects and approximate presence |
| Replay-retention bounds | Explain when catch-up requires a reset |

The local `SERIAL` message ID is stable in the database but is lost in the actual plain-text live route. It is also global across rooms, so adjacent room messages need not have consecutive IDs. It cannot be used as a contiguous per-room gap detector without a different cursor contract.

## API Design

### Current HTTP routes

The actual prefix is `/api`, not `/api/v10` or `/api/v1`. Session-bearing operations use a JSON body field, query parameter, or path parameter rather than a cookie. Validation is hand-written; frontend/backend TypeScript declarations are separate and do not validate network payloads.

| Method | Path | Current behavior |
|--------|------|------------------|
| POST | `/api/connect` | Claim/create nickname, return process-local UUID session; no password |
| POST | `/api/disconnect` | Remove local session/membership and close its tracked SSE responses |
| GET | `/api/session/:sessionId` | Return local session metadata; browser helper exists but is unused |
| POST | `/api/command` | Parse slash command or ordinary text; command failures may still use HTTP 200 |
| POST | `/api/message` | Require current room, then call the same parser; also accepts slash commands |
| GET | `/api/rooms` | Public room list with PostgreSQL membership counts |
| GET | `/api/rooms/:room/history` | Public normalized history from this process's buffer; no pagination/fallback |
| GET | `/api/messages/:room?sessionId=...` | SSE; validates session existence but not requested room/membership |
| GET | `/api/storage` | Public room counts and physical message-table size |
| GET | `/api/health` | Database boolean and local session count; always HTTP 200 |
| GET | `/health` | Intended detailed dependency status, with incomplete Redis/read-failure handling |
| GET | `/metrics` | Prometheus exposition and selected current counters/gauges |

Normal API results use `success`, optional `message`, `data`, and `error`. `/connect` returns session ID, user ID, and nickname but not the `currentRoom` field required by the frontend Session declaration. A successful ordinary send returns the persisted `messageId`; the current browser ignores that result.

The live SSE path writes one `data:` line containing the router's plain-text message. It does not send structured message JSON or an SSE event ID. History adds `user` and `timestamp` while retaining persistence fields such as `id`, `roomId`, `nickname`, and `createdAt`; it does not fully normalize room/identity fields into one wire schema.

For production, use explicit room IDs in sends, stable operation identity, structured errors, versioned events, authorized cursors, bounded history pages, and complete message envelopes. A command adapter can remain as a convenience, but its effects must be reflected in browser state rather than inferred from unstructured text.

## Key Design Decisions

### Commit before acknowledgement versus best-effort buffering

For durable chat, acknowledge a transaction containing the message and its receipt/outbox obligation. The extra write coordination is justified because an accepted line should survive a gateway crash and a retry should resolve to the same line. An in-memory buffer cannot provide that contract, and enabling persistence on an unrelated cache does not close the application transaction gap.

The local implementation already awaits the message insert. Its remaining gaps are retry identity, concurrent room-state changes, and non-transactional fire-and-forget fan-out. Describing it as asynchronous persistence after delivery identifies the wrong failure boundary.

### SSE plus POST versus WebSocket

SSE suits server-to-browser event delivery while ordinary commands use HTTP requests. It has browser-managed reconnection, but still needs authorization, replay, framing, bounded queues, and visible failure state. WebSocket is also a valid text-chat choice when bidirectional event traffic or multiplexing warrants a unified protocol; it is not inherently limited to voice/binary media or universally faster.

Both transports can deliver promptly under healthy conditions. Polling adds delay according to its interval and scales request work with active readers. The choice should follow message direction, connection/proxy constraints, and recovery requirements rather than an invented fixed latency advantage.

### Notification bus versus authoritative replay log

Redis Pub/Sub is an at-most-once notification mechanism: a disconnected or failing subscriber cannot ask it for missed events. Its simplicity works for best-effort wakeups when durable history supplies catch-up. [Redis Pub/Sub delivery semantics](https://redis.io/docs/latest/develop/pubsub/)

A durable event broker can extend replay and decouple consumers at higher scale, at the cost of partition management, retention, checkpoints, and consumer recovery. A consumer group divides work among members; it does not automatically broadcast every event to every gateway that needs it. Delivery routing must account for all interested gateway processes.

### Shared room state versus independent local maps

Local maps are fast and easy to inspect, but their contents are not an authoritative cross-instance membership or history view. Session affinity can keep a teaching client on one instance; it does not provide failover or replay. The production design separates shared durable records from per-connection state and uses versions/cursors to recover local projections.

## Consistency and Idempotency

Room-scoped serialization orders accepted messages and validates permission at the write boundary. Permission changes use the same authority/serialization boundary, or an equivalent revision check that rejects acceptance under a revoked policy. The message, receipt, head update, and outbox commit together. Concurrent retry handling must be atomic; a Redis check followed by an insert and later cache write leaves a duplicate race and a crash gap.

An ID containing time is not a proof of commit order or permission consistency. For a database sequence, allocation can occur before another transaction commits; gaps and reordering must be handled according to the cursor model. Use the explicit transactional room head for the proposed contiguous committed sequence.

Gateway delivery is repeatable and may overlap across reconnect/replay. The browser deduplicates by message identity and advances only a validated application cursor. Transport-level receipt, durable acceptance, delivery to a device, and human reading are separate states; none should be inferred from the others.

Retention bounds replay. Cleanup must preserve the advertised replay window or explicitly invalidate old cursors. A fresh snapshot cannot honestly imply that discarded older messages were delivered. Browser history retention and server storage retention require separate bounds.

## Security / Auth

The production system authenticates accounts and authorizes room operations at every adapter. A TCP client can bypass browser-only validation, so size, rate, content framing, and permissions belong in shared server policy. Durable membership is not inferred from a socket map or a UI route.

Session credentials need appropriate transport protection and revocation. Stream subscriptions bind session, authorized room, and connection generation. Logs avoid raw credentials/message bodies unless a deliberate diagnostic policy requires them. Rich content, if later added, needs a separate rendering and attachment authorization boundary.

Locally, nickname claiming is unauthenticated and multiple sessions can claim the same stored user. `/nick` can alter that shared user without updating every session. Public room/history/storage reads and unrestricted room joins have no role or privacy model. The HTTP adapter enables permissive CORS, logs request bodies at debug level, and performs incomplete input-type checks. It supplies neither TLS nor a shared rate limiter.

## Observability

Production evidence should distinguish accepted messages, outbox lag, notification failure, replay lag, sequence gaps, pending sends, and slow-client queue size. Measure latency from accepted commit to delivered event at a representative client rather than equating a fast publish call with end-to-end delivery.

The local [metrics module](./backend/src/shared/metrics.ts) defines more metrics than the source updates. Active/total connections, TCP errors, command counts on `/api/command`, room-list counts, history-route hit/miss counters, cleanup outcomes, startup Pub/Sub status/subscription count, and default process metrics have callers. Message send/receive counters, delivery latency, Pub/Sub latency, query latency/errors, pool gauges, membership gauges, and history-buffer size are defined without active instrumentation paths.

The HTTP connection gauge is incremented/decremented for sessions, then overwritten with tracked SSE response count during scraping, so it mixes meanings. TCP `/quit` and subsequent close can decrement twice. History hits count any existing room, even an empty/stale buffer; misses count nonexistent rooms rather than actual cache misses.

Pino creates subsystem/request loggers, but the request logger is used only for an incoming debug record. Its request ID is not carried into core/database/fan-out logs. Debug request bodies can include session IDs and message text. Threshold helpers/configuration exist without an alerting loop.

`/health` checks database connectivity and whether Redis client objects exist. It then awaits a room-list query without its own catch; a database failure can reject the Express 4 async handler and reach the global unhandled-rejection shutdown path. `/api/health` is a simpler database-body status with HTTP 200. No distinct dependency-free liveness endpoint or reliable readiness barrier is implemented.

## Failure Handling

| Failure | Proposed behavior | Current local behavior |
|---------|-------------------|------------------------|
| Insert fails | Reject or resolve unknown outcome by operation identity | Insert error propagates; no buffer append before success |
| Commit succeeds, response lost | Retry returns original identified message | Retrying inserts another message |
| Publish fails after commit | Outbox retains notification obligation | Promise is not awaited/caught by the router; global rejection handling may shut down the process |
| Remote JSON message arrives | Validate/normalize event, then deliver and advance projection | String timestamp causes Date-method failure; callback catches and drops it |
| New room appears | Establish interested gateway subscriptions | Startup-only subscriptions omit new rooms |
| Stream closes/reconnects | Validate session and replay after cursor | No replay; process-local session may be invalid after restart |
| Old stream closes after replacement | Remove only the matching connection generation | Old close handler can delete the replacement map entry |
| One device leaves | Remove its subscription, retain other device state | User-level membership deletion can conflict with other sessions |
| Slow consumer | Bound output, pause or disconnect with resumable cursor | TCP/SSE write backpressure is ignored |
| History expires | Return explicit retention/reset boundary | Database cleanup and in-memory/client history can disagree |

## Scalability Considerations

Bound message length, TCP partial-line buffers, session lifetime, room count, history pages, output queues, and request concurrency before adding processes. The router currently scans all sessions to find a room; maintain indexed subscription sets when measurements justify it. Share room catch-up work across local readers instead of querying once per connection.

Apply backpressure at each adapter. Node's socket write return value indicates when data is queued and a later drain event can resume writing; ignoring it allows user-memory queues to grow. A successful write call also does not prove peer application receipt. [Node socket write behavior](https://nodejs.org/api/net.html#socketwritedata-encoding-callback)

Partition room authority when one database or owner reaches measured limits. A hot room remains a serialization and fan-out hotspot even after distributing other rooms. Split delivery work, bound audience subscriptions, and measure egress independently of insert throughput. Remote regions can subscribe to a home room authority; simultaneous independent writers require a different conflict/order contract.

Presence is deliberately approximate and should use per-session leases. One live device must not refresh a stale device's connection record indefinitely. Large membership lists need bounded pages and visible-member presence subscriptions rather than broadcasting every status change to every member.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Shared behavior | Transport-independent commands/events | Domain code formatting sockets directly | Consistent policy across browser and TCP |
| Acceptance | Committed message + receipt + outbox | Unidentified best-effort buffering | Resolve retries and preserve accepted history |
| Ordering | Transactional room sequence | Wall-clock/global ID ordering | Explicit committed order with independent rooms |
| Browser transport | SSE + POST for initial scope | WebSocket | Fits directional events while retaining explicit recovery |
| Fan-out | Notifications backed by durable catch-up | Pub/Sub as the only history | Recover subscriber gaps |
| Browser send state | Identified pending/accepted/unknown | Clear input and ignore result | Preserve user work through ambiguous outcomes |
| Membership | Durable policy plus connection leases | One shared user/room online flag | Support multiple devices and disconnect recovery |
| Storage scale | Measure, then partition ownership | Fixed vendor throughput assumptions | Match limits to the actual access pattern |

## Implementation Notes

### Startup, configuration, and seeds

[Compose](./docker-compose.yml) runs PostgreSQL 16 and Valkey 7.2. Each [API process](./backend/src/index.ts) starts both TCP and HTTP listeners, checks PostgreSQL, loads every room's recent history sequentially, attempts Pub/Sub setup, and starts cleanup. Instance scripts correctly supply distinct IDs and port pairs; default `dev` sets an unused `PORT` while actual listeners read `TCP_PORT`/`HTTP_PORT`.

The entry point calls `dotenv.config()` in its module body after static dependencies initialize [configuration](./backend/src/shared/config.ts), pool, logger, and singleton instance IDs. `.env` overrides therefore arrive too late for those fields. Redis connection setup reads its URL later. The README uses shell exports before Node starts to make overrides consistent. Backend ESM compilation emits the documented `dist/index.js`; there is no migration/seed/type-check script.

The consolidated schema creates no default `system` user or `general` room. The seed assumes both: on a fresh schema it creates eight users, four valid rooms, sixteen memberships, forty valid room messages, and thirteen null-room messages. Help/announcements creation selects the absent system user and inserts no room. Message inserts have no idempotency conflict target. `/api/storage` sums counts from real rooms, so its `totalMessages` excludes null-room rows even though they occupy the message table. Startup history reads only the four real rooms; the initial count cleanup normally removes the three oldest null-room messages.

### Message persistence and mutable room context

[HistoryBuffer](./backend/src/core/history-buffer.ts) is a Map of arrays capped at a hard-coded ten, not a circular-index ring or asynchronous write queue. Its decisive ordering is:

```typescript
const savedMessage = await dbOps.saveMessage(roomId, userId, content);
const message: Message = { ...savedMessage, nickname, roomName };
buffer.push(message);
```

The isolated actual-module check observed an empty buffer while the mocked insert was pending, then one entry after success; a rejected insert added no entry. The buffer is loaded from PostgreSQL at startup and updated only by local sends. Remote events never append it; reads do not fetch missing/stale entries from the database. Array order follows completion order, not an authoritative per-room committed sequence.

[ChatHandler](./backend/src/core/chat-handler.ts) reads a mutable Session across several awaits. Concurrent join/leave/send requests are not serialized, and the destination name can change between room lookup, history insertion, and broadcast. The resulting buffer/event context can differ from the persisted room ID. `/join` may leave the old room before the new database membership succeeds. Session room, database membership, cache, and event publication are separate operations without rollback.

The command dispatcher's try/catch returns promises without awaiting them, so asynchronous rejections from handlers are not converted by that catch into a CommandResult. HTTP routes catch those rejections; TCP data/close callbacks do not await or catch them at their event boundary, allowing the global unhandled-rejection handler to initiate shutdown.

### Fan-out and wire representation

[MessageRouter](./backend/src/core/message-router.ts) calls `sendToRoom` locally and starts an asynchronous Pub/Sub callback without awaiting or catching it. The insert is already complete. There is no outbox, retry receipt, subscriber acknowledgement, or recovery checkpoint. Self-origin filtering requires distinct instance IDs.

The actual local formatter returns `[room] nickname: content`; its computed time is unused. [SSEHandler](./backend/src/adapters/http/sse-handler.ts) writes that string directly after one `data:` prefix. Multiline content is not correctly SSE-framed, and the structured JSON broadcaster/formatter have no callers on the send path. The browser parses the line as JSON, catches the failure, and creates a system message using browser receipt time. Live IDs and original timestamp are lost.

[PubSubManager](./backend/src/utils/pubsub.ts) JSON-decodes remote messages without reviving Date values. The router then invokes `timestamp.toLocaleTimeString` before iterating recipients, throwing on the decoded string. The Pub/Sub callback catches the exception as a parse failure and drops delivery. The isolated actual-module check reproduced this failure and the browser system-message fallback.

Only chat-type remote events are handled; published system join/leave/nickname events are ignored. Subscriptions are created for every database room at startup and are not added on later room creation/join or removed on last leave. Pub/Sub `connect()` constructs clients without awaiting readiness, and `isConnected()` checks non-null objects. Default library reconnect behavior is not replay or proof of successful application resubscription/processing.

### Session and SSE lifecycle

[ConnectionManager](./backend/src/core/connection-manager.ts) owns process-local sessions with no expiry/idle reaper for HTTP. Initial HTTP sessions have a no-op sender until SSE attaches. Closing an SSE response removes only its response-map entry; session and database membership remain. Multiple sessions may use the same nickname/user, and leaving through one can delete the user's shared room-membership row while another session remains connected.

SSE attachment validates only session existence. It accepts a requested room without checking existence or correspondence to `session.currentRoom`, then replaces the session sender. Delivery fans to every tracked SSE response for that session, regardless of each response's room path. Opening the same session/room twice overwrites one map key without closing the old response; its later close callback deletes the replacement entry. Isolated response mocks confirmed both behaviors.

Streams send heartbeat comments every thirty seconds but no event ID, replay, acknowledgement, or session revalidation. Heartbeats do not expire stale sessions. There is no output-buffer policy; write return values are ignored. `/api/command` handles `/quit` after responding but does not close its SSE responses. `/api/message`, used by the composer, does not act on the disconnect result at all.

### TCP framing and direct messages

[TCPServer](./backend/src/adapters/tcp-server.ts) buffers newline-separated text, sets keepalive, and closes a connection after five minutes of socket inactivity. Individual data callbacks await lines sequentially, but separate callbacks can overlap while awaiting database work. There is no per-session command queue, line-size bound, backpressure handling, or incremental UTF-8 decoder across Buffer chunks. A nickname request overlapping another data event can also race session creation.

Commands are case-insensitive; unknown slash commands become chat text. Creation enforces lowercase room characters, while nickname changes check length only. Direct messages search online users through local session maps, are not persisted/published, and do not provide offline delivery. `/list` also shows local sessions, not a distributed online membership list.

### Browser behavior and recovery

The React routes have valid parent outlets and a single persisted Zustand store. Only the session object is saved in localStorage, and guards check its presence without calling the existing `getSession` helper. Reload after API restart can therefore retain an invalid session while redirecting away from login. There is no central 401 recovery or shared authenticated session store on the backend.

[chatStore.ts](./frontend/src/stores/chatStore.ts) closes the known stream, sends `/join`, fetches history, then opens SSE. It has neither replay nor stream/history generation checks. Concurrent route effects can issue duplicate joins, leave loading state stuck on exceptions, overwrite a newer room with an old history response, or create orphan streams. Event callbacks append to whichever message array is current without checking room/session identity. Navigating Home does not leave the server room or close its stream.

[MessageInput](./frontend/src/components/MessageInput.tsx) clears text before awaiting the request. Both ordinary text and slash commands use `/api/message`; returned success/error/data are discarded. There is no pending-send identity, retry UI, offline draft queue, or explicit IME submission guard. A command can change nickname/room server-side while UI/session state stays stale. Room creation normalizes spaces and navigates even when a command result is unsuccessful.

[MessageList](./frontend/src/components/MessageList.tsx) renders all accumulated messages, keys history by array index because it only checks `messageId`, and scrolls to the bottom on every update. The array grows without a client bound. There is no older-history pagination, virtualization, scoped message error boundary, or stale/reconnecting indicator. Author field access can still throw on incompatible payloads; the partial history normalization fixed one earlier field mismatch, not all contract drift.

The server/sidebar icons are rooms, not guilds. Room polling occurs every thirty seconds and failures are silently retained; database membership counts are returned as PostgreSQL count strings despite the frontend number type. The user panel always says Online. Attachment/emoji/member controls are placeholders, the composer is single-line, and the fixed sidebars have no narrow-screen reflow.

### Retention, shutdown, and verification limits

[Cleanup](./backend/src/utils/cleanup.ts) runs immediately and every five minutes by default, with process-local overlap protection. Each instance scans the shared messages table independently. Count cleanup precedes optional age cleanup in separate statements; timestamp ties have no ID tie-breaker. Neither operation updates existing history buffers. Archive settings are unused. The schema's fixed-ten cleanup function exists but the scheduled path uses its own configurable SQL.

Shutdown marks adapters draining, sends warnings, waits on timers, then closes Redis and PostgreSQL. TCP commands from existing clients remain accepted during its grace period; forced disconnect work is started without awaiting it. HTTP waits up to five seconds before closing tracked SSE responses, then waits for server close without an overall hard deadline. Untracked overwritten SSE responses can prevent that close from completing. Cleanup interval cancellation does not await a running cleanup, and there is no tracked set of in-flight publishes/commands to flush. This is not a proven zero-loss drain.

The audit read all five documents, source, schema/seed, environment/configuration, 28 mocked HTTP tests, six smoke tests, and screenshot configuration. Isolated checks used transpiled actual modules with mocked database/logger/response/stream dependencies; they verified persistence ordering, remote timestamp failure, live plain-text fallback, and SSE replacement behavior. No database/Redis service, browser application, existing test suite, build, or load test was run. Smoke tests contain a nonexistent password input and stale room/main selectors; mocked route tests do not exercise core routing or real Pub/Sub.
