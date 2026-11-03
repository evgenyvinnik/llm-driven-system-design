# Design APNs (Push Notification Service) — Development with Claude

## Project Context

A push-notification backbone modeled on Apple's APNs: application providers send notifications addressed to a device token, and the service delivers them over a **persistent connection** to the device — or holds them until the device next appears. The hard problems are (1) routing a delivery to whichever server currently holds a device's live connection, in a horizontally-scaled fleet where no single server holds every connection, and (2) doing the right thing when the device is offline: store, deduplicate collapsible pushes, respect priority and expiration, and flush on reconnect.

**Learning goals:** connection-oriented delivery at fan-out scale, store-and-forward semantics, collapse-ID deduplication, priority/battery-aware delivery, and device-token lifecycle (registration → invalidation → feedback).

## Architecture at a Glance (what actually runs)

Two backing services plus a WebSocket layer (`docker-compose.yml` — Postgres, Valkey; **no message broker**):

| Component | Client lib | Role | Why this one |
|-----------|-----------|------|--------------|
| **WebSocket server** (`ws`) | `ws` | The persistent device connection: one `WebSocketServer` per backend instance at `/ws`, keeping a local `deviceId → WebSocket` map | Stands in for APNs's persistent TCP connection — a device holds one long-lived socket and receives pushes without polling |
| **Redis / Valkey** (`valkey/valkey:7-alpine`) | `ioredis` | Connection routing (`deviceId → serverId`), **cross-server pub/sub** delivery channels (`notifications:<serverId>`), priority queue (`enqueue/dequeueNotification`), admin sessions, rate limiting, live stats | The routing + pub/sub fabric that lets a send on server-A reach a device connected to server-B |
| **PostgreSQL 16** (`postgres:16-alpine`) | `pg` | Durable state: `device_tokens` (hashed), `topic_subscriptions`, `pending_notifications` (store-and-forward), `delivery_log`, `feedback_queue`, `notifications` history, `admin_users`, `sessions` (unused), `provider_keys` (public keys only) | Durability for tokens, undelivered payloads, and the audit/delivery record |

Auth has three credentials (`backend/src/shared/auth.ts`): the **admin console** uses a Redis-backed bearer session; **providers** sign ES256 JWTs with a key an admin issued, scoped to app bundle IDs (APNs token-based auth in its simplest form); **devices** authenticate their WebSocket with the raw device token, resolved by hash. Frontend is a React 19 + TanStack Router + Zustand admin dashboard.

## Key Design Decisions

### 1. Connection routing via a Redis `deviceId → serverId` map + per-server pub/sub
When a device connects, its server records `deviceId → serverId` in Redis. To deliver, `pushService` looks up that mapping (`getDeviceServer`); if present, it publishes the push to that server's Redis channel (`notifications:<serverId>`), and the owning server — subscribed to its own channel — writes it to the local socket. **Trade-off given up:** delivery to an online device costs a Redis lookup plus a pub/sub hop rather than a direct write, and a stale mapping (server crashed without cleanup) means a "delivered" publish lands nowhere. That is acceptable because it lets the connection fleet scale horizontally (server1/2/3 route to each other's devices) and the store-and-forward path is the safety net for the stale-mapping case.

### 2. Store-and-forward for offline devices, keyed for collapse
If `getDeviceServer` returns null the device is offline, so the notification is written to `pending_notifications` and a Redis priority queue; on reconnect, `deliverPendingToDevice` flushes them ordered by `priority DESC, created_at ASC`. Collapsible pushes carry a `collapse_id` with a `UNIQUE(device_id, collapse_id)` constraint and an `ON CONFLICT DO UPDATE`, so a phone that was off for an hour wakes to **one** "you have new mail," not fifty. **Trade-off given up:** collapsing discards intermediate states — correct for a badge/counter, wrong for distinct transactional messages — so `collapse_id` is opt-in per notification, and expired entries are swept by `cleanupExpiredNotifications`.

### 3. Priority levels model battery-aware delivery
Notifications carry a priority (10 = immediate, lower = background); pending delivery and the Redis queue both order by priority so urgent pushes jump ahead of background ones. **Trade-off given up:** low-priority notifications can be delayed and batched, which is the point (fewer device wake-ups) but means "background" delivery has no tight latency guarantee.

### 4. Idempotency keys on send
A provider can pass an idempotency key; `checkIdempotency`/`markNotificationProcessed` short-circuit a duplicate send and return the existing notification's status instead of pushing twice. **Trade-off given up:** dedup only holds within the cache TTL window — a retry after the key expires would re-send — which is the right trade for retry storms but not for indefinite replay.

### 5. Feedback service for dead tokens
Deliveries to unregistered/invalid tokens are recorded in `feedback_queue` (with reason) so providers can stop sending to uninstalled apps, mirroring APNs's feedback channel. **Trade-off given up:** it's a pull-based queue the provider must poll, not a push-back — simpler, and matches how the real feedback service historically worked.

## Current State

**Implemented end to end:** device registration with token hashing and dedup; topic subscription and topic fan-out; send-to-device (by raw token or device id) and send-to-topic; live delivery to online devices over WebSocket with cross-server routing via Redis pub/sub; store-and-forward for offline devices with priority ordering, collapse-ID dedup, expiration, and reconnect flush; delivery logging and per-status stats; feedback queue for invalid tokens; idempotent sends; admin dashboard (notification list, stats); Redis rate limiting; Prometheus metrics (`prom-client`) and Pino/pino-http logging. Multi-instance routing works via a per-server `SERVER_ID` and Redis pub/sub, so `dev:server1/2/3` deliver to each other's connected devices.

**Simulated or omitted (documented in `architecture.md` Implementation Notes):** HTTP/2 multiplexed provider API (uses HTTP/1.1 + Express — same semantics, no TLS/cert setup); certificate-based provider auth and sandbox/production environment scoping (token-based JWT auth is implemented); Kafka event bus (Redis pub/sub + priority queue); TLS 1.3; geographic connection sharding; and the real APNs binary/OS integration (devices are simulated WebSocket clients).

## Iteration & Repair Log

- **ESM / connection-fallback pass (repo-wide):** backend runs as ESM under `tsx`; `pino-http` uses its named import and the Postgres/Redis clients fall back to docker-compose defaults (`apns` DB, `redis://localhost:6379`) when env vars are unset.
- **Seed password normalization (repo-wide):** the seeded admin login uses `password123` (bcrypt), matching the README's credentials note — part of the repo-wide password normalization.
- **Doc-vs-code alignment for this pass:** replaced the previous phase-checklist CLAUDE.md, which listed "Monitoring" and "Connection sharding" as unchecked TODOs even though Prometheus metrics are wired and multi-server connection routing works via Redis pub/sub. Those are now recorded as *implemented* rather than pending. The genuinely-unbuilt items (HTTP/2, geographic sharding) are captured under Current State as deliberate omissions.
- **Auth model (2026-11-02).** The repo-wide WebSocket identity audit (PR #23) left apns out because it had no auth model at all, and the old line above claiming "session-based" admin/provider auth was false: only `/admin/me` read the session. Anyone could send `connect` with a victim's `device_id` (listed by the open `GET /admin/devices`), receive and delete that device's pending queue, and repoint its Redis route; `ack` marked any notification delivered; `POST /admin/users` created admins with no session; provider sends and history reads were public. Fixes:
  - **Devices.** `connect` must carry the raw `device_token`. It is resolved through `tokenRegistry.lookup` (hash only, valid tokens only) before the socket gets an identity. A socket that sends no token within 10 s, or a bad one, is closed with code 4401. A second `connect` on the same socket is refused. `markDelivered(id, deviceId)` updates only the socket's own notifications. A newer socket for the same device closes the older one (4409), and the older socket's close no longer deletes the replacement's route.
  - **Admins.** `router.use(requireAdmin)` covers every admin route after login/logout. `/me` reads the same middleware.
  - **Providers.** We chose JWT over certificate simulation because it needs no TLS setup and matches APNs's recommended token auth. The JWT is ES256 rather than HS256 so the server stores only public keys and cannot leak signing material. Admins issue keys through `/admin/provider-keys`, and the private key is returned once. `requireProvider` pins the algorithm, checks `iss` against the key's team, and enforces the APNs one-hour `iat` limit. The key's bundle IDs are checked in `pushService` where the device is resolved, so the scope applies to by-token, by-ID, `/3/device`, and topic sends alike. The same scope covers history reads, feedback, and device-UUID lookups. The console's Send page keeps working because `requireProvider` also accepts an admin session, unscoped.
  - **Supporting changes.** Added `npm run db:migrate` (reapplies the idempotent `init.sql`, for volumes created before `provider_keys`), `provider:token` (mints a JWT from the key JSON), Vitest unit tests (alg-none and HS256 confusion, tampering, expiry, middleware routing), and `verify:auth`, a live script. It passed 27/27 against two instances (sends on one, devices on the other). Replaying the hijack against the old code delivered the victim's queued push to the attacker. A repeat ack no longer throws on the `delivery_log` primary key.
  - **Left alone.** Registration and token-keyed device routes stay open, since possession of the raw token is the credential. Roles remain labels. Invalidation does not close a live socket, and a stale disconnect on another server can still delete the Redis route (see Open Questions).

## Open Questions

1. The `deviceId → serverId` routing map has no liveness check — if a server dies, its mappings linger until overwritten. Should connections carry a Redis TTL heartbeat so a dead server's devices fall back to store-and-forward immediately rather than after a failed publish?
2. Delivery is "publish and assume delivered" once the socket write happens; there's no end-to-end ACK from the device back into `delivery_log` for the online path. Where should a device-ack round-trip go to make delivery truly at-least-once without doubling write load?
3. `sendToTopic` fans out by looping per subscriber and sending individually. At what subscriber count does this need batching / a real broker (the production Kafka path) instead of an in-process loop?
4. Idempotency and collapse both dedup, but at different layers (cache vs. DB constraint). Is there a case where a collapsed-away notification should still count as "delivered" for the provider's status query, and does the current model report that correctly?
5. Invalidating a token stops new sockets but leaves an open one connected. Should invalidation publish a "kick" to the owning server? And should the route delete on close be a compare-and-delete against `SERVER_ID`, so a stale disconnect on server A can't erase a newer route to server B?
6. Idempotency claims (`apns-id`) are global, not per provider key. A provider can't read another app's notification through a duplicate claim (the lookup is bundle-scoped), but one provider can still burn another's ID for 24 h. Should the claim key include the provider key ID?

## Resources

- [APNs / UserNotifications](https://developer.apple.com/documentation/usernotifications) — the provider and payload model this mirrors
- [Firebase Cloud Messaging architecture](https://firebase.google.com/docs/cloud-messaging/concept-options) — the comparable store-and-forward + priority design
- [HTTP/2 (RFC 7540)](https://httpwg.org/specs/rfc7540.html) — the multiplexed provider transport the production design targets
